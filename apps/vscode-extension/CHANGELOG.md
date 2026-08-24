# Changelog

All notable changes to the FrilVault VS Code extension are documented here.

## Unreleased

### Added

- Expandable block note viewer displayed above associated code anchors with collapsed and expanded states
- Configuration settings `frilvault.noteViewer.enabled` and `frilvault.noteViewer.defaultState`

### Removed

- Legacy after-line inline note preview decorations and obsolete `frilvault.inlineNotes.*` / `frilvault.inlineLineNotes.*` settings

## 0.0.3 - 2026-07-27

### Added

- Note count badges for files and aggregated folders in the built-in Explorer
- A workspace note overview in `FrilVault Notes` when no editor file is active
- Folder and file note counts with direct file navigation from the notes view

### Changed

- Prefer line anchors when adding a note from a blank cursor line
- Use shorter command labels while keeping the `FrilVault Notes` view name explicit
- Label editor CodeLens actions as `Note Add` and `Note Edit`

### Fixed

- Workspace notes remaining stuck at `Loading workspace notes...`
- Missing `frilvault.notesPanel.openNote` command contribution
- Workspace note discovery now uses the vault explorer result instead of stale UI index state

## 0.0.2 - 2026-07-24

### Added

- Platform-specific VSIX packages for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`
- GitHub Release assets for manual VSIX installation

### Changed

- Bundle the `flvt` CLI into each platform-specific VSIX package
- Prefer the bundled CLI by default with a custom `frilvault.cliPath` override
- Publish GitHub Release assets and Marketplace packages through separate workflows

### Fixed

- Note creation on fresh installs that did not already have `flvt` on the system path
- Generic CLI startup failures now surface actionable runtime errors and output-channel diagnostics

## 0.0.1 - 2026-07-23

### Added

- Initial VS Code Marketplace release
- Line-anchored and symbol-anchored notes
- Inline note creation and editing
- Current-file notes view
- Workspace note search
- Gutter actions for viewing, editing, deleting, and copying note links
- Local JSON-based persistence through the FrilVault CLI

### Fixed

- Auto-save race conditions during active typing
- Save serialization for overlapping inline editor writes
- IME-aware auto-save behavior for in-progress composition
- Stale save completion handling for newer drafts

### Known limitations

- Targets one workspace root at a time in multi-root workspaces
- Early preview release
