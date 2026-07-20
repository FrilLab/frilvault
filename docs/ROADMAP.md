# FrilVault Roadmap

## Current Position

FrilVault already has a working core note system, workspace operations, CLI surface, and VS Code MVP. The next work should reduce architectural drift rather than add too many new surfaces.

## Near Term

### 1. Runtime consolidation

- move more read and write paths behind `VaultContext`
- reduce duplicated repository access patterns in services
- make cache behavior more consistent

### 2. VS Code stabilization

- remove rough edges in notes panel and gutter flows
- improve symbol-note UX
- reduce the split between CLI-backed and Node-bridge-backed features

### 3. Documentation discipline

- keep `README.md` as the entry point
- keep design and workflow notes in `docs/*.md`
- avoid maintaining a separate documentation site unless the project needs public-facing docs

## Mid Term

### 4. Better symbol workflows

- stronger symbol search
- better symbol targeting in editor flows
- more stable handling for renamed or moved code

### 5. Smarter repair behavior

- better move/rename detection
- lower false positives in candidate matching
- tighter cache invalidation after repair operations

### 6. Editor/runtime cleanup

- clarify whether the extension should stay hybrid or converge on one backend
- keep `frilvault-core` as the single source of truth

## Longer Term

- watcher-driven updates for long-running editor sessions
- richer code-aware navigation around notes
- expansion to other editor integrations only after the core runtime is steadier

## Not a Priority Right Now

- a separate docs publishing pipeline
- heavy public-site maintenance
- extra deployment branches for documentation output
