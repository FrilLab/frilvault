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
├── env/
│   ├── manifest.toml
│   ├── recipients.toml
│   └── profiles/
│       └── <profile>.age
├── index/
└── workspace.json
```

- `.vault/notes`: persisted note files
- `.vault/env/manifest.toml`: environment profile schema and display metadata
- `.vault/env/recipients.toml`: environment profile recipient IDs and public age keys
- `.vault/env/profiles/<profile>.age`: versioned UTF-8 profile payload encrypted with age
- `.vault/index`: workspace index data
- `.vault/workspace.json`: workspace-level metadata

`frilvault-core` owns the encrypted profile storage boundary. Profile names are
validated as portable single path components, including Windows-invalid
characters, trailing spaces/dots, and reserved device names. Profile writes
create only ciphertext in a same-directory temporary file before atomically
replacing the target. The version-1 payload is JSON with `version` and a
key/value `values` map; unknown versions are rejected. Recipient and identity
material is supplied by callers and is never persisted by the core store.
Manifest and recipient metadata validation is owned by the environment-profile
integration work.

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
