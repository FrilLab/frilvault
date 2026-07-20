# Agents

This file is for coding agents and automation working in the repository.

## Priorities

- preserve local-first behavior
- never introduce source-file rewriting as part of the note model
- keep shared logic in `crates/frilvault-core`
- avoid adding infrastructure that increases maintenance cost without clear payoff

## Repository Guidance

### Core crate

Prefer adding or changing behavior in `crates/frilvault-core` first. The CLI and editor integration should reuse that logic instead of duplicating it.

### CLI

`apps/frilvault-cli` is the main executable surface. Keep it focused on parsing input, opening the workspace, and formatting output.

### VS Code extension

The extension is still hybrid. Some flows use `CliClient`, while others use the native Node bridge. Changes here should make that boundary clearer, not more tangled.

## Documentation Guidance

- keep `README.md` concise
- put durable design notes in `docs/*.md`
- do not reintroduce a docs publishing pipeline unless explicitly requested

## Safe Change Patterns

- prefer incremental refactors over broad architectural rewrites
- update tests with behavior changes
- keep file and command examples aligned with the actual CLI
- call out architectural mismatches directly when you find them
