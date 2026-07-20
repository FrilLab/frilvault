# FrilVault

Personal notes for source code, without modifying source files.

FrilVault is a local-first workspace knowledge layer. Notes live under `.vault/` beside the project, while application code stays untouched.

## What It Supports

- line-anchored and symbol-anchored notes
- workspace search
- workspace stats and health checks
- note-file repair after file moves or renames
- VS Code integration for the current MVP

## Repository Layout

```text
apps/
├── frilvault-cli
└── vscode-extension

crates/
└── frilvault-core
```

`frilvault-core` contains the domain logic, storage access, and runtime utilities. `frilvault-cli` is the main executable surface. `apps/vscode-extension` is the current editor integration.

## Storage Model

```text
.vault/
├── notes/
├── index/
└── workspace.json
```

FrilVault does not rewrite or annotate source files.

## Quick Commands

```bash
flvt add --file src/main.rs --line 10 --column 5 --content "parser needs cleanup"
flvt list --file src/main.rs
flvt search parser
flvt stats
flvt doctor
flvt repair --apply
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Agents](docs/AGENTS.md)

## Development

```bash
cargo test -p frilvault-core
cargo test -p frilvault-cli
```

```bash
cd apps/vscode-extension
npm run compile
npm test
```
