# FrilVault

FrilVault is a local-first developer knowledge layer that attaches persistent
notes to source code without modifying the source file.

## Features

- Add notes to source lines and symbols
- View notes directly inside VS Code with expandable CodeLens viewers above code anchors
- Edit and delete notes from the editor
- Navigate between code and notes
- Search notes across the current workspace
- Store all note data locally as JSON
- Keep note data in the selected Local or Shared vault

## Environment Manager

The `FrilVault Environments` view uses the native VS Code Tree View, Quick Pick,
and Input Box APIs to manage encrypted environment profiles through the
existing `flvt` CLI. It shows profile readiness and manifest metadata without
displaying environment values. Secret values are entered through a masked
Input Box and sent to the CLI over stdin; they are not placed in command
arguments or extension logs.

The displayed scope follows the Vault mode: Local is shown as this-machine and
Shared as project-shared. This describes profile availability; values are
injected only into a child started with `Run with Environment Profile`.

Project dotenv files are listed as discovered sources only. They are never
read or imported automatically. Select `Import Dotenv File` to explicitly copy
the parsed values into an encrypted profile; the source file is preserved.

`Run with Environment Profile` launches the selected child through `flvt env
run`, so the environment is injected only into that child process and the
extension does not decrypt or persist values itself.

## Note Viewer

FrilVault displays note content above associated source-code anchors without modifying source files. It uses the supported VS Code CodeLens API to show a compact, single-line summary or preview above each anchor; CodeLens does not support a multiline block inside the editor.

- **Collapsed State**: Displays a compact one-line summary (e.g., `▶ Note · 3 lines · #todo #parser` or `▶ Notes (2)`).
- **Expanded State**: Displays a compact preview of the note content and tags above the anchor line. Whitespace is flattened and long previews are shortened; the full note remains available from hover and `Open Note`.
- **Multiple Notes**: Grouped cleanly above the same anchor without visual duplication or overlapping widgets.
- **Actions**: Select `Actions…` in the viewer, hover the anchor, or use the gutter marker to open the existing View, Edit, Delete, Copy Link, Copy Content, and Copy Markdown actions.

CodeLens is the closest stable supported editor API for this UI. Unresolved symbol anchors stay available in the sidebar and hover paths but are not assigned a guessed editor location.

### Viewer Differences

| UI Surface | Purpose |
| --- | --- |
| **CodeLens Note Preview** | Compact editor preview displayed above code anchors (expandable/collapsible) |
| **Gutter Markers** | Interactive line indicators showing where notes exist and quick action menus |
| **Hover Preview** | Rich documentation popup on cursor hover with full markdown, tags, and actions |
| **Notes Sidebar** | Workspace-wide and file-level tree navigation for browsing all notes |

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `frilvault.noteViewer.enabled` | `boolean` | `true` | Show CodeLens note viewers above associated source-code anchors |
| `frilvault.noteViewer.defaultState` | `string` | `"collapsed"` | Default collapse state for note viewers (`"collapsed"` or `"expanded"`) |
| `frilvault.gutterMarkerStyle` | `string` | `"dot"` | Visual style for interactive gutter markers (`"dot"`, `"count"`, `"bar"`) |
| `frilvault.explorerNoteCounts.enabled` | `boolean` | `true` | Show FrilVault note counts beside files in VS Code Explorer |
| `frilvault.hoverPreviewLength` | `number` | `800` | Maximum character length for rich hover previews |
| `frilvault.inlineEditor.autoSaveDebounceMs` | `number` | `900` | Delay in milliseconds before auto-saving note edits |
| `frilvault.workspaceRoot` | `string` | `""` | Workspace root used by FrilVault; empty uses the first VS Code workspace folder |
| `frilvault.vaultPath` | `string` | `""` | Optional explicit vault directory; relative paths are resolved from `frilvault.workspaceRoot`, and empty discovers an existing vault or uses the selected initialization policy |

> **Note**: The legacy after-line inline preview settings (`frilvault.inlineNotes.*` and `frilvault.inlineLineNotes.*`) were removed. The plain-text preview helpers remain only where they are reused by supported hover/sidebar presentation paths.

## Commands

| Label | Command ID | Description |
| --- | --- | --- |
| `Add` | `frilvault.addNote` | Add a note at the current line or symbol |
| `Show Notes` | `frilvault.showNotesForCurrentFile` | Show notes for the active file |
| `Search Notes` | `frilvault.searchNotes` | Search notes in the current workspace with the native Quick Pick |
| `Show Stats` | `frilvault.showStats` | Show workspace note statistics |
| `Show Health` | `frilvault.showHealth` | Show missing-file health information |
| `Apply Repairs` | `frilvault.applyRepairs` | Apply note repair suggestions for renamed or moved files |
| `Add Environment Variable` | `frilvault.environment.addVariable` | Add a declared variable through masked input and CLI stdin |
| `Replace Environment Value` | `frilvault.environment.replaceValue` | Replace a profile value without displaying it |
| `Import Dotenv File` | `frilvault.environment.import` | Explicitly import a discovered dotenv file into a profile |
| `Run with Environment Profile` | `frilvault.environment.run` | Launch a direct child command with a profile injected by the CLI |

