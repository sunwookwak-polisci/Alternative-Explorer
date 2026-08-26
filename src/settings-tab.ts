import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type AlternativeExplorerPlugin from "./main";
import type { FolderSortBy, FolderSortDir, NoteSortBy, NoteSortDir } from "./constants";

const FOLDER_SORT_OPTIONS: Record<FolderSortBy, string> = {
	name: "Name",
	mtime: "Modified",
	ctime: "Created",
	custom: "Custom",
};

const NOTE_SORT_OPTIONS: Record<NoteSortBy, string> = {
	name: "Name",
	mtime: "Modified",
	ctime: "Created",
};

const DIR_OPTIONS: Record<FolderSortDir & NoteSortDir, string> = {
	asc: "Ascending",
	desc: "Descending",
};

function hasOption<T extends string>(
	options: Record<T, string>,
	value: unknown
): value is T {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(options, value);
}

export class AlternativeExplorerSettingTab extends PluginSettingTab {
	plugin: AlternativeExplorerPlugin;

	constructor(app: App, plugin: AlternativeExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Obsidian 1.13+ renders and indexes these definitions for settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Default folder sort",
				items: [
					{
						name: "Sort folders by",
						desc: "Used for root folders and nested children unless a folder has its own sort override in the explorer.",
						control: {
							type: "dropdown",
							key: "folderSortBy",
							defaultValue: "name",
							options: FOLDER_SORT_OPTIONS,
						},
					},
					{
						name: "Folder sort direction",
						control: {
							type: "dropdown",
							key: "folderSortDir",
							defaultValue: "asc",
							options: DIR_OPTIONS,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Default file sort",
				items: [
					{
						name: "Sort files by",
						desc: "Used for all notes, folders, and smart folders unless that scope has its own sort override in the notes view.",
						control: {
							type: "dropdown",
							key: "sortBy",
							defaultValue: "name",
							options: NOTE_SORT_OPTIONS,
						},
					},
					{
						name: "File sort direction",
						control: {
							type: "dropdown",
							key: "sortDir",
							defaultValue: "asc",
							options: DIR_OPTIONS,
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case "folderSortBy":
				return this.plugin.settings.folderSortBy;
			case "folderSortDir":
				return this.plugin.settings.folderSortDir;
			case "sortBy":
				return this.plugin.settings.sortBy;
			case "sortDir":
				return this.plugin.settings.sortDir;
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "folderSortBy":
				if (hasOption(FOLDER_SORT_OPTIONS, value)) await this.setFolderSortBy(value);
				return;
			case "folderSortDir":
				if (hasOption(DIR_OPTIONS, value)) await this.setFolderSortDir(value);
				return;
			case "sortBy":
				if (hasOption(NOTE_SORT_OPTIONS, value)) await this.setNoteSortBy(value);
				return;
			case "sortDir":
				if (hasOption(DIR_OPTIONS, value)) await this.setNoteSortDir(value);
				return;
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName("Default folder sort").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Used for root folders and nested children unless a folder has its own sort override in the explorer.",
		});

		new Setting(containerEl)
			.setName("Sort folders by")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(FOLDER_SORT_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.folderSortBy);
				dropdown.onChange((value) => {
					void this.setFolderSortBy(value as FolderSortBy);
				});
			});

		new Setting(containerEl)
			.setName("Folder sort direction")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(DIR_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.folderSortDir);
				dropdown.onChange((value) => {
					void this.setFolderSortDir(value as FolderSortDir);
				});
			});

		new Setting(containerEl).setName("Default file sort").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Used for all notes, folders, and smart folders unless that scope has its own sort override in the notes view.",
		});

		new Setting(containerEl)
			.setName("Sort files by")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(NOTE_SORT_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.sortBy);
				dropdown.onChange((value) => {
					void this.setNoteSortBy(value as NoteSortBy);
				});
			});

		new Setting(containerEl)
			.setName("File sort direction")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(DIR_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.sortDir);
				dropdown.onChange((value) => {
					void this.setNoteSortDir(value as NoteSortDir);
				});
			});
	}

	private async setFolderSortBy(sortBy: FolderSortBy): Promise<void> {
		if (this.plugin.settings.folderSortBy === sortBy) return;
		this.plugin.settings.folderSortBy = sortBy;
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async setFolderSortDir(sortDir: FolderSortDir): Promise<void> {
		if (this.plugin.settings.folderSortDir === sortDir) return;
		this.plugin.settings.folderSortDir = sortDir;
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async setNoteSortBy(sortBy: NoteSortBy): Promise<void> {
		if (this.plugin.settings.sortBy === sortBy) return;
		this.plugin.settings.sortBy = sortBy;
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}

	private async setNoteSortDir(sortDir: NoteSortDir): Promise<void> {
		if (this.plugin.settings.sortDir === sortDir) return;
		this.plugin.settings.sortDir = sortDir;
		await this.plugin.saveSettings();
		this.plugin.refreshViews();
	}
}
