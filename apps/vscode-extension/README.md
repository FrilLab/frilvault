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
- Keep project knowledge inside `.vault`

## Note Viewer

FrilVault displays note content above associated source-code anchors in an expandable block format without modifying source files. It uses the supported VS Code CodeLens API: each visible note line is a stacked CodeLens row immediately above the anchor.

- **Collapsed State**: Displays a compact one-line summary (e.g., `▶ Note · 3 lines · #todo #parser` or `▶ Notes (2)`).
- **Expanded State**: Displays the multi-line note content, tags, and structure above the anchor line. Intentional line breaks are preserved.
- **Multiple Notes**: Grouped cleanly above the same anchor without visual duplication or overlapping widgets.
- **Actions**: Select `Actions…` in the viewer, hover the anchor, or use the gutter marker to open the existing View, Edit, Delete, Copy Link, Copy Content, and Copy Markdown actions.

CodeLens is the closest stable supported editor API for this UI. VS Code does not expose an extension-owned multiline block widget inside a normal text editor, so the expanded viewer is a set of dedicated CodeLens rows rather than a custom DOM overlay. Very long individual lines are shortened to keep the editor layout responsive; the full note remains available from hover and `Open Note`. Unresolved symbol anchors stay available in the sidebar and hover paths but are not assigned a guessed editor location.

### Viewer Differences

| UI Surface | Purpose |
| --- | --- |
| **Block Note Viewer** | Inline editor reading surface displayed above code anchors (expandable/collapsible) |
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
| `frilvault.vaultPath` | `string` | `""` | Optional vault directory; relative paths are resolved from `frilvault.workspaceRoot`, and empty uses automatic `.vault` discovery |

> **Note**: The legacy after-line inline preview settings (`frilvault.inlineNotes.*` and `frilvault.inlineLineNotes.*`) were removed. The plain-text preview helpers remain only where they are reused by supported hover/sidebar presentation paths.

## Commands

| Label | Command ID | Description |
| --- | --- | --- |
| `Add` | `frilvault.addNote` | Add a note at the current line or symbol |
| `Show Notes` | `frilvault.showNotesForCurrentFile` | Show notes for the active file |
| `Search Notes` | `frilvault.searchNotes` | Search notes in the current workspace |
| `Show Stats` | `frilvault.showStats` | Show workspace note statistics |
| `Show Health` | `frilvault.showHealth` | Show missing-file health information |
| `Apply Repairs` | `frilvault.applyRepairs` | Apply note repair suggestions for renamed or moved files |

The viewer also exposes `frilvault.noteViewer.toggle` and `frilvault.noteViewer.actions` through its CodeLens rows; these commands receive stable note IDs from the provider.

## Requirements

FrilVault ships with a bundled `flvt` CLI inside each platform-specific VSIX.

Supported packaged targets:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `win32-x64`

`frilvault.cliPath` is now an advanced override for custom builds.

When `frilvault.vaultPath` is empty, the extension and `flvt` use the same
nearest-existing `.vault` discovery from the workspace root through its
ancestors, falling back to the workspace-root `.vault`. An explicit vault path
is authoritative and is passed to every CLI operation; it is never replaced by
automatic discovery.

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
4. Select `Add` or use `Note Add` at the current editor line.
5. Enter a note in the inline editor.

## Commands

| Label | Command ID | Description |
| --- | --- | --- |
| `Add` | `frilvault.addNote` | Add a note at the current line or symbol |
| `Show Notes` | `frilvault.showNotesForCurrentFile` | Show notes for the active file |
| `Search Notes` | `frilvault.searchNotes` | Search notes in the current workspace |
| `Set Tag Color` | `frilvault.setTagColor` | Assign a theme-safe color from a tag's context menu |
| `Remove Tag Color` | `frilvault.removeTagColor` | Restore a tag's default uncolored appearance |
| `Show Stats` | `frilvault.showStats` | Show workspace note statistics |
| `Show Health` | `frilvault.showHealth` | Show missing-file health information |
| `Apply Repairs` | `frilvault.applyRepairs` | Apply note repair suggestions for renamed or moved files |

## Data Storage

FrilVault stores project data locally under the selected vault. With the default
configuration, that is:

```text
.vault/
```

No cloud account is required.

## Known Limitations

- FrilVault targets one workspace root at a time, so multi-root workspace support is limited
- The note viewer uses stacked CodeLens rows because normal editor decorations cannot provide a supported clickable multiline block layout
- Long individual viewer lines are shortened in the editor; hover and `Open Note` provide the complete content
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