The viewer also exposes `frilvault.noteViewer.toggle` and `frilvault.noteViewer.actions` through its CodeLens rows; these commands receive stable note IDs from the provider.

### Search syntax

`Search Notes` searches while you type and keeps the source editor layout unchanged. Plain text searches note content and symbol names. Add filters to narrow the same query:

```text
parser cache
tag:todo
file:src/parser.rs
symbol:parse_config
tag:todo parser
file:src/core tag:architecture
```

Select a result to open the source file and reveal its line or symbol anchor. Results are labeled as FrilVault notes and unresolved symbol anchors are shown as metadata rather than source diagnostics.

## Requirements

FrilVault ships with a bundled `flvt` CLI inside each platform-specific VSIX.

Supported packaged targets:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `win32-x64`

`frilvault.cliPath` is now an advanced override for custom builds.

When `frilvault.vaultPath` is empty, the extension asks Core through `flvt`
for the selected vault. A new Local vault in a Git checkout lives under that
checkout's Git metadata directory; a new Shared vault uses project-root
`.vault/`. Non-Git Local projects keep project-root `.vault/`. Existing
workspace-root `.vault/` data stays in place with its stored mode, and if it
coexists with another valid vault the extension asks you to choose a path.

Local/Shared selects the storage policy. `frilvault.vaultPath` or CLI
`--vault PATH` selects only the storage location; an explicit path does not
infer a mode. The extension passes it to each CLI operation. Opening a project,
activating the extension, and refreshing views do not create a vault. Select
`Enable` and then an initialization option to create one.

## Install

You can install FrilVault in either of these ways:

1. Visual Studio Marketplace
2. GitHub Release VSIX

Marketplace users do not choose a platform manually. The Marketplace serves the matching package for the current operating system and CPU architecture.

If you install from GitHub Release, download the matching VSIX and use `Extensions: Install from VSIX...` in VS Code.

## Release And Publish

Release automation is split into two stages:

1. `release.yml` builds platform-specific VSIX files and attaches them to a published GitHub Release.
2. `publish.yml` is run manually when you want to publish those VSIX files to the Visual Studio Marketplace.

`publish.yml` uses `VSCE_PAT` and publishes the existing Release assets to the single Marketplace listing.

## Getting Started

1. Install the FrilVault extension.
2. Open a project in VS Code.
3. Open `FrilVault Notes` in the Explorer and select `Enable`.
4. Choose `Initialize Local Vault` or `Initialize Shared Vault` when prompted.
5. Select `Add` or use `Note Add` at the current editor line.
6. Enter a note in the inline editor.

## Commands

| Label | Command ID | Description |
| --- | --- | --- |
| `Add` | `frilvault.addNote` | Add a note at the current line or symbol |
| `Show Notes` | `frilvault.showNotesForCurrentFile` | Show notes for the active file |
| `Search Notes` | `frilvault.searchNotes` | Search notes in the current workspace with native Quick Pick search |
| `Set Tag Color` | `frilvault.setTagColor` | Assign a theme-safe color from a tag's context menu |
| `Remove Tag Color` | `frilvault.removeTagColor` | Restore a tag's default uncolored appearance |
| `Show Stats` | `frilvault.showStats` | Show workspace note statistics |
| `Show Health` | `frilvault.showHealth` | Show missing-file health information |
| `Apply Repairs` | `frilvault.applyRepairs` | Apply note repair suggestions for renamed or moved files |

## Data Storage

FrilVault stores project data locally under the selected vault. A new Local
vault in a Git checkout is stored in that checkout's Git metadata at
`frilvault/vaults/<workspace-relative-path>/`. A new Shared vault is stored in
the project-root `.vault/`. Non-Git Local projects keep the `.vault/` layout.
An existing project-root `.vault/` remains in place and is never moved based on
its mode. An explicit path can select an external vault for either mode.

The Shared vault's project-root layout is:

```text
.vault/
```

No cloud account is required.

## Known Limitations

- FrilVault targets one workspace root at a time, so multi-root workspace support is limited
- CodeLens previews flatten whitespace and shorten long content; hover and `Open Note` provide the complete content
- This is an early preview release

## Roadmap

- Improve multi-root workspace behavior
- Expand editor UX for symbol-anchored notes

## Privacy

FrilVault does not upload source code or note content to an external service.

## Issues

Report bugs and feature requests through the GitHub issue tracker:

https://github.com/FrilLab/frilvault/issues

## License

MIT
