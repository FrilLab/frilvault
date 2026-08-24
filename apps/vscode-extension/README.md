# FrilVault

FrilVault is a local-first developer knowledge layer that attaches persistent
notes to source code without modifying the source file.

## Features

- Add notes to source lines and symbols
- View notes directly inside VS Code
- Edit and delete notes from the editor
- Navigate between code and notes
- Search notes across the current workspace
- Store all note data locally as JSON
- Keep project knowledge inside `.vault`

## Requirements

FrilVault ships with a bundled `flvt` CLI inside each platform-specific VSIX.

Supported packaged targets:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `win32-x64`

`frilvault.cliPath` is now an advanced override for custom builds.

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

FrilVault stores project data locally under:

```text
.vault/
```

No cloud account is required.

## Known Limitations

- FrilVault targets one workspace root at a time, so multi-root workspace support is limited
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
