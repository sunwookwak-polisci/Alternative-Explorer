export const VIEW_TYPE_ALTERNATIVE_EXPLORER = "alternative-explorer-view";

export const SMART_FOLDER_SCOPE_PREFIX = "smart:";

export type ExplorerPane = "folders" | "notes";

export type NoteSortBy = "name" | "mtime" | "ctime";
export type NoteSortDir = "asc" | "desc";
export type NoteGroupBy = "none" | "mtime" | "ctime";

export type FolderSortBy = "name" | "mtime" | "ctime" | "custom";
export type FolderSortDir = "asc" | "desc";

export interface FolderSortRule {
	sortBy: FolderSortBy;
	sortDir: FolderSortDir;
}

export interface NoteSortRule {
	sortBy: NoteSortBy;
	sortDir: NoteSortDir;
}

export interface FolderSection {
	id: string;
	name: string;
	folderPaths: string[];
}

export type SmartFolderMatch = "all" | "any";

export type SmartFolderBuiltinField =
	| "tags"
	| "name"
	| "path"
	| "ctime"
	| "mtime"
	| "pinned";

export type SmartFolderField = SmartFolderBuiltinField | `frontmatter:${string}`;

export type SmartFolderOperator =
	| "equals"
	| "not-equals"
	| "contains"
	| "not-contains"
	| "exists"
	| "not-exists"
	| "starts-with"
	| "ends-with"
	| "before"
	| "after"
	| "on"
	| "within";

export interface SmartFolderRule {
	id: string;
	field: SmartFolderField;
	operator: SmartFolderOperator;
	value: string;
}

export interface SmartFolder {
	id: string;
	name: string;
	/** Vault folder path when nested; null when shown at the vault root. */
	parentPath: string | null;
	match: SmartFolderMatch;
	rules: SmartFolderRule[];
}

export interface AlternativeExplorerSettings {
	currentFolder: string;
	pane: ExplorerPane;
	notesScope: string;
	recursive: boolean;
	expandedFolders: string[];
	folderOrder: Record<string, string[]>;
	folderSections: FolderSection[];
	collapsedSectionIds: string[];
	folderSortBy: FolderSortBy;
	folderSortDir: FolderSortDir;
	folderSortOverrides: Record<string, FolderSortRule>;
	smartFolders: SmartFolder[];
	sortBy: NoteSortBy;
	sortDir: NoteSortDir;
	noteSortOverrides: Record<string, NoteSortRule>;
	groupBy: NoteGroupBy;
	groupPinned: boolean;
	/** When true, the Folders block atop a folder's notes list is collapsed. */
	notesSubfoldersCollapsed: boolean;
	/** When true, the Pinned group in the notes list is collapsed. */
	notesPinnedCollapsed: boolean;
}

export function createDefaultSettings(rootPath: string): AlternativeExplorerSettings {
	return {
		currentFolder: rootPath,
		pane: "folders",
		notesScope: "all",
		recursive: false,
		expandedFolders: [],
		folderOrder: Object.create(null) as Record<string, string[]>,
		folderSections: [],
		collapsedSectionIds: [],
		folderSortBy: "custom",
		folderSortDir: "asc",
		folderSortOverrides: Object.create(null) as Record<string, FolderSortRule>,
		smartFolders: [],
		sortBy: "mtime",
		sortDir: "desc",
		noteSortOverrides: Object.create(null) as Record<string, NoteSortRule>,
		groupBy: "mtime",
		groupPinned: true,
		notesSubfoldersCollapsed: false,
		notesPinnedCollapsed: false,
	};
}

export function isSmartFolderScope(scope: string): boolean {
	return scope.startsWith(SMART_FOLDER_SCOPE_PREFIX);
}

export function smartFolderScopeId(scope: string): string | null {
	if (!isSmartFolderScope(scope)) return null;
	const id = scope.slice(SMART_FOLDER_SCOPE_PREFIX.length);
	return id.length > 0 ? id : null;
}

export function toSmartFolderScope(id: string): string {
	return `${SMART_FOLDER_SCOPE_PREFIX}${id}`;
}
