# FrilVault Architecture

## Overview

FrilVault is organized around a shared Rust core and thin integration surfaces.

```text
apps/
├── frilvault-cli
└── vscode-extension

crates/
└── frilvault-core
```

- `crates/frilvault-core`: note model, repositories, services, runtime helpers
- `apps/frilvault-cli`: `flvt` command-line interface
- `apps/vscode-extension`: current editor integration

## Core Principles

- FrilVault is local-first. Notes and metadata stay inside the workspace.
- FrilVault does not modify source files.
- Business logic should live in `frilvault-core`.
- Editor and CLI layers should stay thin.

## Storage Model

```text
.vault/
├── notes/
├── index/
└── workspace.json
```

- `.vault/notes`: persisted note files
- `.vault/index`: workspace index data
- `.vault/workspace.json`: workspace-level metadata

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
- note search
- workspace stats and health
- repair suggestions and repair application
- `.vault` persistence

### `frilvault-cli`

The CLI is the primary executable surface today.

- parses commands
- opens the workspace
- calls the `FrilVault` facade
- prints human or JSON output

### `apps/vscode-extension`

The VS Code extension is still an MVP integration.

Current feature scope:

- add note
- notes panel
- gutter decorations
- note edit and delete
- search
- workspace stats
- workspace health
- repair apply

Its backend is hybrid:

- CLI-backed: add note, notes panel, gutter decorations
- Node-bridge-backed: edit, delete, search, stats, health, repair

## Known Architectural Reality

The runtime boundary exists, but the project is not fully centralized around it yet.

- `NoteService` uses `VaultContext` for cache-aware file note loading
- note mutations still write through repositories stored inside the context
- note search still scans persisted note files directly
- `WorkspaceService` still keeps its own `WorkspaceIndexRepository` field

That is acceptable for the current MVP, but it means the runtime layer is only partially unified.
