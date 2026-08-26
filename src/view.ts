import { ItemView, Menu, Notice, Platform, Scope, TFile, TFolder, WorkspaceLeaf, getAllTags, moment, setIcon } from "obsidian";
import type AlternativeExplorerPlugin from "./main";
import {
	FolderSortBy,
	FolderSortDir,
	NoteGroupBy,
	NoteSortBy,
	NoteSortDir,
	SmartFolder,
	VIEW_TYPE_ALTERNATIVE_EXPLORER,
	isSmartFolderScope,
	smartFolderScopeId,
	toSmartFolderScope,
} from "./constants";
import { getBookmarkedFilePaths, toggleFileBookmark } from "./bookmarks";
import { mergeFolderOrder, moveFolderRelative } from "./folder-order";
import {
	destinationFolderPath,
	isInvalidMoveParent,
	resolveVaultFolderDrop,
} from "./folder-moves";
import {
	childSmartItemKeys,
	collectExpandableFolderPaths,
	effectiveSmartParentPath,
	ExpandableFolderNode,
	isSmartItemKey,
	placeItemInParentOrder,
	removeSmartFolderPlacement,
	rootSmartItemKeys,
	setSmartFolderParent,
	smartIdFromItemKey,
	toSmartItemKey,
} from "./folder-items";
import {
	createFolderSection,
	deleteSection,
	findSectionIdForFolder,
	insertFolderInSection,
	moveFolderToSection,
	partitionRootFolders,
	removeFolderFromSections,
	renameSection,
	reorderSections,
	sortFolderPaths,
} from "./folder-sections";
import { buildNoteGroups } from "./note-groups";
import { nextAvailablePath } from "./create-paths";
import { canOpenInObsidian, openWithDefaultApp } from "./file-openable";
import { iconForFileExtension } from "./file-type-icons";
import { SectionNameModal } from "./section-name-modal";
import { ConfirmModal } from "./confirm-modal";
import { SmartFolderModal } from "./smart-folder-modal";
import { noteMatchesSmartFolder, type SmartFolderNoteSnapshot } from "./smart-folders";
import {
	clearSortOverride,
	hasSortOverride,
	resolveFolderSort,
	resolveNoteSort,
	setSortOverride,
} from "./sort-overrides";

type FolderAction =
	| "select"
	| "toggle"
	| "back-to-folders"
	| "toggle-section"
	| "toggle-notes-subfolders";

type DropPosition = "before" | "after" | "into";

type FolderDropTarget = {
	kind: "folder" | "zone";
	element: HTMLElement;
	sectionId: string;
	folderPath?: string;
	parentPath?: string;
	allowsInto?: boolean;
};

const UNASSIGNED_SECTION_ID = "";

const SORT_BY_LABELS: Record<NoteSortBy, string> = {
	name: "Name",
	mtime: "Modified",
	ctime: "Created",
};

const FOLDER_SORT_BY_LABELS: Record<FolderSortBy, string> = {
	name: "Name",
	mtime: "Modified",
	ctime: "Created",
	custom: "Custom",
};

const GROUP_BY_LABELS: Record<NoteGroupBy, string> = {
	none: "None",
	mtime: "Modified",
	ctime: "Created",
};

