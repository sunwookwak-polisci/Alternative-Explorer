/**
 * Narrow Obsidian API fallback for isolated source-review environments.
 *
 * Normal development resolves `node_modules/obsidian/obsidian.d.ts` first via
 * tsconfig.json. This file is used only when a reviewer analyzes the source
 * without installing the official package. Keep it limited to APIs used here.
 */

interface DomElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string>;
}

interface Element {
	addClass(...classes: string[]): void;
	removeClass(...classes: string[]): void;
	toggleClass(className: string, value: boolean): void;
	hasClass(className: string): boolean;
	setAttr(name: string, value: string | number | boolean | null): void;
}

interface HTMLElement {
	empty(): void;
	createEl<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		options?: DomElementInfo
	): HTMLElementTagNameMap[K];
	createDiv(options?: DomElementInfo): HTMLDivElement;
	createSpan(options?: DomElementInfo): HTMLSpanElement;
	setText(text: string | DocumentFragment): void;
}

declare module "obsidian" {
	export interface EventRef {
		readonly fn: (...args: unknown[]) => unknown;
	}

	export interface FileStats {
		ctime: number;
		mtime: number;
		size: number;
	}

	export class TAbstractFile {
		vault: Vault;
		path: string;
		name: string;
		parent: TFolder | null;
	}

	export class TFile extends TAbstractFile {
		stat: FileStats;
		basename: string;
		extension: string;
	}

	export class TFolder extends TAbstractFile {
		children: TAbstractFile[];
		isRoot(): boolean;
	}

	export interface CachedMetadata {
		frontmatter?: unknown;
		tags?: Array<{ tag: string; position: unknown }>;
	}

	export class MetadataCache {
		getFileCache(file: TFile): CachedMetadata | null;
	}

	export class Vault {
		getRoot(): TFolder;
		getAbstractFileByPath(path: string): TAbstractFile | null;
		create(path: string, data: string): Promise<TFile>;
		createFolder(path: string): Promise<TFolder>;
		on(name: "create" | "delete" | "modify", callback: (file: TAbstractFile) => unknown): EventRef;
		on(
			name: "rename",
			callback: (file: TAbstractFile, oldPath: string) => unknown
		): EventRef;
	}

	export class FileManager {
		renameFile(file: TAbstractFile, newPath: string): Promise<void>;
	}

	export interface ViewState {
		type?: string;
		active?: boolean;
		pinned?: boolean;
		state?: unknown;
	}

	export class WorkspaceSplit {}

	export class WorkspaceLeaf {
		view: ItemView;
		setViewState(state: ViewState): Promise<void>;
		getViewState(): ViewState;
		openFile(file: TFile, options?: { active?: boolean }): Promise<void>;
	}

	export class Workspace {
		rootSplit: WorkspaceSplit;
		getLeavesOfType(type: string): WorkspaceLeaf[];
		getLeftLeaf(split: boolean): WorkspaceLeaf | null;
		getLeaf(newLeaf: boolean): WorkspaceLeaf;
		getMostRecentLeaf(root?: WorkspaceSplit): WorkspaceLeaf | null;
		getActiveFile(): TFile | null;
		setActiveLeaf(leaf: WorkspaceLeaf, options?: { focus?: boolean }): void;
		revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
		onLayoutReady(callback: () => unknown): void;
		on(name: "file-open", callback: (file: TFile | null) => unknown): EventRef;
	}

	export class Scope {
		constructor(parent?: Scope);
		register(
			modifiers: string[],
			key: string,
			callback: (event: KeyboardEvent) => boolean | void
		): void;
	}

	export class App {
		vault: Vault;
		workspace: Workspace;
		metadataCache: MetadataCache;
		fileManager: FileManager;
		scope: Scope;
	}

	export class Component {
		register(callback: () => unknown): void;
		registerEvent(eventRef: EventRef): void;
		registerInterval(id: number): number;
		registerDomEvent<K extends keyof HTMLElementEventMap>(
			element: HTMLElement,
			type: K,
			callback: (event: HTMLElementEventMap[K]) => unknown
		): void;
	}

	export interface Command {
		id: string;
		name: string;
		callback?: () => unknown;
		checkCallback?: (checking: boolean) => boolean | void;
	}

