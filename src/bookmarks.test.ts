import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
	addRootFileBookmark,
	bookmarkPathsFingerprint,
	bookmarkTreeHasFile,
	collectBookmarkedFilePaths,
	getBookmarkedFilePaths,
	removeFileBookmarks,
	subscribeBookmarksChange,
	toggleFileBookmark,
	wrapBookmarksRequestSave,
	type BookmarkItem,
	type BookmarksPluginInstance,
} from "./bookmarks";

function fakeApp(instance: BookmarksPluginInstance | null): App {
	return {
		internalPlugins: {
			getEnabledPluginById: (id: string) => (id === "bookmarks" ? instance : null),
		},
	} as unknown as App;
}

describe("collectBookmarkedFilePaths", () => {
	it("collects nested file bookmarks and ignores non-file entries", () => {
		const paths = collectBookmarkedFilePaths([
			{ type: "file", path: "Inbox/a.md" },
			{ type: "folder", path: "Projects" },
			{
				type: "group",
				items: [
					{ type: "file", path: "Pinned/b.md" },
					{ type: "search", query: "todo" },
					{
						type: "group",
						items: [{ type: "file", path: "Pinned/c.md" }],
					},
				],
			},
			{ type: "file" },
		]);

		expect(Array.from(paths).sort()).toEqual(["Inbox/a.md", "Pinned/b.md", "Pinned/c.md"]);
	});
});

describe("bookmarkPathsFingerprint", () => {
	it("is order-independent and stable for the same set", () => {
		expect(bookmarkPathsFingerprint(new Set(["b.md", "a.md"]))).toBe(
			bookmarkPathsFingerprint(new Set(["a.md", "b.md"]))
		);
		expect(bookmarkPathsFingerprint(new Set(["a.md"]))).not.toBe(
			bookmarkPathsFingerprint(new Set(["a.md", "b.md"]))
		);
	});
});

describe("wrapBookmarksRequestSave", () => {
	it("notifies on requestSave and restores the original on unsubscribe", () => {
		const original = vi.fn();
		const instance: BookmarksPluginInstance = { items: [], requestSave: original };
		const onChange = vi.fn();

		const unsubscribe = wrapBookmarksRequestSave(instance, onChange);
		instance.requestSave?.();

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(original).toHaveBeenCalledTimes(1);

		unsubscribe();
		instance.requestSave?.();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(original).toHaveBeenCalledTimes(2);
	});

	it("removes requestSave when none existed before wrapping", () => {
		const instance: BookmarksPluginInstance = { items: [] };
		const onChange = vi.fn();
		const unsubscribe = wrapBookmarksRequestSave(instance, onChange);

		expect(typeof instance.requestSave).toBe("function");
		instance.requestSave?.();
		expect(onChange).toHaveBeenCalledTimes(1);

		unsubscribe();
		expect(instance.requestSave).toBeUndefined();
	});
});

describe("addRootFileBookmark", () => {
	it("adds a root-level file bookmark", () => {
		const items: BookmarkItem[] = [{ type: "folder", path: "Projects" }];
		expect(addRootFileBookmark(items, "Notes/a.md", 123)).toBe(true);
		expect(items).toEqual([
			{ type: "folder", path: "Projects" },
			{ type: "file", path: "Notes/a.md", ctime: 123 },
		]);
	});

	it("is idempotent when the file is already bookmarked anywhere", () => {
		const items: BookmarkItem[] = [
			{
				type: "group",
				items: [{ type: "file", path: "Notes/a.md", ctime: 1 }],
			},
		];
		expect(addRootFileBookmark(items, "Notes/a.md", 99)).toBe(false);
		expect(items).toHaveLength(1);
		expect(bookmarkTreeHasFile(items, "Notes/a.md")).toBe(true);
	});
});

