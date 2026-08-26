import type { App } from "obsidian";

export type BookmarkItem = {
	type?: string;
	path?: string;
	ctime?: number;
	title?: string;
	items?: BookmarkItem[];
	[key: string]: unknown;
};

export type PinToggleResult = "pinned" | "unpinned";

export interface BookmarksPluginInstance {
	items?: BookmarkItem[];
	getBookmarks?: () => unknown;
	requestSave?: () => void;
	addItem?: (item: BookmarkItem, parent?: BookmarkItem) => void;
	removeItem?: (item: BookmarkItem) => void;
	onItemsChanged?: (save?: boolean) => void;
	on?: (name: string, callback: () => void) => unknown;
	off?: (name: string, callback: () => void) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function collectFilePaths(items: readonly unknown[], into: Set<string>): void {
	for (const item of items) {
		if (!isRecord(item)) continue;
		const bookmark = item as BookmarkItem;
		if (bookmark.type === "file" && typeof bookmark.path === "string" && bookmark.path.length > 0) {
			into.add(bookmark.path);
			continue;
		}
		if (bookmark.type === "group" && Array.isArray(bookmark.items)) {
			collectFilePaths(bookmark.items, into);
		}
	}
}

export function getBookmarksPluginInstance(app: App): BookmarksPluginInstance | null {
	const internalPlugins = (app as App & {
		internalPlugins?: {
			getEnabledPluginById?: (id: string) => unknown;
			getPluginById?: (id: string) => { instance?: BookmarksPluginInstance } | undefined;
			plugins?: Record<string, { instance?: BookmarksPluginInstance; enabled?: boolean }>;
		};
	}).internalPlugins;

	if (!internalPlugins) {
		return null;
	}

	const enabled = internalPlugins.getEnabledPluginById?.("bookmarks") as
		| BookmarksPluginInstance
		| undefined;
	if (enabled && (Array.isArray(enabled.items) || typeof enabled.getBookmarks === "function")) {
		return enabled;
	}

	const fromGetter = internalPlugins.getPluginById?.("bookmarks")?.instance;
	if (fromGetter && (Array.isArray(fromGetter.items) || typeof fromGetter.getBookmarks === "function")) {
		return fromGetter;
	}

	const plugin = internalPlugins.plugins?.bookmarks;
	if (
		plugin?.instance &&
		(Array.isArray(plugin.instance.items) || typeof plugin.instance.getBookmarks === "function")
	) {
		return plugin.instance;
	}

	return null;
}

function readBookmarkItems(app: App): unknown[] {
	const instance = getBookmarksPluginInstance(app);
	if (!instance) {
		return [];
	}

	// Prefer the live `items` tree so pin detection and toggle mutate the same list.
	if (Array.isArray(instance.items)) {
		return instance.items;
	}

	if (typeof instance.getBookmarks === "function") {
		const bookmarks = instance.getBookmarks();
		return Array.isArray(bookmarks) ? bookmarks : [];
	}

	return [];
}

/** Returns bookmarked file paths from Obsidian's core Bookmarks plugin. */
export function getBookmarkedFilePaths(app: App): Set<string> {
	const paths = new Set<string>();
	try {
		collectFilePaths(readBookmarkItems(app), paths);
	} catch {
		return new Set();
	}
	return paths;
}

/** Stable fingerprint for comparing bookmarked path sets. */
export function bookmarkPathsFingerprint(paths: ReadonlySet<string>): string {
	return Array.from(paths).sort().join("\0");
}

/**
 * Wraps `requestSave` so Bookmarks mutations notify listeners.
 * Returns an unsubscribe that restores the previous `requestSave`.
 */
export function wrapBookmarksRequestSave(
	instance: BookmarksPluginInstance,
	onChange: () => void
): () => void {
	const previous = instance.requestSave;
	const boundPrevious =
		typeof previous === "function" ? previous.bind(instance) : undefined;

	instance.requestSave = () => {
		onChange();
		boundPrevious?.();
	};

	return () => {
		if (instance.requestSave !== undefined && boundPrevious) {
			instance.requestSave = boundPrevious;
		} else if (previous === undefined) {
			delete instance.requestSave;
		} else {
			instance.requestSave = previous;
		}
	};
}

/**
 * Subscribes to Bookmarks persistence via `changed` and `requestSave`.
 * Returns unsubscribe, or null when Bookmarks is unavailable.
 */
export function subscribeBookmarksChange(app: App, onChange: () => void): (() => void) | null {
	const instance = getBookmarksPluginInstance(app);
	if (!instance) {
		return null;
	}

	const unsubscribeSave = wrapBookmarksRequestSave(instance, onChange);
	let listeningToChanged = false;
	if (typeof instance.on === "function") {
		instance.on("changed", onChange);
		listeningToChanged = true;
	}

	return () => {
		unsubscribeSave();
		if (listeningToChanged && typeof instance.off === "function") {
			instance.off("changed", onChange);
		}
	};
}

/** Pure helper for tests: flatten nested bookmark-like items to file paths. */
export function collectBookmarkedFilePaths(items: readonly unknown[]): Set<string> {
	const paths = new Set<string>();
	collectFilePaths(items, paths);
	return paths;
}

/** Returns true when any file bookmark matches `path` (including nested groups). */
export function bookmarkTreeHasFile(items: readonly BookmarkItem[], path: string): boolean {
	return collectBookmarkedFilePaths(items).has(path);
}

function collectFileBookmarkItems(
	items: readonly unknown[],
	path: string,
	into: BookmarkItem[]
): void {
	for (const item of items) {
		if (!isRecord(item)) continue;
		const bookmark = item as BookmarkItem;
		if (bookmark.type === "file" && bookmark.path === path) {
			into.push(bookmark);
			continue;
		}
		if (bookmark.type === "group" && Array.isArray(bookmark.items)) {
			collectFileBookmarkItems(bookmark.items, path, into);
		}
	}
}

function persistBookmarkChange(instance: BookmarksPluginInstance): void {
	if (typeof instance.onItemsChanged === "function") {
		instance.onItemsChanged(true);
		return;
	}
	instance.requestSave?.();
}

/**
 * Removes all file bookmarks matching `path` from the tree (including nested groups).
 * Returns true if at least one entry was removed.
 */
export function removeFileBookmarks(items: BookmarkItem[], path: string): boolean {
	let removed = false;

	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item) continue;

