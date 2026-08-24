# FrilVault

[![Build Status](https://github.com/FrilLab/frilvault/actions/workflows/ci.yml/badge.svg)](https://github.com/FrilLab/frilvault/actions/workflows/ci.yml)
[![Test Coverage](https://codecov.io/gh/FrilLab/frilvault/branch/main/graph/badge.svg)](https://codecov.io/gh/FrilLab/frilvault)
[![Release](https://img.shields.io/github/v/release/FrilLab/frilvault)](https://github.com/FrilLab/frilvault/releases)
[![Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/frillab.frilvault)](https://marketplace.visualstudio.com/items?itemName=frillab.frilvault)
[![Rust](https://img.shields.io/badge/Rust-2024%20edition-DEA584?logo=rust)](https://www.rust-lang.org/)
[![License](https://img.shields.io/github/license/FrilLab/frilvault)](LICENSE)

Personal notes for source code, without modifying source files.

FrilVault is a local-first workspace knowledge layer. Notes live under `.vault/` beside the project, while application code stays untouched.

## What It Supports

- line-anchored and symbol-anchored notes
- note attachments
- workspace search
- workspace explorer output
- workspace stats and health checks
- note URI resolution
- workspace sync and gitignore helper flows
- note-file repair after file moves or renames
- VS Code integration with notes panel, expandable block note viewer, gutter markers, hover preview, inline editing, and CodeLens

## Repository Layout

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

- `crates/frilvault-core` contains the domain logic, persistence boundaries, symbol helpers, URI helpers, and workspace services.
- `apps/frilvault-cli` is the main executable surface for local workflows and JSON consumers.
- `apps/vscode-extension` contains the current editor integration.
- `docs/` contains architecture, workflow, testing, and release guidance.

The current checkout contains a CLI and a VS Code extension. Repository guidance still reserves room for a future desktop application, but there is no desktop application source tree in the current layout.

## Install

The current public release is `v0.0.3` for the VS Code extension.

### Option 1: Visual Studio Marketplace

Install `FrilVault` from the Visual Studio Marketplace inside VS Code.

Marketplace users do not need to choose a platform manually. The Marketplace serves the matching package for the current operating system and CPU architecture.

### Option 2: GitHub Release VSIX

Download a platform-specific VSIX from the GitHub Release page:

https://github.com/FrilLab/frilvault/releases

Then install it in VS Code with `Extensions: Install from VSIX...`.

### Supported Platforms

| Platform | VSIX target |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Windows x64 | `win32-x64` |
| Linux x64 | `linux-x64` |

## Release Distribution

The repository uses a split release flow for the VS Code extension:

- `release.yml` runs when a GitHub Release is published and builds platform-specific VSIX assets
- `publish.yml` is a manual workflow that downloads those Release assets and publishes them to the Visual Studio Marketplace with `VSCE_PAT`

Each published GitHub Release attaches these VSIX packages:

- `frilvault-<version>-darwin-arm64.vsix`
- `frilvault-<version>-darwin-x64.vsix`
- `frilvault-<version>-linux-x64.vsix`
- `frilvault-<version>-win32-x64.vsix`

## Current Release

FrilVault `v0.0.3` adds Explorer note counts and a workspace note overview in `FrilVault Notes`. The extension continues to bundle `flvt` inside each platform-specific package.

## Storage Model

```text
.vault/
├── notes/
├── images/
├── cache/
├── index/
└── workspace.json
```

FrilVault does not rewrite or annotate source files.

## Quick Commands

```bash
flvt add --file src/main.rs --line 10 --column 5 --content "parser needs cleanup"
flvt explorer --format json
flvt list --file src/main.rs
flvt search parser
flvt search --tag performance --tag parser
flvt search --tag-query 'tag:bug OR tag:security'
flvt search --tag-query 'tag:architecture NOT tag:legacy'
flvt tag stats
flvt tag stats --tag architecture --group-by directory --format json
flvt tag color set bug red
flvt tag color remove bug
flvt resolve-uri "frilvault://note/..."
flvt stats
flvt doctor
flvt repair --apply
```

Repeated `--tag` flags use AND semantics. `--tag-query` supports case-insensitive
`AND`, `OR`, and `NOT` operators, parentheses, and exact tag names with or
without a leading `#`. Precedence is `NOT`, then `AND`, then `OR`; `A NOT B`
means `A AND NOT B`. Wrap a complete term in double quotes inside the query when
a tag contains spaces, for example `--tag-query '"tag:needs review" OR tag:todo'`.
`--tag-query` cannot be combined with repeated `--tag` flags.

Tag colors use the theme-safe `red`, `orange`, `yellow`, `green`, `blue`, and
`purple` palette. They are optional workspace metadata stored once in
`.vault/workspace.json`; note JSON continues to store tag names only.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Repository Rules](AGENTS.md)
- [GitHub Workflow](docs/github-workflow.md)
- [Testing](docs/testing.md)
- [Release Documents](docs/RELEASES/README.md)

## Development

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo build --workspace --release
```

```bash
cd apps/vscode-extension
npm install
npm run check-types
npm run lint
npm run compile
npm test
```

Use `npm run check-types`, not `npm run typecheck`; that script does not exist in the current extension package.