describe("removeFileBookmarks", () => {
	it("removes root and nested file bookmarks for a path", () => {
		const items: BookmarkItem[] = [
			{ type: "file", path: "Notes/a.md", ctime: 1 },
			{ type: "folder", path: "Projects" },
			{
				type: "group",
				title: "Pinned",
				items: [
					{ type: "file", path: "Notes/a.md", ctime: 2 },
					{ type: "file", path: "Notes/b.md", ctime: 3 },
					{
						type: "group",
						items: [{ type: "file", path: "Notes/a.md", ctime: 4 }],
					},
				],
			},
		];

		expect(removeFileBookmarks(items, "Notes/a.md")).toBe(true);
		expect(collectBookmarkedFilePaths(items)).toEqual(new Set(["Notes/b.md"]));
		expect(items).toEqual([
			{ type: "folder", path: "Projects" },
			{
				type: "group",
				title: "Pinned",
				items: [
					{ type: "file", path: "Notes/b.md", ctime: 3 },
					{ type: "group", items: [] },
				],
			},
		]);
	});

	it("returns false and leaves non-matching entries alone", () => {
		const items: BookmarkItem[] = [
			{ type: "file", path: "Notes/b.md", ctime: 1 },
			{ type: "search", query: "todo" },
		];
		expect(removeFileBookmarks(items, "Notes/a.md")).toBe(false);
		expect(items).toEqual([
			{ type: "file", path: "Notes/b.md", ctime: 1 },
			{ type: "search", query: "todo" },
		]);
	});
});

describe("getBookmarkedFilePaths", () => {
	it("reads instance.items even when getBookmarks returns a different list", () => {
		const items: BookmarkItem[] = [{ type: "file", path: "Notes/a.md" }];
		const instance: BookmarksPluginInstance = {
			items,
			getBookmarks: () => [{ type: "file", path: "Notes/b.md" }],
		};

		expect(getBookmarkedFilePaths(fakeApp(instance))).toEqual(new Set(["Notes/a.md"]));
	});

	it("falls back to getBookmarks when items is missing", () => {
		const instance: BookmarksPluginInstance = {
			getBookmarks: () => [{ type: "file", path: "Notes/b.md" }],
		};

		expect(getBookmarkedFilePaths(fakeApp(instance))).toEqual(new Set(["Notes/b.md"]));
	});
});

