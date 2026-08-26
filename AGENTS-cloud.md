# Alternative Explorer — cloud agent entry

Public operational instructions for agents working from the Git remote. If a local `AGENTS.md` exists, prefer it.

## Start work

1. Read this file.
2. Inspect `git status --short`, the relevant diff, remotes, and recent commits.
3. Read the implementation, tests, manifest, and relevant public documentation before editing.
4. Preserve unrelated changes and use current files as implementation truth.

## Knowledge ownership

| Kind | Source of truth |
|------|-----------------|
| Implementation behavior | TypeScript, CSS, configuration, and tests |
| User-facing behavior | `README.md` |
| Development workflow | `CONTRIBUTING.md` |
| Plugin identity and compatibility | `manifest.json` and `versions.json` |
| Package version and commands | `package.json` and lockfile |
| Release verification | `.github/workflows/attest-release.yml` |

Do not duplicate product facts in agent notes when they belong in tracked code, tests, or public documentation.

## Verified commands

```bash
npm ci
npm run lint
npm test
npm run build
npm audit
git diff --check
```

Do not edit generated `main.js` directly.

## Repository map

| Path | Role |
|------|------|
| `src/main.ts` | Plugin lifecycle, settings migration, persistence, and vault events |
| `src/view.ts` | Sidebar folder/file navigation and interaction behavior |
| `src/settings-tab.ts` | Default sorting settings |
| `src/sort-overrides.ts` | Per-folder and per-scope sort overrides |
| `src/smart-folders.ts` | Smart-folder rules and matching |
| `src/bookmarks.ts` | Guarded core Bookmarks integration |
| `src/file-openable.ts` | Supported-file and operating-system open behavior |
| `styles.css` | Obsidian-native presentation |
| `manifest.json` | Plugin identity and minimum Obsidian version |
| `README.md` | Community Plugins user documentation |
| `CONTRIBUTING.md` | Development and contribution guidance |

## Guardrails

- Keep plugin ID `alternative-explorer` stable.
- Keep package, lockfile, manifest, and versions mapping synchronized.
- Keep the README concise and user-facing; development material belongs in `CONTRIBUTING.md`.
- Preserve saved settings when schemas evolve.
- Keep Bookmarks and operating-system file opening guarded and fail closed when unavailable.
- Never add credentials, personal vault content, private contact details, or machine-specific paths to tracked files.
- Do not commit local agent files, handoffs, internal notes, copied release artifacts, or AE Demo Vault state.
- Do not change remotes, tags, releases, or Community Plugins metadata without explicit authorization.

## Completion checks

1. Run the relevant verified commands.
2. Review the complete scoped diff for unrelated changes, secrets, stale URLs, and local-only files.
3. Confirm metadata remains synchronized and report every check that was not run or did not pass.
