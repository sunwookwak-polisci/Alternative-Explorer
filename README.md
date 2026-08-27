# Alternative Explorer

Alternative Explorer is an Apple Notes–style sidebar for browsing folders and notes in Obsidian. Switch between an expandable folder tree and a notes list — a compact alternative to the built-in File Explorer.

![Alternative Explorer showing a smart folder with pinned and date-grouped files](assets/alternative-explorer-demo.png)

## Folders

- Browse the folder tree, open **All notes** for a vault-wide list, and use **Reveal current note** to jump to the active note's folder.
- Each folder shows its note count on the right.
- Expand or fold the whole tree, including its sections, in one action.
- Group root folders into named, collapsible sections that exist only in this sidebar.
- Drag the grip on a section, folder, or smart folder to change sidebar order. Click a folder to open its notes. Drop a folder onto another folder, or back to the vault root, to nest or un-nest it in the vault.
- Sort folders by name, modified time, created time, or a custom order. Set the default in **Settings → Alternative Explorer**, and override it for an individual folder from the explorer.
- On a phone or tablet, you can use a custom folder order but you cannot rearrange it. Drag-to-reorder is desktop-only for now; a mobile way to edit custom order is planned.

## Notes

- Open a folder to see its notes, with immediate subfolders listed above. Toggle between this folder only and every note below it.
- Open **Display** in the notes toolbar to sort notes, sort subfolders, group by date, and group pinned notes. Override the default sort for a folder, a smart folder, or **All notes**.
- From a folder or smart folder, select **All notes** on the Folders back-nav row to open the vault-wide list.
- Move through the notes list with **Up** and **Down** to preview notes while keeping focus in the explorer, and press **Enter** to open the selection in the editor.
- Click a note to open it and move typing into the editor.
- Create a **New note** or **New folder** from the sidebar: at the vault root from the folder tree, or inside the folder you are viewing.

## Smart folders

- Create saved searches from rules for tags, properties, name, path, created or modified dates, and pinned status.
- Match all or any of the rules, and nest a smart folder under a real folder or a section.
- On a phone or tablet, use the overflow menu on a smart folder to edit rules, rename, move, or delete it.

![Smart folder rule editor filtering notes by a property](assets/alternative-explorer-smart-folder.png)

## Install and open

1. In Obsidian, open **Settings → Community plugins**.
2. Search for **Alternative Explorer**, select **Install**, and then select **Enable**.
3. Select the Alternative Explorer ribbon icon or run **Alternative Explorer: Open explorer view** from the command palette.

## Good to know

- Sections, smart folders, sidebar order, and sort overrides are stored in plugin settings. They do not create vault folders.
- Dropping a folder onto another folder, or a nested folder back to the vault root or a section, moves that folder in the vault.
- Pin notes through Obsidian's core Bookmarks plugin. If Bookmarks is disabled, pinned groups are empty and pinning is unavailable.
- Use **Alternative Explorer: Pin or unpin current note** to toggle a pin without opening the Bookmark editor. Bind it in **Settings → Hotkeys**. The core **Bookmark** command still opens the editor.
- Closing the Alternative Explorer tab returns to the folder list the next time you open it.
- The folder and notes toolbars stay visible while you scroll.
- Vault files that Obsidian cannot open appear in the notes list. A second click or **Enter** opens them in the system default application when available.
- Alternative Explorer does not search note contents, and it does not rename or delete existing notes.
- Alternative Explorer has been tested only on macOS, iOS, and iPadOS. Other platforms may work but have not been verified.
- The minimum supported Obsidian version is 1.7.2.

## Acknowledgements

Alternative Explorer was inspired by Apple Notes and [Notebook Navigator](https://notebooknavigator.com) ([GitHub](https://github.com/johansan/notebook-navigator)).

## License

Alternative Explorer is released under the [MIT License](LICENSE).