export class AlternativeExplorerView extends ItemView {
	private draggedFolderPath: string | null = null;
	private draggedSectionId: string | null = null;
	private folderStatCache = new Map<string, { mtime: number; ctime: number }>();
	private revealFilePath: string | null = null;
	private selectedFilePath: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: AlternativeExplorerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_ALTERNATIVE_EXPLORER;
	}

	getDisplayText(): string {
		return "Alternative Explorer";
	}

	getIcon(): string {
		return "panels-top-left";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("alternative-explorer-view");
		this.scope = new Scope(this.app.scope);
		this.registerInteractions();
		this.registerNoteHotkeys();
		this.registerWorkspaceSelectionSync();
		this.render();
	}

	async onClose(): Promise<void> {
		this.draggedFolderPath = null;
		this.draggedSectionId = null;
		this.folderStatCache.clear();
		this.selectedFilePath = null;

		const remaining = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_ALTERNATIVE_EXPLORER)
			.filter((leaf) => leaf !== this.leaf);
		if (remaining.length === 0 && this.plugin.settings.pane !== "folders") {
			this.plugin.settings.pane = "folders";
			await this.plugin.saveSettings();
		}
	}

	render(): void {
		const container = this.contentEl;
		container.empty();
		this.folderStatCache.clear();

		const browser = container.createEl("main", { cls: "alternative-explorer-browser" });
		if (this.plugin.settings.pane === "notes") {
			this.renderNotesPane(browser);
		} else {
			this.renderFoldersPane(browser);
		}

		this.applySelectionHighlight();
		this.applyRevealHighlight();
	}

	private registerInteractions(): void {
		this.registerDomEvent(this.contentEl, "click", (event) => {
			const element = event.target as HTMLElement;
			const folderControl = element.closest<HTMLButtonElement>("button[data-folder-action]");
			if (folderControl) {
				event.preventDefault();
				const action = folderControl.dataset.folderAction as FolderAction | undefined;
				const path = folderControl.dataset.folderPath;
				const sectionId = folderControl.dataset.sectionId;
				if (!action) return;
				if (action === "back-to-folders") {
					void this.backToFolders();
					return;
				}
				if (action === "toggle-section" && sectionId) {
					void this.toggleSectionCollapsed(sectionId);
					return;
				}
				if (action === "toggle-notes-subfolders") {
					void this.toggleNotesSubfoldersCollapsed();
					return;
				}
				if (path) {
					void this.handleFolderAction(path, action);
				}
				return;
			}

			const allNotesControl = element.closest<HTMLButtonElement>("button[data-open-all-notes]");
			if (allNotesControl) {
				event.preventDefault();
				void this.openAllNotes();
				return;
			}

			const smartFolderControl = element.closest<HTMLButtonElement>(
				"button[data-open-smart-folder]"
			);
			if (smartFolderControl?.dataset.openSmartFolder) {
				event.preventDefault();
				void this.openSmartFolder(smartFolderControl.dataset.openSmartFolder);
				return;
			}

			const newNoteControl = element.closest<HTMLButtonElement>("button[data-new-note]");
			if (newNoteControl) {
				event.preventDefault();
				void this.createNote();
				return;
			}

			const newFolderControl = element.closest<HTMLButtonElement>("button[data-new-folder]");
			if (newFolderControl) {
				event.preventDefault();
				this.createVaultFolder();
				return;
			}

			const newSectionControl = element.closest<HTMLButtonElement>(
				"button[data-new-section]"
			);
			if (newSectionControl) {
				event.preventDefault();
				void this.createSection();
				return;
			}

			const newSmartFolderControl = element.closest<HTMLButtonElement>(
				"button[data-new-smart-folder]"
			);
			if (newSmartFolderControl) {
				event.preventDefault();
				this.createSmartFolder();
				return;
			}

			const smartFolderMenuControl = element.closest<HTMLButtonElement>(
				"button[data-smart-folder-menu]"
			);
			if (smartFolderMenuControl?.dataset.smartFolderMenu) {
				event.preventDefault();
				this.showSmartFolderContextMenu(
					event,
					smartFolderMenuControl.dataset.smartFolderMenu,
					smartFolderMenuControl
				);
				return;
			}

			const revealControl = element.closest<HTMLButtonElement>(
				"button[data-reveal-current-note]"
			);
			if (revealControl) {
				event.preventDefault();
				void this.revealCurrentNote();
				return;
			}

			const expandFoldAllControl = element.closest<HTMLButtonElement>(
				"button[data-expand-fold-all]"
			);
			if (expandFoldAllControl) {
				event.preventDefault();
				void this.toggleExpandFoldAll();
				return;
			}

			const recursiveControl = element.closest<HTMLButtonElement>("button[data-recursive]");
			if (recursiveControl) {
				event.preventDefault();
				void this.setRecursive(recursiveControl.dataset.recursive === "true");
				return;
			}

			const folderSortMenuControl = element.closest<HTMLButtonElement>(
				"button[data-open-folder-sort-menu]"
			);
			if (folderSortMenuControl) {
				event.preventDefault();
				const parentPath =
					folderSortMenuControl.dataset.folderSortParent ??
					this.app.vault.getRoot().path;
				this.showFolderSortMenu(event, folderSortMenuControl, parentPath);
				return;
			}

			const notesDisplayMenuControl = element.closest<HTMLButtonElement>(
				"button[data-open-notes-display-menu]"
			);
			if (notesDisplayMenuControl) {
				event.preventDefault();
				this.showNotesDisplayMenu(event, notesDisplayMenuControl);
				return;
			}

			const fileControl = element.closest<HTMLButtonElement>("button[data-file-path]");
			if (fileControl?.dataset.filePath) {
				event.preventDefault();
				void this.handleNoteClick(fileControl.dataset.filePath);
			}
		});

		this.registerDomEvent(this.contentEl, "keydown", (event) => {
			this.handleNoteKeydown(event);
		});

		this.registerDomEvent(this.contentEl, "contextmenu", (event) => {
			const target = event.target as HTMLElement;
			const sectionHeader = target.closest<HTMLElement>(
				".alternative-explorer-folder-section-header[data-section-id]"
			);
			if (sectionHeader?.dataset.sectionId) {
				event.preventDefault();
				this.showSectionContextMenu(event, sectionHeader.dataset.sectionId);
				return;
			}

			const smartFolderRow = target.closest<HTMLElement>(
				".alternative-explorer-folder-row[data-smart-folder-id]"
			);
			if (smartFolderRow?.dataset.smartFolderId) {
				event.preventDefault();
				this.showSmartFolderContextMenu(event, smartFolderRow.dataset.smartFolderId);
				return;
			}

			const folderRow = target.closest<HTMLElement>(
				".alternative-explorer-folder-row[data-folder-path]"
			);
			if (folderRow?.dataset.folderPath && folderRow.dataset.depth === "0") {
				event.preventDefault();
				this.showFolderContextMenu(event, folderRow.dataset.folderPath);
				return;
			}

			const fileControl = target.closest<HTMLButtonElement>("button[data-file-path]");
			const path = fileControl?.dataset.filePath;
			if (!path) return;

			event.preventDefault();
			this.showNoteContextMenu(event, path);
		});

		this.registerDomEvent(this.contentEl, "dragstart", (event) => {
			const target = event.target as HTMLElement;
			const sectionHeader = target.closest<HTMLElement>(
				".alternative-explorer-folder-section-header[data-section-id]"
			);
			if (sectionHeader?.dataset.sectionId) {
				this.draggedSectionId = sectionHeader.dataset.sectionId;
				this.draggedFolderPath = null;
				event.dataTransfer?.setData("text/plain", `section:${sectionHeader.dataset.sectionId}`);
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = "move";
				}
				sectionHeader.addClass("is-dragging");
				return;
			}

			const row = target.closest<HTMLElement>(
				".alternative-explorer-folder-row[data-folder-path]"
			);
			const path = row?.dataset.folderPath;
			if (!row || !path) {
				event.preventDefault();
				return;
			}

			this.draggedFolderPath = path;
			this.draggedSectionId = null;
			event.dataTransfer?.setData("text/plain", path);
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "move";
			}
			row.addClass("is-dragging");
		});

		this.registerDomEvent(this.contentEl, "dragover", (event) => {
			if (this.draggedSectionId) {
				const header = this.getValidSectionDropTarget(event.target);
				if (!header) return;
				event.preventDefault();
				if (event.dataTransfer) {
					event.dataTransfer.dropEffect = "move";
				}
				this.clearDropTargets();
				header.addClass(
					event.clientY <
						header.getBoundingClientRect().top + header.getBoundingClientRect().height / 2
						? "is-drop-before"
						: "is-drop-after"
				);
				return;
			}

			const drop = this.getValidFolderDropTarget(event.target);
			if (!drop) return;
			event.preventDefault();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "move";
			}
			this.clearDropTargets();
			const position = this.dropPositionForEvent(event, drop);
			if (position === "into") {
				drop.element.addClass("is-drop-into");
			} else {
				drop.element.addClass(position === "before" ? "is-drop-before" : "is-drop-after");
			}
		});

		this.registerDomEvent(this.contentEl, "drop", (event) => {
			if (this.draggedSectionId) {
				const header = this.getValidSectionDropTarget(event.target);
				const targetId = header?.dataset.sectionId;
				if (!targetId) return;
				event.preventDefault();
				const position = header.hasClass("is-drop-after") ? "after" : "before";
				void this.moveSectionRelativeToTarget(this.draggedSectionId, targetId, position);
				this.finishDrag();
				return;
			}

			const drop = this.getValidFolderDropTarget(event.target);
			if (!drop || !this.draggedFolderPath) return;
			event.preventDefault();
			const position = this.dropPositionForEvent(event, drop);
			void this.handleFolderDrop(this.draggedFolderPath, drop, position);
			this.finishDrag();
		});

		this.registerDomEvent(this.contentEl, "dragend", () => {
			this.finishDrag();
		});
	}

	private renderFoldersPane(container: HTMLElement): void {
		const root = this.app.vault.getRoot();
		this.renderFoldersHeader(container);

		const section = container.createEl("section", {
			cls: "alternative-explorer-section alternative-explorer-folder-section",
			attr: { "aria-label": "Folders" },
		});

		const list = section.createDiv({ cls: "alternative-explorer-folder-list" });
		this.renderAllNotesRow(list);

		const rootFolders = root.children.filter(
			(child): child is TFolder => child instanceof TFolder
		);
		const rootVaultPaths = rootFolders.map((folder) => folder.path);
		const rootItemKeys = [
			...rootVaultPaths,
			...rootSmartItemKeys(this.plugin.settings.smartFolders),
		];
		const { unassigned, sections } = partitionRootFolders(
			rootItemKeys,
			this.plugin.settings.folderSections
		);

		const unassignedSorted = this.sortRootFolderPaths(
			unassigned,
			this.plugin.settings.folderOrder[root.path]
		);
		if (unassignedSorted.length > 0) {
			const unassignedList = list.createDiv({
				cls: "alternative-explorer-folder-group",
				attr: { "data-section-id": UNASSIGNED_SECTION_ID, "data-drop-zone": "unassigned" },
			});
			for (const key of unassignedSorted) {
				this.renderFolderTreeItem(unassignedList, key, root.path, 0, UNASSIGNED_SECTION_ID);
			}
		} else if (sections.length > 0) {
			list.createDiv({
				cls: "alternative-explorer-folder-group is-empty-drop-zone",
				attr: { "data-section-id": UNASSIGNED_SECTION_ID, "data-drop-zone": "unassigned" },
			});
		}

		for (const folderSection of sections) {
			this.renderFolderSection(list, root, folderSection);
		}
	}

	private renderFoldersHeader(container: HTMLElement): void {
		const header = container.createEl("header", { cls: "alternative-explorer-header" });
		const heading = header.createDiv({ cls: "alternative-explorer-heading" });
		const titleGroup = heading.createDiv({ cls: "alternative-explorer-title-group" });
		titleGroup.createEl("h1", { text: "Folders" });

		const controls = heading.createDiv({
			cls: "alternative-explorer-list-controls",
			attr: { "aria-label": "Folder controls" },
		});

		this.renderRevealButton(controls);
		this.renderExpandFoldAllButton(controls);
		this.renderNewNoteButton(controls);
		this.renderNewFolderButton(controls);

		const newSmartFolderButton = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-new-smart-folder": "true",
				"aria-label": "New smart folder",
				title: "New smart folder",
			},
		});
		setIcon(newSmartFolderButton, "sparkles");

		const newSectionButton = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-new-section": "true",
				"aria-label": "New section",
				title: "New section",
			},
		});
		setIcon(newSectionButton, "list-plus");

		const { sortBy: folderSortBy, sortDir: folderSortDir } = this.effectiveFolderSort(
			this.app.vault.getRoot().path
		);
		const sortTitle = `Folder Sort: ${FOLDER_SORT_BY_LABELS[folderSortBy]} ${folderSortDir === "asc" ? "ascending" : "descending"}`;
		const sortButton = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-open-folder-sort-menu": "true",
				"data-folder-sort-parent": this.app.vault.getRoot().path,
				"aria-haspopup": "menu",
				"aria-label": sortTitle,
				title: sortTitle,
			},
		});
		setIcon(sortButton, folderSortDir === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
	}

	private renderExpandFoldAllButton(controls: HTMLElement): void {
		const anyExpanded = this.isAnyTreeOrSectionExpanded();
		const label = anyExpanded ? "Fold all" : "Expand all";
		const button = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-expand-fold-all": "true",
				"aria-label": label,
				title: label,
			},
		});
		setIcon(button, anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
	}

	private renderRevealButton(controls: HTMLElement): void {
		const revealButton = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-reveal-current-note": "true",
				"aria-label": "Reveal current note",
				title: "Reveal current note",
			},
		});
		setIcon(revealButton, "locate-fixed");
	}

	private renderNewNoteButton(controls: HTMLElement): void {
		const button = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-new-note": "true",
				"aria-label": "New note",
				title: "New note",
			},
		});
		setIcon(button, "file-plus");
	}

	private renderNewFolderButton(controls: HTMLElement): void {
		const button = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-new-folder": "true",
				"aria-label": "New folder",
				title: "New folder",
			},
		});
		setIcon(button, "folder-plus");
	}

	private folderRowDragAttr(): Record<string, string> {
		return Platform.isMobile ? {} : { draggable: "true" };
	}

	private renderFolderSection(
		list: HTMLElement,
		root: TFolder,
		folderSection: { id: string; name: string; folderPaths: string[] }
	): void {
		const collapsed = this.plugin.settings.collapsedSectionIds.includes(folderSection.id);
		const header = list.createDiv({
			cls: `alternative-explorer-folder-section-header${collapsed ? "" : " is-expanded"}`,
			attr: {
				...this.folderRowDragAttr(),
				"data-section-id": folderSection.id,
			},
		});

		const toggle = header.createEl("button", {
			cls: `clickable-icon alternative-explorer-folder-toggle${collapsed ? "" : " is-expanded"}`,
			attr: {
				type: "button",
				"data-folder-action": "toggle-section",
				"data-section-id": folderSection.id,
				"aria-expanded": String(!collapsed),
				"aria-label": collapsed
					? `Expand ${folderSection.name}`
					: `Collapse ${folderSection.name}`,
				title: collapsed ? `Expand ${folderSection.name}` : `Collapse ${folderSection.name}`,
			},
		});
		setIcon(toggle, "chevron-right");

		header.createSpan({
			cls: "alternative-explorer-folder-section-name",
			text: folderSection.name,
		});

		const dragHandle = header.createSpan({
			cls: "alternative-explorer-drag-handle",
			attr: { "aria-hidden": "true" },
		});
		setIcon(dragHandle, "grip-vertical");

		if (collapsed) {
			return;
		}

		const group = list.createDiv({
			cls: "alternative-explorer-folder-group",
			attr: { "data-section-id": folderSection.id },
		});
		const sorted = this.sortRootFolderPaths(folderSection.folderPaths, folderSection.folderPaths);
		if (sorted.length === 0) {
			group.addClass("is-empty-drop-zone");
			return;
		}

		for (const key of sorted) {
			this.renderFolderTreeItem(group, key, root.path, 0, folderSection.id);
		}
	}

	private renderAllNotesRow(list: HTMLElement): void {
		const row = list.createDiv({ cls: "alternative-explorer-folder-row is-smart-row" });
		row.createSpan({ cls: "alternative-explorer-folder-toggle-spacer" });
		const button = row.createEl("button", {
			cls: "alternative-explorer-folder-button",
			attr: {
				type: "button",
				"data-open-all-notes": "true",
				title: "All notes",
			},
		});
		const icon = button.createSpan({ cls: "alternative-explorer-row-icon" });
		setIcon(icon, "files");
		const copy = button.createSpan({ cls: "alternative-explorer-folder-copy" });
		copy.createSpan({ cls: "alternative-explorer-folder-name", text: "All notes" });
		const noteCount = this.listFilesInFolder(this.app.vault.getRoot(), true).length;
		button.createSpan({
			cls: "alternative-explorer-folder-count",
			text: String(noteCount),
			attr: {
				"aria-label": `${noteCount} ${noteCount === 1 ? "note" : "notes"}`,
			},
		});
		// Reserve the same trailing gutter as draggable folder rows.
		row.createSpan({
			cls: "alternative-explorer-drag-handle-spacer",
			attr: { "aria-hidden": "true" },
		});
	}

	private renderSmartFolderRow(
		list: HTMLElement,
		smartFolder: SmartFolder,
		parentPath: string,
		depth: number,
		sectionId: string
	): void {
		const root = this.app.vault.getRoot();
		const isRootChild = parentPath === root.path;
		const selected = this.plugin.settings.notesScope === toSmartFolderScope(smartFolder.id);
		const itemKey = toSmartItemKey(smartFolder.id);
		const row = list.createDiv({
			cls: `alternative-explorer-folder-row is-smart-row${selected ? " is-selected" : ""}`,
			attr: {
				...this.folderRowDragAttr(),
				"data-folder-path": itemKey,
				"data-smart-folder-id": smartFolder.id,
				"data-parent-path": parentPath,
				"data-section-id": isRootChild ? sectionId : "",
				"data-depth": String(depth),
			},
		});
		row.createSpan({ cls: "alternative-explorer-folder-toggle-spacer" });
		const button = row.createEl("button", {
			cls: "alternative-explorer-folder-button",
			attr: {
				type: "button",
				"data-open-smart-folder": smartFolder.id,
				title: smartFolder.name,
			},
		});
		const icon = button.createSpan({ cls: "alternative-explorer-row-icon" });
		setIcon(icon, "sparkles");
		const copy = button.createSpan({ cls: "alternative-explorer-folder-copy" });
		copy.createSpan({
			cls: "alternative-explorer-folder-name",
			text: smartFolder.name,
		});
		const noteCount = this.countSmartFolderNotes(smartFolder);
		button.createSpan({
			cls: "alternative-explorer-folder-count",
			text: String(noteCount),
			attr: {
				"aria-label": `${noteCount} ${noteCount === 1 ? "note" : "notes"}`,
			},
		});

		if (Platform.isMobile) {
			const menuButton = row.createEl("button", {
				cls: "clickable-icon alternative-explorer-smart-folder-menu",
				attr: {
					type: "button",
					"data-smart-folder-menu": smartFolder.id,
					"aria-label": `${smartFolder.name} options`,
					title: `${smartFolder.name} options`,
				},
			});
			setIcon(menuButton, "ellipsis-vertical");
		}

		const dragHandle = row.createSpan({
			cls: "alternative-explorer-drag-handle",
			attr: { "aria-hidden": "true" },
		});
		setIcon(dragHandle, "grip-vertical");
	}

	private renderFolderTreeItem(
		list: HTMLElement,
		itemKey: string,
		parentPath: string,
		depth: number,
		sectionId: string
	): void {
		if (isSmartItemKey(itemKey)) {
			const id = smartIdFromItemKey(itemKey);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			if (!smartFolder) return;
			this.renderSmartFolderRow(list, smartFolder, parentPath, depth, sectionId);
			return;
		}

		const folder = this.app.vault.getAbstractFileByPath(itemKey);
		if (!(folder instanceof TFolder)) return;
		this.renderFolderRow(list, parentPath, folder, depth, sectionId);

		if (!this.isExpanded(folder.path)) return;
		const children = list.createDiv({ cls: "alternative-explorer-folder-children" });
		for (const childKey of this.getOrderedChildKeys(folder)) {
			this.renderFolderTreeItem(children, childKey, folder.path, depth + 1, sectionId);
		}
	}

	private renderFolderRow(
		list: HTMLElement,
		parentPath: string,
		child: TFolder,
		depth: number,
		sectionId: string
	): void {
		const vaultChildren = child.children.some((entry) => entry instanceof TFolder);
		const smartChildren = childSmartItemKeys(
			this.plugin.settings.smartFolders,
			child.path
		).length;
		const hasSubfolders = vaultChildren || smartChildren > 0;
		const expanded = this.isExpanded(child.path);
		const selected = this.plugin.settings.notesScope === child.path;
		const root = this.app.vault.getRoot();
		const isRootChild = parentPath === root.path;

		const row = list.createDiv({
			cls: `alternative-explorer-folder-row${selected ? " is-selected" : ""}`,
			attr: {
				...this.folderRowDragAttr(),
				"data-folder-path": child.path,
				"data-parent-path": parentPath,
				"data-section-id": isRootChild ? sectionId : "",
				"data-depth": String(depth),
			},
		});

		if (hasSubfolders) {
			const toggleButton = row.createEl("button", {
				cls: `clickable-icon alternative-explorer-folder-toggle${expanded ? " is-expanded" : ""}`,
				attr: {
					type: "button",
					"data-folder-action": "toggle",
					"data-folder-path": child.path,
					"aria-expanded": String(expanded),
					"aria-label": expanded ? `Collapse ${child.name}` : `Expand ${child.name}`,
					title: expanded ? `Collapse ${child.name}` : `Expand ${child.name}`,
				},
			});
			setIcon(toggleButton, "chevron-right");
		} else {
			row.createSpan({ cls: "alternative-explorer-folder-toggle-spacer" });
		}

		const openButton = row.createEl("button", {
			cls: "alternative-explorer-folder-button",
			attr: {
				type: "button",
				"data-folder-action": "select",
				"data-folder-path": child.path,
				title: child.path,
			},
		});
		const icon = openButton.createSpan({ cls: "alternative-explorer-row-icon" });
		setIcon(icon, "folder");
		const copy = openButton.createSpan({ cls: "alternative-explorer-folder-copy" });
		copy.createSpan({ cls: "alternative-explorer-folder-name", text: child.name });
		const noteCount = child.children.filter((entry) => entry instanceof TFile).length;
		openButton.createSpan({
			cls: "alternative-explorer-folder-count",
			text: String(noteCount),
			attr: {
				"aria-label": `${noteCount} ${noteCount === 1 ? "note" : "notes"}`,
			},
		});

		const dragHandle = row.createSpan({
			cls: "alternative-explorer-drag-handle",
			attr: { "aria-hidden": "true" },
		});
		setIcon(dragHandle, "grip-vertical");
	}

	private renderNotesPane(container: HTMLElement): void {
		const title = this.notesTitle();
		this.renderNotesHeader(container, title);

		const subfolderKeys = this.getNotesPaneSubfolderKeys();
		if (subfolderKeys.length > 0) {
			this.renderNotesSubfoldersSection(container, subfolderKeys);
		}

		const files = this.getNotesForScope();
		const pinnedPaths = getBookmarkedFilePaths(this.app);
		const { sortBy, sortDir } = this.effectiveNoteSort();
		const { groupBy, groupPinned } = this.plugin.settings;
		const groups = buildNoteGroups(
			files.map((file) => ({
				file,
				path: file.path,
				name: file.basename,
				mtime: file.stat.mtime,
				ctime: file.stat.ctime,
			})),
			{
				sortBy,
				sortDir,
				groupBy,
				groupPinned,
				pinnedPaths,
			}
		);

		if (groups.length === 0) {
			if (subfolderKeys.length > 0) {
				return;
			}
			const empty = container.createDiv({ cls: "alternative-explorer-empty" });
			const icon = empty.createSpan();
			setIcon(icon, "file-text");
			empty.createDiv({ text: "No notes here yet" });
			empty.createEl("p", {
				text: this.emptyNotesMessage(),
			});
			return;
		}

		for (const group of groups) {
			const section = container.createEl("section", {
				cls: "alternative-explorer-section alternative-explorer-file-section",
			});
			const showHeader = !(group.id === "all" && groups.length === 1);
			if (showHeader) {
				const headingId = `alternative-explorer-group-${group.id}`;
				section.setAttr("aria-labelledby", headingId);
				const sectionHeader = section.createDiv({ cls: "alternative-explorer-section-header" });
				const label = sectionHeader.createDiv({ cls: "alternative-explorer-section-label" });
				label.createEl("h2", {
					text: group.label,
					attr: { id: headingId },
				});
				label.createSpan({
					text: String(group.notes.length),
					attr: {
						"aria-label": `${group.notes.length} ${group.notes.length === 1 ? "note" : "notes"}`,
					},
				});
			}

			const list = section.createDiv({ cls: "alternative-explorer-file-list" });
			for (const entry of group.notes) {
				this.renderNoteRow(list, entry.file, pinnedPaths.has(entry.path));
			}
		}
	}

	private getNotesPaneSubfolderKeys(): string[] {
		const scope = this.plugin.settings.notesScope;
		if (scope === "all" || isSmartFolderScope(scope)) {
			return [];
		}
		const folder = this.app.vault.getAbstractFileByPath(scope);
		if (!(folder instanceof TFolder)) {
			return [];
		}
		return this.getOrderedChildKeys(folder);
	}

	private renderNotesSubfoldersSection(container: HTMLElement, childKeys: string[]): void {
		const collapsed = this.plugin.settings.notesSubfoldersCollapsed;
		const headingId = "alternative-explorer-notes-folders-heading";
		const section = container.createEl("section", {
			cls: "alternative-explorer-section alternative-explorer-notes-folders-section",
		});
		section.setAttr("aria-labelledby", headingId);

		const sectionHeader = section.createDiv({
			cls: `alternative-explorer-section-header alternative-explorer-notes-folders-header${
				collapsed ? "" : " is-expanded"
			}`,
		});
		const label = sectionHeader.createDiv({ cls: "alternative-explorer-section-label" });
		label.createEl("h2", {
			text: "Folders",
			attr: { id: headingId },
		});
		label.createSpan({
			text: String(childKeys.length),
			attr: {
				"aria-label": `${childKeys.length} ${childKeys.length === 1 ? "folder" : "folders"}`,
			},
		});

		const toggle = sectionHeader.createEl("button", {
			cls: `clickable-icon alternative-explorer-folder-toggle${collapsed ? "" : " is-expanded"}`,
			attr: {
				type: "button",
				"data-folder-action": "toggle-notes-subfolders",
				"aria-expanded": String(!collapsed),
				"aria-label": collapsed ? "Expand folders" : "Collapse folders",
				title: collapsed ? "Expand folders" : "Collapse folders",
			},
		});
		setIcon(toggle, "chevron-right");

		if (collapsed) {
			return;
		}

		const list = section.createDiv({
			cls: "alternative-explorer-file-list alternative-explorer-notes-folders-list",
		});
		const parentPath = this.plugin.settings.notesScope;
		for (const childKey of childKeys) {
			this.renderNotesSubfolderRow(list, childKey, parentPath);
		}
	}

	private renderNotesSubfolderRow(
		list: HTMLElement,
		itemKey: string,
		parentPath: string
	): void {
		if (isSmartItemKey(itemKey)) {
			const id = smartIdFromItemKey(itemKey);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			if (!smartFolder) return;

			const row = list.createEl("button", {
				cls: "alternative-explorer-notes-folder-row",
				attr: {
					type: "button",
					"data-open-smart-folder": smartFolder.id,
					title: smartFolder.name,
				},
			});
			const icon = row.createSpan({ cls: "alternative-explorer-row-icon" });
			setIcon(icon, "sparkles");
			row.createSpan({
				cls: "alternative-explorer-folder-name",
				text: smartFolder.name,
			});
			row.createSpan({
				cls: "alternative-explorer-notes-folder-count",
				text: this.smartFolderNoteCountLabel(smartFolder),
			});
			const arrow = row.createSpan({ cls: "alternative-explorer-row-arrow" });
			setIcon(arrow, "chevron-right");
			return;
		}

		const folder = this.app.vault.getAbstractFileByPath(itemKey);
		if (!(folder instanceof TFolder)) return;

		const row = list.createEl("button", {
			cls: "alternative-explorer-notes-folder-row",
			attr: {
				type: "button",
				"data-folder-action": "select",
				"data-folder-path": folder.path,
				"data-parent-path": parentPath,
				title: folder.path,
			},
		});
		const icon = row.createSpan({ cls: "alternative-explorer-row-icon" });
		setIcon(icon, "folder");
		row.createSpan({
			cls: "alternative-explorer-folder-name",
			text: folder.name,
		});
		row.createSpan({
			cls: "alternative-explorer-notes-folder-count",
			text: this.folderNoteCountLabel(folder),
		});
		const arrow = row.createSpan({ cls: "alternative-explorer-row-arrow" });
		setIcon(arrow, "chevron-right");
	}

	private folderNoteCountLabel(folder: TFolder): string {
		const count = this.listFilesInFolder(folder, true).length;
		return String(count);
	}

	private smartFolderNoteCountLabel(smartFolder: SmartFolder): string {
		return String(this.countSmartFolderNotes(smartFolder));
	}

	private renderNotesHeader(container: HTMLElement, title: string): void {
		const header = container.createEl("header", { cls: "alternative-explorer-header" });
		const navigation = header.createDiv({ cls: "alternative-explorer-navigation" });
		const backButton = navigation.createEl("button", {
			cls: "clickable-icon alternative-explorer-back-button",
			attr: {
				type: "button",
				"data-folder-action": "back-to-folders",
				"aria-label": "Back to folders",
			},
		});
		setIcon(backButton, "arrow-left");
		navigation.createSpan({
			cls: "alternative-explorer-pane-label",
			text: "Folders",
		});
		if (this.plugin.settings.notesScope !== "all") {
			navigation.createEl("button", {
				cls: "alternative-explorer-all-notes-button",
				text: "All notes",
				attr: {
					type: "button",
					"data-open-all-notes": "true",
					"aria-label": "All notes",
					title: "All notes",
				},
			});
		}

		const heading = header.createDiv({ cls: "alternative-explorer-heading" });
		const titleGroup = heading.createDiv({ cls: "alternative-explorer-title-group" });
		titleGroup.createEl("h1", { text: title, attr: { title } });
		if (this.canToggleNotesDepth()) {
			this.renderModeToggle(titleGroup);
		}

		this.renderListControls(heading);
	}

	private renderListControls(container: HTMLElement): void {
		const controls = container.createDiv({
			cls: "alternative-explorer-list-controls",
			attr: { "aria-label": "Note controls" },
		});

		this.renderRevealButton(controls);
		this.renderNewNoteButton(controls);
		if (this.canCreateFolderInNotesPane()) {
			this.renderNewFolderButton(controls);
		}

		const displayButton = controls.createEl("button", {
			cls: "clickable-icon alternative-explorer-control-button",
			attr: {
				type: "button",
				"data-open-notes-display-menu": "true",
				"aria-haspopup": "menu",
				"aria-label": "Display options",
				title: "Display options",
			},
		});
		setIcon(displayButton, "sliders-horizontal");
	}

	private renderModeToggle(container: HTMLElement): void {
		const recursive = this.plugin.settings.recursive;
		const title = recursive
			? "All below — showing notes in this folder and subfolders"
			: "This folder — showing notes directly in this folder";
		const button = container.createEl("button", {
			cls: `clickable-icon alternative-explorer-depth-toggle${recursive ? " is-active" : ""}`,
			attr: {
				type: "button",
				"data-recursive": String(!recursive),
				"aria-pressed": String(recursive),
				"aria-label": recursive ? "Show this folder only" : "Show all notes below",
				title,
			},
		});
		setIcon(button, recursive ? "folder-tree" : "folder");
	}

	private renderNoteRow(list: HTMLElement, file: TFile, pinned: boolean): void {
		const activePath = this.selectedFilePath ?? this.app.workspace.getActiveFile()?.path ?? null;
		const isActive = activePath === file.path;
		const row = list.createEl("button", {
			cls: `alternative-explorer-file-row${pinned ? " is-pinned" : ""}${isActive ? " is-active" : ""}`,
			attr: {
				type: "button",
				"data-file-path": file.path,
				title: file.path,
			},
		});
		const icon = row.createSpan({ cls: "alternative-explorer-row-icon" });
		setIcon(icon, pinned ? "pin" : iconForFileExtension(file.extension));
		const copy = row.createSpan({ cls: "alternative-explorer-file-copy" });
		copy.createSpan({ cls: "alternative-explorer-file-title", text: file.basename });
		const parent = file.parent;
		const showLocation =
			(this.plugin.settings.notesScope === "all" ||
				isSmartFolderScope(this.plugin.settings.notesScope) ||
				this.plugin.settings.recursive) &&
			parent !== null &&
			!parent.isRoot() &&
			parent.path !== this.plugin.settings.notesScope;
		if (showLocation && parent) {
			copy.createSpan({
				cls: "alternative-explorer-file-location",
				text:
					this.plugin.settings.notesScope === "all" ||
					isSmartFolderScope(this.plugin.settings.notesScope)
						? parent.path
						: this.relativeParentPath(this.plugin.settings.notesScope, file),
			});
		}
		const dateValue =
			this.plugin.settings.sortBy === "ctime" ? file.stat.ctime : file.stat.mtime;
		copy.createEl("time", {
			cls: "alternative-explorer-file-date",
			text: moment(dateValue).format("MMM D"),
			attr: {
				datetime: moment(dateValue).toISOString(),
				title: moment(dateValue).format("YYYY-MM-DD HH:mm"),
			},
		});
	}

	private async handleFolderAction(path: string, action: FolderAction): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return;

		if (action === "toggle") {
			this.toggleExpanded(folder.path);
		} else if (action === "select") {
			this.plugin.settings.pane = "notes";
			this.plugin.settings.notesScope = folder.path;
		}

		await this.plugin.saveSettings();
		this.render();
	}

	private async toggleSectionCollapsed(sectionId: string): Promise<void> {
		const collapsed = this.plugin.settings.collapsedSectionIds;
		const index = collapsed.indexOf(sectionId);
		if (index >= 0) {
			collapsed.splice(index, 1);
		} else {
			collapsed.push(sectionId);
		}
		await this.plugin.saveSettings();
		this.render();
	}

	private async toggleNotesSubfoldersCollapsed(): Promise<void> {
		this.plugin.settings.notesSubfoldersCollapsed =
			!this.plugin.settings.notesSubfoldersCollapsed;
		await this.plugin.saveSettings();
		this.render();
	}

	private createSection(initialFolderPath?: string): void {
		new SectionNameModal(this.app, "New section", "New section", "Create", (name) => {
			if (name === null) return;
			void this.finishCreateSection(name, initialFolderPath);
		}).open();
	}

	private canCreateFolderInNotesPane(): boolean {
		const scope = this.plugin.settings.notesScope;
		return scope === "all" || !isSmartFolderScope(scope);
	}

	/** Parent folder for New note / New folder, based on the active pane. */
	private resolveCreateParentFolder(): TFolder | null {
		const root = this.app.vault.getRoot();
		if (this.plugin.settings.pane !== "notes") {
			return root;
		}

		const scope = this.plugin.settings.notesScope;
		if (scope === "all" || isSmartFolderScope(scope)) {
			return root;
		}

		const folder = this.app.vault.getAbstractFileByPath(scope);
		return folder instanceof TFolder ? folder : null;
	}

	private async createNote(): Promise<void> {
		const parent = this.resolveCreateParentFolder();
		if (!parent) {
			new Notice("Could not find a folder for the new note.");
			return;
		}

		const path = nextAvailablePath(
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
			parent.path,
			"Untitled",
			"md"
		);

		try {
			const file = await this.app.vault.create(path, "");
			if (this.plugin.settings.pane === "folders") {
				this.plugin.settings.pane = "notes";
				this.plugin.settings.notesScope = parent.isRoot() ? "all" : parent.path;
				await this.plugin.saveSettings();
			}
			await this.openFile(file.path);
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Could not create note: ${message}`);
		}
	}

	private createVaultFolder(): void {
		const parent = this.resolveCreateParentFolder();
		if (!parent) {
			new Notice("Could not find a parent folder.");
			return;
		}

		new SectionNameModal(this.app, "New folder", "Untitled", "Create", (name) => {
			if (name === null) return;
			void this.finishCreateVaultFolder(parent, name);
		}).open();
	}

	private async finishCreateVaultFolder(parent: TFolder, name: string): Promise<void> {
		const safeName = name.replaceAll("/", "-").trim() || "Untitled";
		const path = nextAvailablePath(
			(candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null,
			parent.path,
			safeName
		);

		try {
			await this.app.vault.createFolder(path);
			if (!parent.isRoot() && !this.isExpanded(parent.path)) {
				this.plugin.settings.expandedFolders.push(parent.path);
				await this.plugin.saveSettings();
			}
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Could not create folder: ${message}`);
		}
	}

	private async finishCreateSection(name: string, initialFolderPath?: string): Promise<void> {
		const section = createFolderSection(name, initialFolderPath ? [initialFolderPath] : []);
		if (initialFolderPath) {
			this.plugin.settings.folderSections = moveFolderToSection(
				this.plugin.settings.folderSections,
				initialFolderPath,
				null
			);
			this.removeFromUnassignedOrder(initialFolderPath);
		}
		this.plugin.settings.folderSections = [
			...this.plugin.settings.folderSections,
			section,
		];
		await this.plugin.saveSettings();
		this.render();
	}

	private async setRecursive(recursive: boolean): Promise<void> {
		if (this.plugin.settings.recursive === recursive) return;
		this.plugin.settings.recursive = recursive;
		await this.plugin.saveSettings();
		this.render();
	}

	private async setSort(sortBy: NoteSortBy, sortDir: NoteSortDir): Promise<void> {
		const scope = this.plugin.settings.notesScope;
		const current = this.effectiveNoteSort();
		if (current.sortBy === sortBy && current.sortDir === sortDir) {
			return;
		}
		this.plugin.settings.noteSortOverrides = setSortOverride(
			this.plugin.settings.noteSortOverrides,
			scope,
			{ sortBy, sortDir }
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async clearNoteSortOverride(): Promise<void> {
		const scope = this.plugin.settings.notesScope;
		if (!hasSortOverride(this.plugin.settings.noteSortOverrides, scope)) return;
		this.plugin.settings.noteSortOverrides = clearSortOverride(
			this.plugin.settings.noteSortOverrides,
			scope
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async setFolderSort(
		parentPath: string,
		sortBy: FolderSortBy,
		sortDir: FolderSortDir
	): Promise<void> {
		const current = this.effectiveFolderSort(parentPath);
		if (current.sortBy === sortBy && current.sortDir === sortDir) {
			return;
		}
		this.plugin.settings.folderSortOverrides = setSortOverride(
			this.plugin.settings.folderSortOverrides,
			parentPath,
			{ sortBy, sortDir }
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async clearFolderSortOverride(parentPath: string): Promise<void> {
		if (!hasSortOverride(this.plugin.settings.folderSortOverrides, parentPath)) return;
		this.plugin.settings.folderSortOverrides = clearSortOverride(
			this.plugin.settings.folderSortOverrides,
			parentPath
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async setGroupBy(groupBy: NoteGroupBy): Promise<void> {
		if (this.plugin.settings.groupBy === groupBy) return;
		this.plugin.settings.groupBy = groupBy;
		await this.plugin.saveSettings();
		this.render();
	}

	private async setGroupPinned(groupPinned: boolean): Promise<void> {
		if (this.plugin.settings.groupPinned === groupPinned) return;
		this.plugin.settings.groupPinned = groupPinned;
		await this.plugin.saveSettings();
		this.render();
	}

	private showMenuAtAnchor(event: MouseEvent, menu: Menu, anchor: HTMLElement): void {
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
		event.stopPropagation();
	}

	private addMenuSectionLabel(menu: Menu, title: string): void {
		menu.addItem((item) => {
			item.setTitle(title).setIsLabel(true);
		});
	}

	private addFolderSortMenuItems(menu: Menu, parentPath: string): void {
		const effective = this.effectiveFolderSort(parentPath);
		const hasOverride = hasSortOverride(
			this.plugin.settings.folderSortOverrides,
			parentPath
		);
		for (const sortBy of ["name", "mtime", "ctime", "custom"] as const) {
			menu.addItem((item) => {
				item
					.setTitle(FOLDER_SORT_BY_LABELS[sortBy])
					.setChecked(effective.sortBy === sortBy)
					.onClick(() => {
						void this.setFolderSort(parentPath, sortBy, effective.sortDir);
					});
			});
		}
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Ascending")
				.setChecked(effective.sortDir === "asc")
				.onClick(() => {
					void this.setFolderSort(parentPath, effective.sortBy, "asc");
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Descending")
				.setChecked(effective.sortDir === "desc")
				.onClick(() => {
					void this.setFolderSort(parentPath, effective.sortBy, "desc");
				});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Restore Default Folder Sorting")
				.setDisabled(!hasOverride)
				.onClick(() => {
					void this.clearFolderSortOverride(parentPath);
				});
		});
	}

	private addNoteSortMenuItems(menu: Menu): void {
		const effective = this.effectiveNoteSort();
		const hasOverride = hasSortOverride(
			this.plugin.settings.noteSortOverrides,
			this.plugin.settings.notesScope
		);
		for (const sortBy of ["name", "mtime", "ctime"] as const) {
			menu.addItem((item) => {
				item
					.setTitle(SORT_BY_LABELS[sortBy])
					.setChecked(effective.sortBy === sortBy)
					.onClick(() => {
						void this.setSort(sortBy, effective.sortDir);
					});
			});
		}
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Ascending")
				.setChecked(effective.sortDir === "asc")
				.onClick(() => {
					void this.setSort(effective.sortBy, "asc");
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Descending")
				.setChecked(effective.sortDir === "desc")
				.onClick(() => {
					void this.setSort(effective.sortBy, "desc");
				});
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Restore Default File Sorting")
				.setDisabled(!hasOverride)
				.onClick(() => {
					void this.clearNoteSortOverride();
				});
		});
	}

	private addGroupMenuItems(menu: Menu): void {
		for (const groupBy of ["none", "mtime", "ctime"] as const) {
			menu.addItem((item) => {
				item
					.setTitle(GROUP_BY_LABELS[groupBy])
					.setChecked(this.plugin.settings.groupBy === groupBy)
					.onClick(() => {
						void this.setGroupBy(groupBy);
					});
			});
		}
	}

	private showFolderSortMenu(
		event: MouseEvent,
		anchor: HTMLElement,
		parentPath: string
	): void {
		const menu = new Menu();
		this.addFolderSortMenuItems(menu, parentPath);
		this.showMenuAtAnchor(event, menu, anchor);
	}

	private showNotesDisplayMenu(event: MouseEvent, anchor: HTMLElement): void {
		const menu = new Menu();
		const notesFolderPath = this.notesFolderSortParent();
		if (notesFolderPath !== null) {
			this.addMenuSectionLabel(menu, "Folder Sort");
			this.addFolderSortMenuItems(menu, notesFolderPath);
			menu.addSeparator();
		}

		this.addMenuSectionLabel(menu, "File Sort");
		this.addNoteSortMenuItems(menu);
		menu.addSeparator();
		this.addMenuSectionLabel(menu, "Group File By");
		this.addGroupMenuItems(menu);
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Group Pinned Files")
				.setChecked(this.plugin.settings.groupPinned)
				.onClick(() => {
					void this.setGroupPinned(!this.plugin.settings.groupPinned);
				});
		});
		this.showMenuAtAnchor(event, menu, anchor);
	}

	private showFolderContextMenu(event: MouseEvent, folderPath: string): void {
		const menu = Menu.forEvent(event);
		const currentSectionId = findSectionIdForFolder(
			this.plugin.settings.folderSections,
			folderPath
		);

		menu.addItem((item) => {
			item.setTitle("Move to section").setDisabled(true);
		});
		menu.addItem((item) => {
			item
				.setTitle("No section")
				.setChecked(currentSectionId === null)
				.onClick(() => {
					void this.assignFolderToSection(folderPath, null);
				});
		});

		for (const section of this.plugin.settings.folderSections) {
			menu.addItem((item) => {
				item
					.setTitle(section.name)
					.setChecked(currentSectionId === section.id)
					.onClick(() => {
						void this.assignFolderToSection(folderPath, section.id);
					});
			});
		}

		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("New section with folder")
				.setIcon("folder-plus")
				.onClick(() => {
					void this.createSection(folderPath);
				});
		});
	}

	private showSectionContextMenu(event: MouseEvent, sectionId: string): void {
		const section = this.plugin.settings.folderSections.find((entry) => entry.id === sectionId);
		if (!section) return;

		const menu = Menu.forEvent(event);
		menu.addItem((item) => {
			item
				.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => {
					void this.renameFolderSection(sectionId, section.name);
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Delete section")
				.setIcon("trash")
				.onClick(() => {
					this.confirmDeleteFolderSection(sectionId, section.name);
				});
		});
	}

	private confirmDeleteFolderSection(sectionId: string, name: string): void {
		new ConfirmModal(
			this.app,
			"Delete section",
			`Delete section “${name}”? Folders in it stay in the vault and move back to the unassigned list.`,
			"Delete",
			(confirmed) => {
				if (!confirmed) return;
				void this.deleteFolderSection(sectionId);
			}
		).open();
	}

	private async assignFolderToSection(
		folderPath: string,
		sectionId: string | null
	): Promise<void> {
		this.plugin.settings.folderSections = moveFolderToSection(
			this.plugin.settings.folderSections,
			folderPath,
			sectionId
		);
		if (sectionId === null) {
			this.appendToUnassignedOrder(folderPath);
		} else {
			this.removeFromUnassignedOrder(folderPath);
		}
		await this.plugin.saveSettings();
		this.render();
	}

	private renameFolderSection(sectionId: string, currentName: string): void {
		new SectionNameModal(this.app, "Rename section", currentName, "Save", (name) => {
			if (name === null) return;
			void this.finishRenameFolderSection(sectionId, name);
		}).open();
	}

	private async finishRenameFolderSection(sectionId: string, name: string): Promise<void> {
		this.plugin.settings.folderSections = renameSection(
			this.plugin.settings.folderSections,
			sectionId,
			name
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async deleteFolderSection(sectionId: string): Promise<void> {
		const section = this.plugin.settings.folderSections.find((entry) => entry.id === sectionId);
		if (!section) return;
		for (const path of section.folderPaths) {
			this.appendToUnassignedOrder(path);
		}
		this.plugin.settings.folderSections = deleteSection(
			this.plugin.settings.folderSections,
			sectionId
		);
		this.plugin.settings.collapsedSectionIds =
			this.plugin.settings.collapsedSectionIds.filter((id) => id !== sectionId);
		await this.plugin.saveSettings();
		this.render();
	}

	private async openAllNotes(): Promise<void> {
		this.plugin.settings.pane = "notes";
		this.plugin.settings.notesScope = "all";
		await this.plugin.saveSettings();
		this.render();
	}

	private async openSmartFolder(id: string): Promise<void> {
		const smartFolder = this.plugin.settings.smartFolders.find((folder) => folder.id === id);
		if (!smartFolder) return;
		this.plugin.settings.pane = "notes";
		this.plugin.settings.notesScope = toSmartFolderScope(smartFolder.id);
		await this.plugin.saveSettings();
		this.render();
	}

	private createSmartFolder(): void {
		new SmartFolderModal(this.app, "New smart folder", null, "Create", (folder) => {
			if (!folder) return;
			void this.finishCreateSmartFolder(folder);
		}).open();
	}

	private async finishCreateSmartFolder(folder: SmartFolder): Promise<void> {
		const rootPath = this.app.vault.getRoot().path;
		const key = toSmartItemKey(folder.id);
		this.plugin.settings.smartFolders = [
			...this.plugin.settings.smartFolders,
			{ ...folder, parentPath: null },
		];
		const order = this.plugin.settings.folderOrder[rootPath] ?? [];
		this.plugin.settings.folderOrder[rootPath] = [
			key,
			...order.filter((entry) => entry !== key),
		];
		await this.plugin.saveSettings();
		this.render();
	}

	private editSmartFolder(id: string): void {
		const existing = this.plugin.settings.smartFolders.find((folder) => folder.id === id);
		if (!existing) return;
		new SmartFolderModal(this.app, "Edit smart folder", existing, "Save", (folder) => {
			if (!folder) return;
			void this.finishEditSmartFolder(folder);
		}).open();
	}

	private async finishEditSmartFolder(folder: SmartFolder): Promise<void> {
		this.plugin.settings.smartFolders = this.plugin.settings.smartFolders.map((entry) =>
			entry.id === folder.id
				? { ...folder, parentPath: entry.parentPath }
				: entry
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private renameSmartFolder(id: string, currentName: string): void {
		new SectionNameModal(this.app, "Rename smart folder", currentName, "Save", (name) => {
			if (name === null) return;
			void this.finishRenameSmartFolder(id, name);
		}).open();
	}

	private async finishRenameSmartFolder(id: string, name: string): Promise<void> {
		this.plugin.settings.smartFolders = this.plugin.settings.smartFolders.map((folder) =>
			folder.id === id ? { ...folder, name: name.trim() || "Untitled" } : folder
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private async deleteSmartFolder(id: string): Promise<void> {
		const removed = removeSmartFolderPlacement(
			this.plugin.settings.smartFolders,
			this.plugin.settings.folderSections,
			this.plugin.settings.folderOrder,
			id
		);
		this.plugin.settings.smartFolders = removed.smartFolders;
		this.plugin.settings.folderSections = removed.folderSections;
		this.plugin.settings.folderOrder = removed.folderOrder;
		this.plugin.removeNoteSortOverrideForSmartFolder(id);
		if (this.plugin.settings.notesScope === toSmartFolderScope(id)) {
			this.plugin.settings.notesScope = "all";
			this.plugin.settings.pane = "folders";
		}
		await this.plugin.saveSettings();
		this.render();
	}

	private showSmartFolderContextMenu(
		event: MouseEvent,
		id: string,
		anchor?: HTMLElement
	): void {
		const smartFolder = this.plugin.settings.smartFolders.find((folder) => folder.id === id);
		if (!smartFolder) return;

		const menu = anchor ? new Menu() : Menu.forEvent(event);
		menu.addItem((item) => {
			item
				.setTitle("Edit rules")
				.setIcon("sliders-horizontal")
				.onClick(() => {
					this.editSmartFolder(id);
				});
		});
		menu.addItem((item) => {
			item
				.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => {
					this.renameSmartFolder(id, smartFolder.name);
				});
		});

		const itemKey = toSmartItemKey(id);
		if (smartFolder.parentPath !== null) {
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle("Move to root")
					.setIcon("folder-input")
					.onClick(() => {
						void this.moveSmartFolderToRoot(id);
					});
			});
		} else {
			const currentSectionId = findSectionIdForFolder(
				this.plugin.settings.folderSections,
				itemKey
			);
			menu.addSeparator();
			menu.addItem((item) => {
				item.setTitle("Move to section").setDisabled(true);
			});
			menu.addItem((item) => {
				item
					.setTitle("No section")
					.setChecked(currentSectionId === null)
					.onClick(() => {
						void this.assignFolderToSection(itemKey, null);
					});
			});
			for (const section of this.plugin.settings.folderSections) {
				menu.addItem((item) => {
					item
						.setTitle(section.name)
						.setChecked(currentSectionId === section.id)
						.onClick(() => {
							void this.assignFolderToSection(itemKey, section.id);
						});
				});
			}
		}

		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Delete smart folder")
				.setIcon("trash")
				.onClick(() => {
					this.confirmDeleteSmartFolder(id, smartFolder.name);
				});
		});

		if (anchor) {
			const rect = anchor.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
			event.stopPropagation();
		}
	}

	private async moveSmartFolderToRoot(id: string): Promise<void> {
		const key = toSmartItemKey(id);
		this.plugin.settings.smartFolders = setSmartFolderParent(
			this.plugin.settings.smartFolders,
			id,
			null
		);
		this.plugin.settings.folderOrder = placeItemInParentOrder(
			this.plugin.settings.folderOrder,
			key,
			this.app.vault.getRoot().path,
			null,
			"after"
		);
		await this.plugin.saveSettings();
		this.render();
	}

	private confirmDeleteSmartFolder(id: string, name: string): void {
		new ConfirmModal(
			this.app,
			"Delete smart folder",
			`Delete smart folder “${name}”? This cannot be undone.`,
			"Delete",
			(confirmed) => {
				if (!confirmed) return;
				void this.deleteSmartFolder(id);
			}
		).open();
	}

	private async revealCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("No active note to reveal.");
			return;
		}

		const parent = file.parent;
		if (!parent || parent.isRoot()) {
			this.plugin.settings.notesScope = "all";
		} else {
			this.plugin.settings.notesScope = parent.path;
		}
		this.plugin.settings.pane = "notes";
		this.plugin.settings.recursive = false;
		this.revealFilePath = file.path;
		await this.plugin.saveSettings();
		this.render();
	}

	private applyRevealHighlight(): void {
		const path = this.revealFilePath;
		if (!path) return;
		this.revealFilePath = null;

		const escaped =
			typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(path)
				: path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const row = this.contentEl.querySelector<HTMLElement>(
			`button.alternative-explorer-file-row[data-file-path="${escaped}"]`
		);
		if (!row) {
			new Notice("Current note is not in this list.");
			return;
		}

		row.scrollIntoView({ block: "nearest" });
		row.addClass("is-revealed");
		window.setTimeout(() => {
			row.removeClass("is-revealed");
		}, 1600);
	}

	private async backToFolders(): Promise<void> {
		this.plugin.settings.pane = "folders";
		await this.plugin.saveSettings();
		this.render();
	}

	private async moveSectionRelativeToTarget(
		sectionId: string,
		targetId: string,
		position: "after" | "before"
	): Promise<void> {
		this.plugin.settings.folderSections = reorderSections(
			this.plugin.settings.folderSections,
			sectionId,
			targetId,
			position
		);
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async handleFolderDrop(
		folderPath: string,
		drop: FolderDropTarget,
		position: DropPosition
	): Promise<void> {
		if (isSmartItemKey(folderPath)) {
			await this.handleSmartFolderDrop(folderPath, drop, position);
			return;
		}

		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;

		const root = this.app.vault.getRoot();
		const sourceParentPath = folder.parent?.path ?? root.path;

		const resolved = resolveVaultFolderDrop({
			sourcePath: folderPath,
			sourceParentPath,
			rootPath: root.path,
			position,
			dropKind: drop.kind,
			targetPath: drop.folderPath,
			targetParentPath: drop.parentPath,
			allowsInto: drop.allowsInto === true,
			sectionId: drop.sectionId,
			sourceSectionId:
				findSectionIdForFolder(this.plugin.settings.folderSections, folderPath) ??
				UNASSIGNED_SECTION_ID,
			sameParentCustomSort:
				drop.kind === "folder" &&
				(drop.parentPath ?? root.path) === sourceParentPath &&
				this.effectiveFolderSort(sourceParentPath).sortBy === "custom",
			unassignedSectionId: UNASSIGNED_SECTION_ID,
		});
		if (!resolved) return;

		if (resolved.kind === "vault-move") {
			await this.moveVaultFolder(
				folder,
				resolved.destParentPath,
				resolved.relativeTargetKey,
				resolved.position === "into" ? "after" : resolved.position,
				resolved.rootSectionId
			);
			return;
		}

		// Display-only: section membership and/or same-parent custom order.
		const isRootFolder = sourceParentPath === root.path;
		if (!isRootFolder) {
			if (!resolved.targetPath) return;
			await this.moveNestedFolderRelativeToTarget(
				folderPath,
				resolved.targetPath,
				resolved.position
			);
			return;
		}

		const targetSectionId = drop.sectionId;
		const custom = this.effectiveFolderSort(root.path).sortBy === "custom";

		if (targetSectionId === UNASSIGNED_SECTION_ID) {
			this.plugin.settings.folderSections = moveFolderToSection(
				this.plugin.settings.folderSections,
				folderPath,
				null
			);
			if (custom && drop.kind === "folder" && drop.folderPath) {
				const order = mergeFolderOrder(
					this.plugin.settings.folderOrder[root.path],
					this.currentUnassignedPaths().concat(folderPath)
				);
				this.plugin.settings.folderOrder[root.path] = moveFolderRelative(
					order.includes(folderPath) ? order : [...order, folderPath],
					folderPath,
					drop.folderPath,
					resolved.position
				);
			} else {
				this.appendToUnassignedOrder(folderPath);
			}
		} else {
			this.removeFromUnassignedOrder(folderPath);
			if (custom && drop.kind === "folder" && drop.folderPath) {
				this.plugin.settings.folderSections = insertFolderInSection(
					this.plugin.settings.folderSections,
					targetSectionId,
					folderPath,
					drop.folderPath,
					resolved.position
				);
			} else {
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					folderPath,
					targetSectionId
				);
			}
		}

		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async moveVaultFolder(
		folder: TFolder,
		destParentPath: string,
		relativeTargetKey: string | null,
		position: "before" | "after",
		rootSectionId: string | null
	): Promise<void> {
		const root = this.app.vault.getRoot();
		const destParent =
			destParentPath === root.path
				? root
				: this.app.vault.getAbstractFileByPath(destParentPath);
		if (!(destParent instanceof TFolder)) return;

		const newPath = destinationFolderPath(destParent.path, folder.name);
		if (newPath === folder.path) return;
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`A folder named “${folder.name}” already exists there.`);
			return;
		}

		const oldPath = folder.path;
		const wasRoot = folder.parent?.path === root.path;
		const becomesRoot = destParent.path === root.path;

		try {
			await this.app.fileManager.renameFile(folder, newPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Could not move folder: ${message}`);
			return;
		}

		await this.plugin.remapFolderPathAfterRename(oldPath, newPath);

		const remappedTarget =
			relativeTargetKey &&
			(relativeTargetKey === oldPath || relativeTargetKey.startsWith(`${oldPath}/`))
				? null
				: relativeTargetKey;
		this.plugin.settings.folderOrder = placeItemInParentOrder(
			this.plugin.settings.folderOrder,
			newPath,
			destParent.path,
			remappedTarget,
			position
		);

		if (wasRoot && !becomesRoot) {
			this.plugin.settings.folderSections = removeFolderFromSections(
				this.plugin.settings.folderSections,
				newPath
			);
			this.removeFromUnassignedOrder(newPath);
		} else if (becomesRoot) {
			if (rootSectionId === null) {
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					newPath,
					null
				);
				this.appendToUnassignedOrder(newPath);
			} else {
				this.removeFromUnassignedOrder(newPath);
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					newPath,
					rootSectionId
				);
			}
		}

		if (!becomesRoot && !this.isExpanded(destParent.path)) {
			this.toggleExpanded(destParent.path);
		}

		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async handleSmartFolderDrop(
		itemKey: string,
		drop: FolderDropTarget,
		position: DropPosition
	): Promise<void> {
		const id = smartIdFromItemKey(itemKey);
		if (!id) return;
		const smartFolder = this.plugin.settings.smartFolders.find((folder) => folder.id === id);
		if (!smartFolder) return;

		const root = this.app.vault.getRoot();

		if (position === "into") {
			const targetPath = drop.folderPath;
			if (!targetPath || isSmartItemKey(targetPath)) return;
			const targetFolder = this.app.vault.getAbstractFileByPath(targetPath);
			if (!(targetFolder instanceof TFolder)) return;

			this.plugin.settings.smartFolders = setSmartFolderParent(
				this.plugin.settings.smartFolders,
				id,
				targetPath
			);
			this.plugin.settings.folderSections = moveFolderToSection(
				this.plugin.settings.folderSections,
				itemKey,
				null
			);
			this.removeFromUnassignedOrder(itemKey);
			this.plugin.settings.folderOrder = placeItemInParentOrder(
				this.plugin.settings.folderOrder,
				itemKey,
				targetPath,
				null,
				"after"
			);
			if (!this.isExpanded(targetPath)) {
				this.toggleExpanded(targetPath);
			}
			await this.plugin.saveSettings();
			this.plugin.refreshViews();
			return;
		}

		if (drop.kind === "zone") {
			this.plugin.settings.smartFolders = setSmartFolderParent(
				this.plugin.settings.smartFolders,
				id,
				null
			);
			const targetSectionId = drop.sectionId;
			if (targetSectionId === UNASSIGNED_SECTION_ID) {
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					itemKey,
					null
				);
				this.appendToUnassignedOrder(itemKey);
			} else {
				this.removeFromUnassignedOrder(itemKey);
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					itemKey,
					targetSectionId
				);
			}
			this.plugin.settings.folderOrder = placeItemInParentOrder(
				this.plugin.settings.folderOrder,
				itemKey,
				root.path,
				null,
				"after"
			);
			await this.plugin.saveSettings();
			this.plugin.refreshViews();
			return;
		}

		const targetKey = drop.folderPath;
		if (!targetKey) return;

		const targetParentPath = drop.parentPath ?? root.path;
		const nextParentPath = targetParentPath === root.path ? null : targetParentPath;
		const orderParentPath = targetParentPath;
		const targetSectionId = drop.sectionId;

		this.plugin.settings.smartFolders = setSmartFolderParent(
			this.plugin.settings.smartFolders,
			id,
			nextParentPath
		);

		if (nextParentPath === null) {
			if (targetSectionId === UNASSIGNED_SECTION_ID) {
				this.plugin.settings.folderSections = moveFolderToSection(
					this.plugin.settings.folderSections,
					itemKey,
					null
				);
			} else {
				this.removeFromUnassignedOrder(itemKey);
				this.plugin.settings.folderSections = insertFolderInSection(
					this.plugin.settings.folderSections,
					targetSectionId,
					itemKey,
					targetKey,
					position
				);
				// Section membership owns root order inside named sections.
				this.plugin.settings.folderOrder = placeItemInParentOrder(
					this.plugin.settings.folderOrder,
					itemKey,
					root.path,
					null,
					"after"
				);
				await this.plugin.saveSettings();
				this.plugin.refreshViews();
				return;
			}
		} else {
			this.plugin.settings.folderSections = moveFolderToSection(
				this.plugin.settings.folderSections,
				itemKey,
				null
			);
			this.removeFromUnassignedOrder(itemKey);
		}

		this.plugin.settings.folderOrder = placeItemInParentOrder(
			this.plugin.settings.folderOrder,
			itemKey,
			orderParentPath,
			targetKey,
			position
		);

		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async moveNestedFolderRelativeToTarget(
		folderPath: string,
		targetPath: string,
		position: "after" | "before"
	): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;

		const parent = folder.parent ?? this.app.vault.getRoot();
		const order = this.getOrderedChildKeys(parent);
		if (!order.includes(targetPath)) return;
		if (folder.parent?.path !== this.parentPathOfItemKey(targetPath)) return;

		this.plugin.settings.folderOrder[parent.path] = moveFolderRelative(
			order,
			folder.path,
			targetPath,
			position
		);
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async openFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		this.selectedFilePath = file.path;
		this.applySelectionHighlight();
		if (canOpenInObsidian(this.app, file)) {
			await this.openInWorkspace(file);
			return;
		}
		openWithDefaultApp(this.app, file.path);
	}

	private async handleNoteClick(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		const alreadySelected = this.selectedFilePath === path;
		if (canOpenInObsidian(this.app, file)) {
			this.selectedFilePath = path;
			this.applySelectionHighlight();
			await this.openInWorkspace(file, { focusEditor: true });
			return;
		}

		if (alreadySelected) {
			openWithDefaultApp(this.app, path);
			return;
		}

		this.selectedFilePath = path;
		this.applySelectionHighlight();
		this.focusNoteRow(path);
	}

	private registerNoteHotkeys(): void {
		if (!this.scope) return;

		this.scope.register([], "ArrowDown", (event) => {
			if (!this.handleNoteArrowNavigation(1)) return;
			event.preventDefault();
			return false;
		});
		this.scope.register([], "ArrowUp", (event) => {
			if (!this.handleNoteArrowNavigation(-1)) return;
			event.preventDefault();
			return false;
		});
		this.scope.register([], "Enter", (event) => {
			if (!this.handleNoteEnter()) return;
			event.preventDefault();
			return false;
		});
	}

	private handleNoteKeydown(event: KeyboardEvent): void {
		const key = event.key;
		if (key === "ArrowDown") {
			if (!this.handleNoteArrowNavigation(1)) return;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (key === "ArrowUp") {
			if (!this.handleNoteArrowNavigation(-1)) return;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (key === "Enter") {
			if (!this.handleNoteEnter()) return;
			event.preventDefault();
			event.stopPropagation();
		}
	}

	/** Returns false when the event should be ignored. */
	private handleNoteArrowNavigation(delta: 1 | -1): boolean {
		if (this.plugin.settings.pane !== "notes") return false;

		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			active.closest("input, textarea, select, [contenteditable='true']")
		) {
			return false;
		}

		const rows = this.getNoteRows();
		if (rows.length === 0) return false;

		const currentIndex = this.resolveNoteRowIndex(rows);
		const nextIndex =
			delta > 0
				? Math.min((currentIndex < 0 ? -1 : currentIndex) + 1, rows.length - 1)
				: Math.max(currentIndex < 0 ? rows.length - 1 : currentIndex - 1, 0);
		const nextRow = rows[nextIndex];
		const nextPath = nextRow?.dataset.filePath;
		if (!nextPath || !nextRow) return false;

		this.selectedFilePath = nextPath;
		this.applySelectionHighlight();
		nextRow.focus({ preventScroll: true });
		nextRow.scrollIntoView({ block: "nearest" });

		const file = this.app.vault.getAbstractFileByPath(nextPath);
		if (file instanceof TFile && canOpenInObsidian(this.app, file)) {
			void this.openInWorkspace(file, { focusEditor: false });
		}
		return true;
	}

	/** Returns false when the event should be ignored. */
	private handleNoteEnter(): boolean {
		if (this.plugin.settings.pane !== "notes") return false;

		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			active.closest("input, textarea, select, [contenteditable='true']")
		) {
			return false;
		}

		const focusedRow =
			active instanceof HTMLElement
				? active.closest<HTMLButtonElement>(
						"button.alternative-explorer-file-row[data-file-path]"
					)
				: null;
		const path = focusedRow?.dataset.filePath ?? this.selectedFilePath;
		if (!path) return false;

		void this.confirmOpenNote(path, { focusEditor: true });
		return true;
	}

	private async confirmOpenNote(
		path: string,
		options: { focusEditor: boolean } = { focusEditor: true }
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		this.selectedFilePath = path;
		this.applySelectionHighlight();
		if (canOpenInObsidian(this.app, file)) {
			await this.openInWorkspace(file, options);
			return;
		}
		openWithDefaultApp(this.app, path);
	}

	private async openInWorkspace(
		file: TFile,
		options: { focusEditor: boolean } = { focusEditor: true }
	): Promise<void> {
		const leaf = this.resolveLeafForOpen();
		await leaf.openFile(file, { active: true });
		if (!options.focusEditor) {
			// openFile may focus the editor asynchronously; reclaim explorer focus after.
			window.setTimeout(() => {
				this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
				this.focusNoteRow(file.path);
			}, 0);
		}
	}

	private resolveLeafForOpen(): WorkspaceLeaf {
		const current =
			this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ??
			this.app.workspace.getLeaf(false);
		if (current === this.leaf) {
			return this.app.workspace.getLeaf(true);
		}
		if (current.getViewState().pinned) {
			return this.app.workspace.getLeaf(true);
		}
		return current;
	}

	private registerWorkspaceSelectionSync(): void {
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (this.plugin.settings.pane !== "notes") return;
				if (!(file instanceof TFile)) return;
				const rows = this.getNoteRows();
				if (!rows.some((row) => row.dataset.filePath === file.path)) return;
				this.selectedFilePath = file.path;
				this.applySelectionHighlight();
			})
		);
	}

	private getNoteRows(): HTMLButtonElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLButtonElement>(
				"button.alternative-explorer-file-row[data-file-path]"
			)
		);
	}

	private resolveNoteRowIndex(rows: HTMLButtonElement[]): number {
		const selected = this.selectedFilePath;
		if (selected) {
			const selectedIndex = rows.findIndex((row) => row.dataset.filePath === selected);
			if (selectedIndex >= 0) return selectedIndex;
		}

		const focused = document.activeElement;
		if (focused instanceof HTMLElement) {
			const focusedRow = focused.closest<HTMLButtonElement>(
				"button.alternative-explorer-file-row[data-file-path]"
			);
			if (focusedRow) {
				const focusedIndex = rows.indexOf(focusedRow);
				if (focusedIndex >= 0) return focusedIndex;
			}
		}

		const activePath = this.activeNotePathInList(rows);
		if (activePath) {
			return rows.findIndex((row) => row.dataset.filePath === activePath);
		}

		return -1;
	}

	private activeNotePathInList(rows: HTMLButtonElement[]): string | null {
		const active = this.app.workspace.getActiveFile();
		if (!(active instanceof TFile)) return null;
		return rows.some((row) => row.dataset.filePath === active.path) ? active.path : null;
	}

	private focusNoteRow(path: string): void {
		const row = this.findNoteRow(path);
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: "nearest" });
	}

	private findNoteRow(path: string): HTMLButtonElement | null {
		const escaped =
			typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(path)
				: path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return this.contentEl.querySelector<HTMLButtonElement>(
			`button.alternative-explorer-file-row[data-file-path="${escaped}"]`
		);
	}

	private applySelectionHighlight(): void {
		const activePath =
			this.selectedFilePath ?? this.app.workspace.getActiveFile()?.path ?? null;
		for (const row of this.getNoteRows()) {
			const isActive = row.dataset.filePath === activePath;
			row.toggleClass("is-active", isActive);
		}
	}

	private showNoteContextMenu(event: MouseEvent, path: string): void {
		const pinned = getBookmarkedFilePaths(this.app).has(path);
		const menu = Menu.forEvent(event);
		menu.addItem((item) => {
			item
				.setTitle(pinned ? "Unpin" : "Pin")
				.setIcon(pinned ? "pin-off" : "pin")
				.onClick(() => {
					const result = toggleFileBookmark(this.app, path);
					if (result === null) {
						new Notice("Enable the core Bookmarks plugin to pin notes.");
						return;
					}
					this.render();
				});
		});
	}

	private isExpanded(path: string): boolean {
		return this.plugin.settings.expandedFolders.includes(path);
	}

	private toggleExpanded(path: string): void {
		const expanded = this.plugin.settings.expandedFolders;
		const index = expanded.indexOf(path);
		if (index >= 0) {
			expanded.splice(index, 1);
		} else {
			expanded.push(path);
		}
	}

	private async toggleExpandFoldAll(): Promise<void> {
		if (this.isAnyTreeOrSectionExpanded()) {
			this.plugin.settings.expandedFolders = [];
			this.plugin.settings.collapsedSectionIds = this.plugin.settings.folderSections.map(
				(section) => section.id
			);
		} else {
			const root = this.app.vault.getRoot();
			const nodes = root.children
				.filter((child): child is TFolder => child instanceof TFolder)
				.map((folder) => this.toExpandableFolderNode(folder));
			this.plugin.settings.expandedFolders = collectExpandableFolderPaths(nodes);
			this.plugin.settings.collapsedSectionIds = [];
		}
		await this.plugin.saveSettings();
		this.render();
	}

	private isAnyTreeOrSectionExpanded(): boolean {
		if (this.plugin.settings.expandedFolders.length > 0) return true;
		const collapsed = this.plugin.settings.collapsedSectionIds;
		return this.plugin.settings.folderSections.some(
			(section) => !collapsed.includes(section.id)
		);
	}

	private toExpandableFolderNode(folder: TFolder): ExpandableFolderNode {
		return {
			path: folder.path,
			children: folder.children
				.filter((child): child is TFolder => child instanceof TFolder)
				.map((child) => this.toExpandableFolderNode(child)),
		};
	}

	private sortRootFolderPaths(
		paths: readonly string[],
		customOrder: readonly string[] | undefined
	): string[] {
		const { sortBy, sortDir } = this.effectiveFolderSort(this.app.vault.getRoot().path);
		return sortFolderPaths(paths, {
			sortBy,
			sortDir,
			customOrder,
			getName: (path) => this.itemDisplayName(path),
			getTimestamp: (path, kind) => this.getFolderTimestamp(path, kind),
		});
	}

	private itemDisplayName(path: string): string {
		if (isSmartItemKey(path)) {
			const id = smartIdFromItemKey(path);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			return smartFolder?.name ?? path;
		}
		const folder = this.app.vault.getAbstractFileByPath(path);
		return folder instanceof TFolder ? folder.name : path;
	}

	private getFolderTimestamp(path: string, kind: "mtime" | "ctime"): number {
		if (isSmartItemKey(path)) return 0;

		const cached = this.folderStatCache.get(path);
		if (cached) return cached[kind];

		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return 0;

		// Folder mtime/ctime from newest/oldest contained note (adapter.stat is async).
		let mtime = 0;
		let ctime = Number.POSITIVE_INFINITY;
		let found = false;
		const visit = (current: TFolder): void => {
			for (const child of current.children) {
				if (child instanceof TFile) {
					found = true;
					mtime = Math.max(mtime, child.stat.mtime);
					ctime = Math.min(ctime, child.stat.ctime);
				} else if (child instanceof TFolder) {
					visit(child);
				}
			}
		};
		visit(folder);
		const stats = {
			mtime: found ? mtime : 0,
			ctime: found && ctime !== Number.POSITIVE_INFINITY ? ctime : 0,
		};
		this.folderStatCache.set(path, stats);
		return stats[kind];
	}

	private getOrderedChildKeys(folder: TFolder): string[] {
		const vaultPaths = folder.children
			.filter((child): child is TFolder => child instanceof TFolder)
			.map((child) => child.path);
		const smartKeys = childSmartItemKeys(this.plugin.settings.smartFolders, folder.path);
		const paths = [...vaultPaths, ...smartKeys];
		const { sortBy, sortDir } = this.effectiveFolderSort(folder.path);
		return sortFolderPaths(paths, {
			sortBy,
			sortDir,
			customOrder: this.plugin.settings.folderOrder[folder.path],
			getName: (path) => this.itemDisplayName(path),
			getTimestamp: (path, kind) => this.getFolderTimestamp(path, kind),
		});
	}

	private effectiveFolderSort(parentPath: string): {
		sortBy: FolderSortBy;
		sortDir: FolderSortDir;
	} {
		return resolveFolderSort(
			{
				sortBy: this.plugin.settings.folderSortBy,
				sortDir: this.plugin.settings.folderSortDir,
			},
			this.plugin.settings.folderSortOverrides,
			parentPath
		);
	}

	private effectiveNoteSort(): { sortBy: NoteSortBy; sortDir: NoteSortDir } {
		return resolveNoteSort(
			{
				sortBy: this.plugin.settings.sortBy,
				sortDir: this.plugin.settings.sortDir,
			},
			this.plugin.settings.noteSortOverrides,
			this.plugin.settings.notesScope
		);
	}

	private notesFolderSortParent(): string | null {
		const scope = this.plugin.settings.notesScope;
		if (scope === "all" || isSmartFolderScope(scope)) return null;
		const folder = this.app.vault.getAbstractFileByPath(scope);
		return folder instanceof TFolder ? folder.path : null;
	}

	private parentPathOfItemKey(itemKey: string): string | null {
		const rootPath = this.app.vault.getRoot().path;
		if (isSmartItemKey(itemKey)) {
			const id = smartIdFromItemKey(itemKey);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			if (!smartFolder) return null;
			return effectiveSmartParentPath(smartFolder, rootPath);
		}
		const folder = this.app.vault.getAbstractFileByPath(itemKey);
		if (!(folder instanceof TFolder)) return null;
		return folder.parent?.path ?? rootPath;
	}

	private currentUnassignedPaths(): string[] {
		const root = this.app.vault.getRoot();
		const rootVaultPaths = root.children
			.filter((child): child is TFolder => child instanceof TFolder)
			.map((child) => child.path);
		const rootItemKeys = [
			...rootVaultPaths,
			...rootSmartItemKeys(this.plugin.settings.smartFolders),
		];
		return partitionRootFolders(rootItemKeys, this.plugin.settings.folderSections).unassigned;
	}

	private appendToUnassignedOrder(folderPath: string): void {
		const rootPath = this.app.vault.getRoot().path;
		const current = this.plugin.settings.folderOrder[rootPath] ?? [];
		if (current.includes(folderPath)) return;
		this.plugin.settings.folderOrder[rootPath] = [...current, folderPath];
	}

	private removeFromUnassignedOrder(folderPath: string): void {
		const rootPath = this.app.vault.getRoot().path;
		const current = this.plugin.settings.folderOrder[rootPath];
		if (!current) return;
		this.plugin.settings.folderOrder[rootPath] = current.filter((path) => path !== folderPath);
	}

	private getNotesForScope(): TFile[] {
		const scope = this.plugin.settings.notesScope;
		if (scope === "all") {
			return this.listFilesInFolder(this.app.vault.getRoot(), true);
		}

		if (isSmartFolderScope(scope)) {
			const id = smartFolderScopeId(scope);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			if (!smartFolder) return [];
			const pinnedPaths = getBookmarkedFilePaths(this.app);
			return this.listFilesInFolder(this.app.vault.getRoot(), true)
				.filter((file) =>
					noteMatchesSmartFolder(this.toSmartFolderNoteSnapshot(file, pinnedPaths), smartFolder)
				);
		}

		const folder = this.app.vault.getAbstractFileByPath(scope);
		if (!(folder instanceof TFolder)) {
			return [];
		}

		return this.listFilesInFolder(folder, this.plugin.settings.recursive);
	}

	private toSmartFolderNoteSnapshot(
		file: TFile,
		pinnedPaths: ReadonlySet<string> = getBookmarkedFilePaths(this.app)
	): SmartFolderNoteSnapshot {
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = cache ? getAllTags(cache) ?? [] : [];
		const frontmatter =
			cache?.frontmatter && typeof cache.frontmatter === "object"
				? (cache.frontmatter as Record<string, unknown>)
				: {};
		return {
			path: file.path,
			name: file.basename,
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			tags,
			frontmatter,
			pinned: pinnedPaths.has(file.path),
		};
	}

	private listFilesInFolder(folder: TFolder, recursive: boolean): TFile[] {
		const files: TFile[] = [];
		const visit = (current: TFolder): void => {
			for (const child of current.children) {
				if (child instanceof TFile) {
					files.push(child);
				} else if (recursive && child instanceof TFolder) {
					visit(child);
				}
			}
		};
		visit(folder);
		return files;
	}

	private notesTitle(): string {
		if (this.plugin.settings.notesScope === "all") {
			return "All notes";
		}
		const smartId = smartFolderScopeId(this.plugin.settings.notesScope);
		if (smartId) {
			const smartFolder = this.plugin.settings.smartFolders.find(
				(folder) => folder.id === smartId
			);
			return smartFolder?.name ?? "Smart folder";
		}
		const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.notesScope);
		if (folder instanceof TFolder) {
			return this.folderName(folder);
		}
		return "Notes";
	}

	private canToggleNotesDepth(): boolean {
		const scope = this.plugin.settings.notesScope;
		return scope !== "all" && !isSmartFolderScope(scope);
	}

	private emptyNotesMessage(): string {
		const scope = this.plugin.settings.notesScope;
		if (scope === "all") {
			return "Notes in the vault will appear here.";
		}
		if (isSmartFolderScope(scope)) {
			return "No notes match this smart folder.";
		}
		return this.plugin.settings.recursive
			? "This folder and its subfolders have no notes yet."
			: "Switch to All below to include notes in subfolders.";
	}

	private folderName(folder: TFolder): string {
		return folder.isRoot() ? "Vault" : folder.name;
	}

	private countSmartFolderNotes(smartFolder: SmartFolder): number {
		const pinnedPaths = getBookmarkedFilePaths(this.app);
		return this.listFilesInFolder(this.app.vault.getRoot(), true)
			.filter((file) =>
				noteMatchesSmartFolder(this.toSmartFolderNoteSnapshot(file, pinnedPaths), smartFolder)
			).length;
	}

	private relativeParentPath(scopePath: string, file: TFile): string {
		const parentPath = file.parent?.path ?? "";
		if (!scopePath || scopePath === "/" || scopePath === "") return parentPath;
		if (parentPath.startsWith(scopePath + "/")) {
			return parentPath.slice(scopePath.length + 1);
		}
		return parentPath;
	}

	private getValidSectionDropTarget(target: EventTarget | null): HTMLElement | null {
		const header = (target as HTMLElement | null)?.closest<HTMLElement>(
			".alternative-explorer-folder-section-header[data-section-id]"
		);
		if (!header || !this.draggedSectionId) return null;
		if (header.dataset.sectionId === this.draggedSectionId) return null;
		return header;
	}

	private getValidFolderDropTarget(target: EventTarget | null): FolderDropTarget | null {
		if (!this.draggedFolderPath) return null;

		const draggedKey = this.draggedFolderPath;
		const isSmartDrag = isSmartItemKey(draggedKey);
		const root = this.app.vault.getRoot();

		if (isSmartDrag) {
			const id = smartIdFromItemKey(draggedKey);
			const smartFolder = id
				? this.plugin.settings.smartFolders.find((folder) => folder.id === id)
				: undefined;
			if (!smartFolder) return null;
		} else {
			const dragged = this.app.vault.getAbstractFileByPath(draggedKey);
			if (!(dragged instanceof TFolder)) return null;
		}

		const header = (target as HTMLElement | null)?.closest<HTMLElement>(
			".alternative-explorer-folder-section-header[data-section-id]"
		);
		if (header?.dataset.sectionId) {
			return {
				kind: "zone",
				element: header,
				sectionId: header.dataset.sectionId,
			};
		}

		const zone = (target as HTMLElement | null)?.closest<HTMLElement>(
			".alternative-explorer-folder-group[data-section-id]"
		);
		const row = (target as HTMLElement | null)?.closest<HTMLElement>(
			".alternative-explorer-folder-row[data-folder-path]"
		);

		if (row?.dataset.folderPath) {
			if (row.dataset.folderPath === draggedKey) return null;

			const targetKey = row.dataset.folderPath;
			const targetParentPath = row.dataset.parentPath ?? root.path;
			const targetIsSmart = isSmartItemKey(targetKey);
			const targetIsVault = !targetIsSmart;

			if (isSmartDrag) {
				return {
					kind: "folder",
					element: row,
					sectionId: row.dataset.sectionId || UNASSIGNED_SECTION_ID,
					folderPath: targetKey,
					parentPath: targetParentPath,
					allowsInto: targetIsVault,
				};
			}

			const allowsInto =
				targetIsVault && !isInvalidMoveParent(draggedKey, targetKey);

			return {
				kind: "folder",
				element: row,
				sectionId: row.dataset.sectionId ?? UNASSIGNED_SECTION_ID,
				folderPath: targetKey,
				parentPath: targetParentPath,
				allowsInto,
			};
		}

		if (zone) {
			return {
				kind: "zone",
				element: zone,
				sectionId: zone.dataset.sectionId ?? UNASSIGNED_SECTION_ID,
			};
		}

		return null;
	}

	private dropPositionForEvent(event: DragEvent, drop: FolderDropTarget): DropPosition {
		const rect = drop.element.getBoundingClientRect();
		const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
		if (drop.allowsInto && ratio >= 0.33 && ratio < 0.67) {
			return "into";
		}
		return ratio < 0.5 ? "before" : "after";
	}

	private clearDropTargets(): void {
		this.contentEl
			.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-into")
			.forEach((element) => {
				element.removeClass("is-drop-before");
				element.removeClass("is-drop-after");
				element.removeClass("is-drop-into");
			});
	}

	private finishDrag(): void {
		this.draggedFolderPath = null;
		this.draggedSectionId = null;
		this.clearDropTargets();
		this.contentEl
			.querySelectorAll(".is-dragging")
			.forEach((element) => element.removeClass("is-dragging"));
	}
}
