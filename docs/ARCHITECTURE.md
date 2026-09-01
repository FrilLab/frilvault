# FrilVault Architecture

## Overview

FrilVault is organized around a shared Rust core and thin integration surfaces.

```text
.
├── AGENTS.md
├── apps/
│   ├── frilvault-cli
│   └── vscode-extension
├── crates/
│   └── frilvault-core
└── docs/
```

- `crates/frilvault-core`: note model, repositories, services, runtime helpers
- `apps/frilvault-cli`: `flvt` command-line interface
- `apps/vscode-extension`: current editor integration
- `docs/`: architecture, workflow, testing, and release guidance

The current repository does not contain a desktop application source tree yet. Release and workflow documents may still refer to future desktop release work, but the active code surfaces in this checkout are the Rust core, CLI, and VS Code extension.

## Core Principles

- FrilVault is local-first. Notes and metadata stay inside the selected vault.
- FrilVault does not modify source files.
- Business logic should live in `frilvault-core`.
- Editor and CLI layers should stay thin.

## Storage Model

```text
<vault-root>/
├── notes/
├── index/
└── workspace.json
```

- `<vault-root>/notes`: persisted note files
- `<vault-root>/index`: workspace index data
- `<vault-root>/workspace.json`: workspace-level metadata

### Workspace and vault roots

`PathResolver` keeps the source workspace root and the vault root as separate
values. Source files, anchors, repairs, and note URIs are relative to the
workspace root; note JSON, indexes, attachments, and metadata are relative to
the vault root. An external vault therefore never changes the source-relative
path stored in a note.

Vault selection follows one contract for the CLI and editor integrations:

1. An explicit path (`flvt --vault PATH` or `frilvault.vaultPath`) is
   authoritative. Relative paths are resolved from the workspace root. A
   missing or invalid explicit path is reported as an error and never falls
   back to another `.vault`.
2. Without an explicit path, the resolver checks the current directory and
   then its ancestors for the nearest existing `.vault`. This gives a nested
   workspace priority over a project-root vault while preserving the existing
   project-root `.vault` behavior.
3. If discovery finds nothing, the workspace-root `.vault` remains the target
   for a new vault.

The vault location does not select `VaultMode`. Local and Shared are persisted
independently in the selected vault's `workspace.json`; a legacy metadata file
without `mode` still defaults to Local.

### Vault modes

`frilvault-core` owns the `VaultMode` policy used by workspace initialization:

- `Local` is the default for a new workspace. `flvt init` creates a Local vault
  and, when the selected vault is in a Git repository, adds its relative path to the
  repository-local `.git/info/exclude`.
- `Shared` is opt-in for a new workspace. `flvt init --shared` creates a Shared
  vault and does not add a local exclude rule, leaving the vault trackable by
  Git.

Neither initialization path modifies the shared `.gitignore` file. Local mode
uses `.git/info/exclude` specifically so a private vault does not require a
project-wide ignore-file change. A pre-existing Git rule or an already tracked
vault can still affect the resulting Git state.

The selected mode is serialized as the top-level `mode` field in
`<vault-root>/workspace.json`, using the lowercase values `"local"` and `"shared"`.
`WorkspaceMetadata` defaults a missing field to Local so legacy workspace
metadata remains readable. Re-initializing an existing workspace loads and
preserves its metadata, including its current mode; initialization does not
provide a mode-switch or migration operation.

The CLI presents this core policy in its text output (`Mode: local` or
`Mode: shared`) and `flvt status` reports the persisted mode alongside the
current Git tracking state.

## Runtime Shape

`VaultContext` is the current runtime container inside `frilvault-core`.

It currently owns:

- `NoteRepository`
- `WorkspaceIndexRepository`
- `NoteCache`

Its job is to centralize cache-aware note loading, index rebuild helpers, and workspace scans.

## Current Boundaries

### `frilvault-core`

The core crate owns:

- note CRUD
- note attachments
- note search
- note query and explorer DTOs
- note URI parsing and resolution
- symbol resolution helpers
- workspace stats and health
- workspace sync and gitignore helpers
- repair suggestions and repair application
- `.vault` persistence

### `frilvault-cli`

The CLI is the primary executable surface today.

- parses commands
- opens the workspace
- calls the `FrilVault` facade
- prints human or JSON output

### `apps/vscode-extension`

The VS Code extension is the current editor-facing integration.

Current feature scope:

- add note
- current-file and workspace notes panel
- built-in Explorer note count decorations
- gutter decorations
- gutter actions
- note edit and delete
- inline note editor
- expandable CodeLens note viewer above line and resolved symbol anchors
- CodeLens note creation and edit actions
- search
- note URI handling
- workspace stats
- workspace health
- repair apply
- workspace rename and watcher hooks
- workspace enable/disable state
- gitignore prompt on first persisted note flow

The note viewer uses `vscode.languages.registerCodeLensProvider` rather than
`TextEditorDecorationOptions.before`. CodeLens is the supported API that gives
extensions dedicated horizontal rows between source lines and command
arguments. An expanded note is therefore represented by stacked rows; VS Code
does not expose a supported extension-owned multiline block widget in a normal
text editor. Source documents remain read-only from the viewer's perspective.

Its active backend is currently CLI-backed:

- add note
- notes panel
- gutter decorations
- inline editor mutations
- search
- stats
- health
- repair
- URI resolution
- workspace sync and rename-related flows

The `frilvault.addNote` command and the create-here flow both currently route through the inline editor path.

## Known Architectural Reality

The runtime boundary exists, but the project is still consolidating around shared core behavior.

- `NoteService` uses `VaultContext` for cache-aware file note loading
- note mutations still write through repositories stored inside the context
- note search still scans persisted note files directly
- `WorkspaceService` still keeps its own `WorkspaceIndexRepository` field
- the extension now centralizes current-file note state through a shared store, but its active behavior still shells out through the CLI boundary

That is acceptable for the current MVP, but it means the runtime layer is only partially unified.

## Current Risks

The following limitations remain important to release readiness:

- the extension targets one workspace root at a time
- extension integration tests require a working VS Code Electron test host
- the CLI boundary and UI caches must be invalidated together after note mutations
