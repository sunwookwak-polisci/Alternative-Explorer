import { Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import {
	bookmarkPathsFingerprint,
	getBookmarkedFilePaths,
	getBookmarksPluginInstance,
	subscribeBookmarksChange,
	toggleFileBookmark,
} from "./bookmarks";
import {
	AlternativeExplorerSettings,
	ExplorerPane,
	FolderSection,
	FolderSortBy,
	FolderSortDir,
	FolderSortRule,
	NoteGroupBy,
	NoteSortBy,
	NoteSortDir,
	NoteSortRule,
	SmartFolder,
	VIEW_TYPE_ALTERNATIVE_EXPLORER,
	createDefaultSettings,
	isSmartFolderScope,
	smartFolderScopeId,
	toSmartFolderScope,
} from "./constants";
import { replacePathPrefix } from "./folder-order";
import {
	findSectionIdForFolder,
	remapFolderSections,
	removeFolderFromSections,
} from "./folder-sections";
import {
	pruneMissingSmartParents,
	remapSmartFolderParents,
	toSmartItemKey,
} from "./folder-items";
import { parseSmartFolder } from "./smart-folders";
import {
	pruneMissingOverrideKeys,
	remapSortOverrideKeys,
} from "./sort-overrides";
import { AlternativeExplorerSettingTab } from "./settings-tab";
import { AlternativeExplorerView } from "./view";

const BOOKMARK_POLL_MS = 750;

export default class AlternativeExplorerPlugin extends Plugin {
	settings!: AlternativeExplorerSettings;
	private refreshTimeout: number | null = null;
	private saveQueue: Promise<void> = Promise.resolve();
	private lastBookmarkFingerprint: string | null = null;
	private unsubscribeBookmarks: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_ALTERNATIVE_EXPLORER,
			(leaf) => new AlternativeExplorerView(leaf, this)
		);

		this.addRibbonIcon("panels-top-left", "Open Alternative Explorer", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-explorer-view",
			name: "Open explorer view",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "toggle-pin-active-note",
			name: "Pin or unpin current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const instance = getBookmarksPluginInstance(this.app);
				if (!(file instanceof TFile) || !instance || !Array.isArray(instance.items)) {
					return false;
				}
				if (!checking) {
					const result = toggleFileBookmark(this.app, file.path);
					if (result === null) {
						new Notice("Enable the core Bookmarks plugin to pin notes.");
					} else {
						this.lastBookmarkFingerprint = bookmarkPathsFingerprint(
							getBookmarkedFilePaths(this.app)
						);
						this.scheduleRefresh();
					}
				}
				return true;
			},
		});

		this.addSettingTab(new AlternativeExplorerSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.registerVaultListeners();
			this.registerBookmarksRefresh();
		});
	}

	onunload(): void {
		if (this.refreshTimeout !== null) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.unsubscribeBookmarks?.();
		this.unsubscribeBookmarks = null;
	}

	async loadSettings(): Promise<void> {
		const rootPath = this.app.vault.getRoot().path;
		const defaults = createDefaultSettings(rootPath);
		const saved = (await this.loadData()) as Partial<AlternativeExplorerSettings> | null;

		this.settings = {
			currentFolder:
				typeof saved?.currentFolder === "string"
					? saved.currentFolder
					: defaults.currentFolder,
			pane: this.parsePane(saved?.pane),
			notesScope: this.parseNotesScope(saved?.notesScope),
			recursive: typeof saved?.recursive === "boolean" ? saved.recursive : defaults.recursive,
			expandedFolders: this.parseExpandedFolders(saved?.expandedFolders),
			folderOrder: this.parseFolderOrder(saved?.folderOrder),
			folderSections: this.parseFolderSections(saved?.folderSections),
			collapsedSectionIds: this.parseExpandedFolders(saved?.collapsedSectionIds),
			folderSortBy: this.parseFolderSortBy(saved?.folderSortBy),
			folderSortDir: this.parseFolderSortDir(saved?.folderSortDir),
			folderSortOverrides: this.parseFolderSortOverrides(saved?.folderSortOverrides),
			smartFolders: this.parseSmartFolders(saved?.smartFolders),
			sortBy: this.parseSortBy(saved?.sortBy),
			sortDir: this.parseSortDir(saved?.sortDir),
			noteSortOverrides: this.parseNoteSortOverrides(saved?.noteSortOverrides),
			groupBy: this.parseGroupBy(saved?.groupBy),
			groupPinned:
				typeof saved?.groupPinned === "boolean" ? saved.groupPinned : defaults.groupPinned,
			notesSubfoldersCollapsed:
				typeof saved?.notesSubfoldersCollapsed === "boolean"
					? saved.notesSubfoldersCollapsed
					: defaults.notesSubfoldersCollapsed,
		};
		this.ensureCurrentFolderExists();
		this.ensureNotesScopeExists();
		this.pruneExpandedFolders();
		this.pruneSmartFolderParents();
		// Do not prune section membership against root.children here: the vault
		// tree may still be incomplete on load, and wiping membership would be
		// persisted on the next save. Display filtering handles missing paths.
		this.ensureSmartFolderPlacement();
		this.pruneCollapsedSections();
		this.pruneSortOverrides();
	}

	async saveSettings(): Promise<void> {
		// Serialize writes so overlapping saves cannot finish out of order and
		// persist a stale in-memory settings object.
		this.saveQueue = this.saveQueue.then(() => this.saveData(this.settings)).catch(() => {
			// Keep the queue alive after a failed write so later saves still run.
		});
		await this.saveQueue;
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ALTERNATIVE_EXPLORER)) {
			if (leaf.view instanceof AlternativeExplorerView) {
				leaf.view.render();
			}
		}
	}

	scheduleRefresh(): void {
		if (this.refreshTimeout !== null) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refreshTimeout = null;
			this.refreshViews();
		}, 150);
	}

	private registerVaultListeners(): void {
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.handleVaultDelete(file);
			})
		);
		this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFolder) {
					void this.remapFolderPath(oldPath, file.path);
				}
				this.scheduleRefresh();
			})
		);
	}

	private registerBookmarksRefresh(): void {
		this.unsubscribeBookmarks?.();
		this.unsubscribeBookmarks = subscribeBookmarksChange(this.app, () => {
			this.lastBookmarkFingerprint = bookmarkPathsFingerprint(
				getBookmarkedFilePaths(this.app)
			);
			this.scheduleRefresh();
		});
		if (this.unsubscribeBookmarks) {
			this.register(() => {
				this.unsubscribeBookmarks?.();
				this.unsubscribeBookmarks = null;
			});
		}

		this.lastBookmarkFingerprint = bookmarkPathsFingerprint(getBookmarkedFilePaths(this.app));
		this.registerInterval(
			window.setInterval(() => {
				if (
					this.app.workspace.getLeavesOfType(VIEW_TYPE_ALTERNATIVE_EXPLORER).length === 0
				) {
					return;
				}
				const next = bookmarkPathsFingerprint(getBookmarkedFilePaths(this.app));
				if (next === this.lastBookmarkFingerprint) {
					return;
				}
				this.lastBookmarkFingerprint = next;
				this.scheduleRefresh();
			}, BOOKMARK_POLL_MS)
		);
	}

	private handleVaultDelete(file: TAbstractFile): void {
		let dirty = this.ensureCurrentFolderExists();
		if (this.ensureNotesScopeExists()) dirty = true;
		const beforeExpanded = this.settings.expandedFolders.length;
		this.pruneExpandedFolders();
		if (this.settings.expandedFolders.length !== beforeExpanded) dirty = true;
		if (this.pruneSmartFolderParents()) dirty = true;

		if (file instanceof TFolder) {
			const beforeSections = JSON.stringify(this.settings.folderSections);
			this.settings.folderSections = removeFolderFromSections(
				this.settings.folderSections,
				file.path
			);
			this.pruneCollapsedSections();
			if (JSON.stringify(this.settings.folderSections) !== beforeSections) {
				dirty = true;
			}
		}

		if (this.pruneSortOverrides()) dirty = true;
		if (this.ensureSmartFolderPlacement()) dirty = true;
		if (dirty) {
			void this.saveSettings();
		}
		this.scheduleRefresh();
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ALTERNATIVE_EXPLORER)[0];
		let leaf: WorkspaceLeaf;

		if (existingLeaf) {
			leaf = existingLeaf;
		} else {
			leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_ALTERNATIVE_EXPLORER, active: true });
		}

		await this.app.workspace.revealLeaf(leaf);
	}

	private ensureCurrentFolderExists(): boolean {
		const folder = this.app.vault.getAbstractFileByPath(this.settings.currentFolder);
		if (!(folder instanceof TFolder)) {
			this.settings.currentFolder = this.app.vault.getRoot().path;
			return true;
		}
		return false;
	}

	private ensureNotesScopeExists(): boolean {
		const scope = this.settings.notesScope;
		if (scope === "all") return false;
		if (isSmartFolderScope(scope)) {
			const id = smartFolderScopeId(scope);
			const exists =
				id !== null && this.settings.smartFolders.some((folder) => folder.id === id);
			if (!exists) {
				this.settings.notesScope = "all";
				return true;
			}
			return false;
		}
		const folder = this.app.vault.getAbstractFileByPath(scope);
		if (!(folder instanceof TFolder)) {
			this.settings.notesScope = "all";
			return true;
		}
		return false;
	}

	private async remapFolderPath(oldPath: string, newPath: string): Promise<void> {
		this.settings.currentFolder = replacePathPrefix(
			this.settings.currentFolder,
			oldPath,
			newPath
		);
		if (this.settings.notesScope !== "all" && !isSmartFolderScope(this.settings.notesScope)) {
			this.settings.notesScope = replacePathPrefix(this.settings.notesScope, oldPath, newPath);
		}
		this.settings.expandedFolders = this.settings.expandedFolders.map((path) =>
			replacePathPrefix(path, oldPath, newPath)
		);
		const remappedOrder = Object.create(null) as Record<string, string[]>;
		for (const [parentPath, childPaths] of Object.entries(this.settings.folderOrder)) {
			const remappedParent = replacePathPrefix(parentPath, oldPath, newPath);
			remappedOrder[remappedParent] = childPaths.map((path) =>
				isSmartFolderScope(path) ? path : replacePathPrefix(path, oldPath, newPath)
			);
		}
		this.settings.folderOrder = remappedOrder;
		this.settings.folderSections = remapFolderSections(
			this.settings.folderSections,
			oldPath,
			newPath
		);
		this.settings.smartFolders = remapSmartFolderParents(
			this.settings.smartFolders,
			oldPath,
			newPath
		);
		this.settings.folderSortOverrides = remapSortOverrideKeys(
			this.settings.folderSortOverrides,
			oldPath,
			newPath
		);
		this.settings.noteSortOverrides = remapSortOverrideKeys(
			this.settings.noteSortOverrides,
			oldPath,
			newPath
		);
		await this.saveSettings();
	}

	/** Remap persisted paths after a vault folder rename (idempotent). */
	async remapFolderPathAfterRename(oldPath: string, newPath: string): Promise<void> {
		await this.remapFolderPath(oldPath, newPath);
	}

	removeNoteSortOverrideForSmartFolder(id: string): void {
		const key = toSmartFolderScope(id);
		if (!(key in this.settings.noteSortOverrides)) return;
		const next = { ...this.settings.noteSortOverrides };
		delete next[key];
		this.settings.noteSortOverrides = next;
	}

	private pruneSortOverrides(): boolean {
		const rootPath = this.app.vault.getRoot().path;
		const beforeFolders = JSON.stringify(this.settings.folderSortOverrides);
		const beforeNotes = JSON.stringify(this.settings.noteSortOverrides);

		this.settings.folderSortOverrides = pruneMissingOverrideKeys(
			this.settings.folderSortOverrides,
			(key) => {
				if (key === rootPath) return true;
				const folder = this.app.vault.getAbstractFileByPath(key);
				return folder instanceof TFolder;
			}
		);

		const knownSmartIds = new Set(this.settings.smartFolders.map((folder) => folder.id));
		this.settings.noteSortOverrides = pruneMissingOverrideKeys(
			this.settings.noteSortOverrides,
			(key) => {
				if (key === "all") return true;
				if (isSmartFolderScope(key)) {
					const id = smartFolderScopeId(key);
					return id !== null && knownSmartIds.has(id);
				}
				const folder = this.app.vault.getAbstractFileByPath(key);
				return folder instanceof TFolder;
			}
		);

		return (
			JSON.stringify(this.settings.folderSortOverrides) !== beforeFolders ||
			JSON.stringify(this.settings.noteSortOverrides) !== beforeNotes
		);
	}

	private pruneExpandedFolders(): void {
		this.settings.expandedFolders = this.settings.expandedFolders.filter((path) => {
			const folder = this.app.vault.getAbstractFileByPath(path);
			return folder instanceof TFolder;
		});
	}

	private pruneSmartFolderParents(): boolean {
		const result = pruneMissingSmartParents(this.settings.smartFolders, (path) => {
			const folder = this.app.vault.getAbstractFileByPath(path);
			return folder instanceof TFolder;
		});
		this.settings.smartFolders = result.folders;
		return result.changed;
	}

	/**
	 * Ensures every smart folder has a parent placement and appears in the
	 * matching order list. Missing root smart folders are prepended so older
	 * settings (flat list under All notes) stay near the top of unassigned.
	 */
	private ensureSmartFolderPlacement(): boolean {
		const rootPath = this.app.vault.getRoot().path;
		const beforeFolders = JSON.stringify(this.settings.smartFolders);
		const beforeOrder = JSON.stringify(this.settings.folderOrder);
		const beforeSections = JSON.stringify(this.settings.folderSections);

		const missingRootKeys: string[] = [];
		for (const folder of this.settings.smartFolders) {
			const key = toSmartItemKey(folder.id);
			if (folder.parentPath !== null) {
				const parent = this.app.vault.getAbstractFileByPath(folder.parentPath);
				if (!(parent instanceof TFolder)) {
					folder.parentPath = null;
				}
			}

			if (folder.parentPath === null) {
				const inSection =
					findSectionIdForFolder(this.settings.folderSections, key) !== null;
				const inRootOrder = (this.settings.folderOrder[rootPath] ?? []).includes(key);
				if (!inSection && !inRootOrder) {
					missingRootKeys.push(key);
				}
			} else {
				const order = this.settings.folderOrder[folder.parentPath] ?? [];
				if (!order.includes(key)) {
					this.settings.folderOrder[folder.parentPath] = [...order, key];
				}
				this.settings.folderSections = this.settings.folderSections.map((section) => ({
					...section,
					folderPaths: section.folderPaths.filter((path) => path !== key),
				}));
			}
		}

		if (missingRootKeys.length > 0) {
			const current = this.settings.folderOrder[rootPath] ?? [];
			const filtered = current.filter((key) => !missingRootKeys.includes(key));
			this.settings.folderOrder[rootPath] = [...missingRootKeys, ...filtered];
		}

		const knownSmartKeys = new Set(
			this.settings.smartFolders.map((folder) => toSmartItemKey(folder.id))
		);
		for (const [parentPath, childPaths] of Object.entries(this.settings.folderOrder)) {
			this.settings.folderOrder[parentPath] = childPaths.filter(
				(path) => !isSmartFolderScope(path) || knownSmartKeys.has(path)
			);
		}

		return (
			JSON.stringify(this.settings.smartFolders) !== beforeFolders ||
			JSON.stringify(this.settings.folderOrder) !== beforeOrder ||
			JSON.stringify(this.settings.folderSections) !== beforeSections
		);
	}

	private pruneCollapsedSections(): void {
		const ids = new Set(this.settings.folderSections.map((section) => section.id));
		this.settings.collapsedSectionIds = this.settings.collapsedSectionIds.filter((id) =>
			ids.has(id)
		);
	}

	private parseExpandedFolders(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value.filter((path): path is string => typeof path === "string" && path.length > 0);
	}

	private parsePane(value: unknown): ExplorerPane {
		return value === "notes" ? "notes" : "folders";
	}

	private parseNotesScope(value: unknown): string {
		return typeof value === "string" && value.length > 0 ? value : "all";
	}

	private parseSortBy(value: unknown): NoteSortBy {
		return value === "name" || value === "mtime" || value === "ctime" ? value : "mtime";
	}

	private parseSortDir(value: unknown): NoteSortDir {
		return value === "asc" || value === "desc" ? value : "desc";
	}

	private parseFolderSortBy(value: unknown): FolderSortBy {
		return value === "name" || value === "mtime" || value === "ctime" || value === "custom"
			? value
			: "custom";
	}

	private parseFolderSortDir(value: unknown): FolderSortDir {
		return value === "asc" || value === "desc" ? value : "asc";
	}

	private parseFolderSortOverrides(value: unknown): Record<string, FolderSortRule> {
		return this.parseSortOverrides(value, (sortBy, sortDir) => ({
			sortBy: this.parseFolderSortBy(sortBy),
			sortDir: this.parseFolderSortDir(sortDir),
		}));
	}

	private parseNoteSortOverrides(value: unknown): Record<string, NoteSortRule> {
		return this.parseSortOverrides(value, (sortBy, sortDir) => ({
			sortBy: this.parseSortBy(sortBy),
			sortDir: this.parseSortDir(sortDir),
		}));
	}

	private parseSortOverrides<TRule>(
		value: unknown,
		parseRule: (sortBy: unknown, sortDir: unknown) => TRule
	): Record<string, TRule> {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return Object.create(null) as Record<string, TRule>;
		}

		const parsed = Object.create(null) as Record<string, TRule>;
		for (const [key, entry] of Object.entries(value)) {
			if (typeof key !== "string" || key.length === 0) continue;
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const record = entry as Record<string, unknown>;
			parsed[key] = parseRule(record.sortBy, record.sortDir);
		}
		return parsed;
	}

	private parseGroupBy(value: unknown): NoteGroupBy {
		return value === "none" || value === "mtime" || value === "ctime" ? value : "mtime";
	}

	private parseFolderOrder(value: unknown): Record<string, string[]> {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return Object.create(null) as Record<string, string[]>;
		}

		const parsed = Object.create(null) as Record<string, string[]>;
		for (const [parentPath, childPaths] of Object.entries(value)) {
			if (!Array.isArray(childPaths)) continue;
			parsed[parentPath] = childPaths.filter(
				(childPath): childPath is string => typeof childPath === "string"
			);
		}
		return parsed;
	}

	private parseFolderSections(value: unknown): FolderSection[] {
		if (!Array.isArray(value)) return [];
		const sections: FolderSection[] = [];
		for (const entry of value) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.id !== "string" || record.id.length === 0) continue;
			if (typeof record.name !== "string") continue;
			const folderPaths = Array.isArray(record.folderPaths)
				? record.folderPaths.filter((path): path is string => typeof path === "string")
				: [];
			sections.push({
				id: record.id,
				name: record.name.trim() || "Untitled",
				folderPaths,
			});
		}
		return sections;
	}

	private parseSmartFolders(value: unknown): SmartFolder[] {
		if (!Array.isArray(value)) return [];
		const folders: SmartFolder[] = [];
		const seen = new Set<string>();
		for (const entry of value) {
			const folder = parseSmartFolder(entry);
			if (!folder || seen.has(folder.id)) continue;
			seen.add(folder.id);
			folders.push(folder);
		}
		return folders;
	}
}
