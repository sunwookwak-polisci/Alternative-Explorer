import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "./constants";

describe("createDefaultSettings", () => {
	it("provides migration-safe defaults for integrated settings", () => {
		const settings = createDefaultSettings("");

		expect(settings.folderSortOverrides).toEqual({});
		expect(settings.noteSortOverrides).toEqual({});
		expect(settings.notesSubfoldersCollapsed).toBe(false);
		expect(settings.notesPinnedCollapsed).toBe(false);
	});
});