		if (item.type === "file" && item.path === path) {
			items.splice(index, 1);
			removed = true;
			continue;
		}

		if (item.type === "group" && Array.isArray(item.items)) {
			if (removeFileBookmarks(item.items, path)) {
				removed = true;
			}
		}
	}

	return removed;
}

/**
 * Ensures a root-level file bookmark exists for `path`.
 * Returns true when a new entry was added.
 */
export function addRootFileBookmark(
	items: BookmarkItem[],
	path: string,
	ctime: number = Date.now()
): boolean {
	if (bookmarkTreeHasFile(items, path)) {
		return false;
	}
	items.push({ type: "file", path, ctime });
	return true;
}

/**
 * Toggles a file bookmark in Obsidian's core Bookmarks plugin.
 * Returns null when Bookmarks is unavailable.
 */
export function toggleFileBookmark(app: App, path: string): PinToggleResult | null {
	if (!path) {
		return null;
	}

	const instance = getBookmarksPluginInstance(app);
	if (!instance || !Array.isArray(instance.items)) {
		return null;
	}

	try {
		const items = instance.items;
		if (bookmarkTreeHasFile(items, path)) {
			const matches: BookmarkItem[] = [];
			collectFileBookmarkItems(items, path, matches);
			if (typeof instance.removeItem === "function") {
				for (const item of matches) {
					instance.removeItem(item);
				}
			}
			if (bookmarkTreeHasFile(items, path)) {
				removeFileBookmarks(items, path);
				persistBookmarkChange(instance);
			}
			return "unpinned";
		}

		if (typeof instance.addItem === "function") {
			instance.addItem({ type: "file", path, ctime: Date.now() });
		}
		if (!bookmarkTreeHasFile(items, path)) {
			addRootFileBookmark(items, path);
			persistBookmarkChange(instance);
		}
		return "pinned";
	} catch {
		return null;
	}
}