describe("toggleFileBookmark", () => {
	it("pins a file that is not yet bookmarked", () => {
		const items: BookmarkItem[] = [];
		const requestSave = vi.fn();
		const result = toggleFileBookmark(fakeApp({ items, requestSave }), "Notes/a.md");

		expect(result).toBe("pinned");
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("file");
		expect(items[0]?.path).toBe("Notes/a.md");
		expect(typeof items[0]?.ctime).toBe("number");
		expect(requestSave).toHaveBeenCalledTimes(1);
		expect(bookmarkTreeHasFile(items, "Notes/a.md")).toBe(true);
	});

	it("unpins a root bookmark", () => {
		const items: BookmarkItem[] = [{ type: "file", path: "Notes/a.md", ctime: 1 }];
		const requestSave = vi.fn();
		const result = toggleFileBookmark(fakeApp({ items, requestSave }), "Notes/a.md");

		expect(result).toBe("unpinned");
		expect(items).toEqual([]);
		expect(requestSave).toHaveBeenCalledTimes(1);
	});

	it("unpins a nested bookmark instead of adding a duplicate root entry", () => {
		const items: BookmarkItem[] = [
			{
				type: "group",
				items: [{ type: "file", path: "Notes/a.md", ctime: 1 }],
			},
		];
		const requestSave = vi.fn();
		const result = toggleFileBookmark(fakeApp({ items, requestSave }), "Notes/a.md");

		expect(result).toBe("unpinned");
		expect(bookmarkTreeHasFile(items, "Notes/a.md")).toBe(false);
		expect(items).toEqual([{ type: "group", items: [] }]);
		expect(requestSave).toHaveBeenCalledTimes(1);
	});

	it("returns null when items is missing", () => {
		const instance: BookmarksPluginInstance = {
			getBookmarks: () => [{ type: "file", path: "Notes/a.md" }],
		};

		expect(toggleFileBookmark(fakeApp(instance), "Notes/a.md")).toBeNull();
	});

	it("returns null for an empty path", () => {
		expect(toggleFileBookmark(fakeApp({ items: [] }), "")).toBeNull();
	});

	it("unpins through removeItem so Bookmarks can refresh its view", () => {
		const item: BookmarkItem = { type: "file", path: "Notes/a.md", ctime: 1 };
		const items: BookmarkItem[] = [item];
		const removeItem = vi.fn((target: BookmarkItem) => {
			const index = items.indexOf(target);
			if (index >= 0) items.splice(index, 1);
		});
		const requestSave = vi.fn();
		const onItemsChanged = vi.fn();

		expect(toggleFileBookmark(fakeApp({ items, removeItem, requestSave, onItemsChanged }), "Notes/a.md")).toBe(
			"unpinned"
		);
		expect(removeItem).toHaveBeenCalledWith(item);
		expect(items).toEqual([]);
		expect(requestSave).not.toHaveBeenCalled();
		expect(onItemsChanged).not.toHaveBeenCalled();
	});

	it("pins through addItem so Bookmarks can refresh its view", () => {
		const items: BookmarkItem[] = [];
		const addItem = vi.fn((item: BookmarkItem) => {
			items.push(item);
		});
		const requestSave = vi.fn();
		const onItemsChanged = vi.fn();

		expect(toggleFileBookmark(fakeApp({ items, addItem, requestSave, onItemsChanged }), "Notes/a.md")).toBe(
			"pinned"
		);
		expect(addItem).toHaveBeenCalledTimes(1);
		expect(addItem.mock.calls[0]?.[0]).toMatchObject({ type: "file", path: "Notes/a.md" });
		expect(requestSave).not.toHaveBeenCalled();
		expect(onItemsChanged).not.toHaveBeenCalled();
	});

	it("falls back to splicing nested items and notifying onItemsChanged", () => {
		const items: BookmarkItem[] = [
			{
				type: "group",
				items: [{ type: "file", path: "Notes/a.md", ctime: 1 }],
			},
		];
		const onItemsChanged = vi.fn();
		const requestSave = vi.fn();

		expect(toggleFileBookmark(fakeApp({ items, onItemsChanged, requestSave }), "Notes/a.md")).toBe(
			"unpinned"
		);
		expect(bookmarkTreeHasFile(items, "Notes/a.md")).toBe(false);
		expect(onItemsChanged).toHaveBeenCalledWith(true);
		expect(requestSave).not.toHaveBeenCalled();
	});

	it("falls back to splice when removeItem leaves the file in the tree", () => {
		const items: BookmarkItem[] = [
			{
				type: "group",
				items: [{ type: "file", path: "Notes/a.md", ctime: 1 }],
			},
		];
		const removeItem = vi.fn();
		const onItemsChanged = vi.fn();

		expect(toggleFileBookmark(fakeApp({ items, removeItem, onItemsChanged }), "Notes/a.md")).toBe(
			"unpinned"
		);
		expect(removeItem).toHaveBeenCalledTimes(1);
		expect(bookmarkTreeHasFile(items, "Notes/a.md")).toBe(false);
		expect(onItemsChanged).toHaveBeenCalledWith(true);
	});
});

describe("subscribeBookmarksChange", () => {
	it("notifies on the Bookmarks changed event", () => {
		const listeners = new Set<() => void>();
		const instance: BookmarksPluginInstance = {
			items: [],
			on: vi.fn((name: string, callback: () => void) => {
				if (name === "changed") listeners.add(callback);
			}),
			off: vi.fn((name: string, callback: () => void) => {
				if (name === "changed") listeners.delete(callback);
			}),
		};
		const onChange = vi.fn();
		const unsubscribe = subscribeBookmarksChange(fakeApp(instance), onChange);

		for (const listener of listeners) listener();
		expect(onChange).toHaveBeenCalledTimes(1);

		unsubscribe?.();
		expect(instance.off).toHaveBeenCalledWith("changed", onChange);
	});
});