	export class Plugin extends Component {
		app: App;
		loadData(): Promise<unknown>;
		saveData(data: unknown): Promise<void>;
		registerView(type: string, creator: (leaf: WorkspaceLeaf) => ItemView): void;
		addRibbonIcon(icon: string, title: string, callback: () => unknown): HTMLElement;
		addCommand(command: Command): void;
		addSettingTab(settingTab: PluginSettingTab): void;
	}

	export class ItemView extends Component {
		constructor(leaf: WorkspaceLeaf);
		app: App;
		leaf: WorkspaceLeaf;
		contentEl: HTMLElement;
		containerEl: HTMLElement;
		scope: Scope | null;
		getViewType(): string;
		getDisplayText(): string;
		getIcon(): string;
		onOpen(): Promise<void>;
		onClose(): Promise<void>;
	}

	export class Modal extends Component {
		constructor(app: App);
		app: App;
		contentEl: HTMLElement;
		setTitle(title: string): this;
		open(): void;
		close(): void;
		onOpen(): void;
		onClose(): void;
	}

	export class ButtonComponent {
		buttonEl: HTMLButtonElement;
		setButtonText(text: string): this;
		setCta(): this;
		onClick(callback: (event: MouseEvent) => unknown): this;
	}

	export class ExtraButtonComponent {
		extraSettingsEl: HTMLElement;
		setIcon(icon: string): this;
		setTooltip(tooltip: string): this;
		setDisabled(disabled: boolean): this;
		onClick(callback: (event: MouseEvent) => unknown): this;
	}

	export class DropdownComponent {
		selectEl: HTMLSelectElement;
		addOption(value: string, display: string): this;
		setValue(value: string): this;
		onChange(callback: (value: string) => unknown): this;
	}

	export class TextComponent {
		inputEl: HTMLInputElement;
		setPlaceholder(placeholder: string): this;
		setValue(value: string): this;
		onChange(callback: (value: string) => unknown): this;
	}

	export class Setting {
		constructor(containerEl: HTMLElement);
		setName(name: string | DocumentFragment): this;
		setDesc(desc: string | DocumentFragment): this;
		setHeading(): this;
		setClass(className: string): this;
		addButton(callback: (component: ButtonComponent) => unknown): this;
		addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this;
		addDropdown(callback: (component: DropdownComponent) => unknown): this;
		addText(callback: (component: TextComponent) => unknown): this;
	}

	export interface SettingControlDefinition {
		type: "dropdown";
		key: string;
		defaultValue?: string;
		options: Record<string, string>;
	}

	export interface SettingDefinition {
		name: string;
		desc?: string | DocumentFragment;
		control?: SettingControlDefinition;
	}

	export interface SettingDefinitionGroup {
		type: "group";
		heading?: string;
		items?: SettingDefinition[];
	}

	export type SettingDefinitionItem = SettingDefinition | SettingDefinitionGroup;

	export class PluginSettingTab extends Component {
		constructor(app: App, plugin: Plugin);
		app: App;
		plugin: Plugin;
		containerEl: HTMLElement;
		getSettingDefinitions(): SettingDefinitionItem[];
		getControlValue(key: string): unknown;
		setControlValue(key: string, value: unknown): void | Promise<void>;
		display(): void;
	}

	export const Platform: {
		isMobile: boolean;
	};

	export class MenuItem {
		setTitle(title: string | DocumentFragment): this;
		setIcon(icon: string | null): this;
		setChecked(checked: boolean): this;
		setDisabled(disabled: boolean): this;
		onClick(callback: (event: MouseEvent) => unknown): this;
	}

	export class Menu {
		static forEvent(event: MouseEvent): Menu;
		addItem(callback: (item: MenuItem) => unknown): this;
		addSeparator(): this;
		showAtPosition(position: { x: number; y: number }): void;
	}

	export class Notice {
		constructor(message: string | DocumentFragment, timeout?: number);
	}

	export interface MomentLike {
		format(format: string): string;
		toISOString(): string;
	}

	export function moment(value: number): MomentLike;
	export function getAllTags(cache: CachedMetadata): string[] | null;
	export function setIcon(parent: HTMLElement, iconId: string): void;
}
