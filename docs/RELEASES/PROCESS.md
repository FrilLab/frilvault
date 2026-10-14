# Release Process

This document defines the release workflow for FrilVault.
Use [README.md](README.md) for the directory map, [TEMPLATE.md](TEMPLATE.md) for new release notes, and versioned files like [v0.0.md](v0.0.md) for published history.

Repository reality as of July 24, 2026:

- the active source trees are `crates/frilvault-core`, `apps/frilvault-cli`, and `apps/vscode-extension`
- there is no desktop application source tree in this repository checkout
- the VS Code extension is CLI-backed at runtime; native bridge files remain as inactive scaffolding

The first objective is to publish a small, usable release. Do not delay a release solely to include optional infrastructure or future-facing architecture.

## Release Principles

- Release a coherent minimum product before implementing every open issue.
- Separate release infrastructure from unrelated feature work.
- Keep `main` releasable.
- Build releases from reviewed and merged commits.
- Use semantic version tags.
- Never publish a release without explicit maintainer approval.
- Prefer draft releases until artifacts and notes have been verified.
- Do not treat automatic application updates as a prerequisite for the first release.

## Versioning

Use semantic version tags with the extension prefix:

```text
frilvault-v0.0.1
frilvault-v0.0.2
frilvault-v0.1.0
```

General interpretation before `v1.0.0`:

- patch: fixes and small compatible improvements
- minor: meaningful feature or architecture milestone
- major: stable public contract after the project is ready for `v1.0.0`

The maintainer decides the final version.

## Release Scope

Before release work begins, create or confirm a release checklist containing:

```text
Target version:
Target date:
Required issues:
Optional issues:
Deferred issues:
Supported platforms:
Release artifacts:
Known limitations:
```

Only required issues block the release.

Move optional or deferred work to a later milestone instead of silently expanding the release.

## Release Readiness Checklist

Confirm:

- required release issues are closed
- no blocking Pull Request remains open
- `main` is synchronized and clean
- workspace formatting passes
- workspace linting passes
- workspace tests pass
- release build succeeds
- version numbers are consistent
- lockfiles are current
- user-facing documentation is current
- release workflow exists and is valid
- artifact names are predictable
- checksums or signatures are produced when configured
- known limitations are documented

For the current repository, also confirm:

- the release scope names the actual deliverables being shipped
- extension validation uses the real script names from `apps/vscode-extension/package.json`
- no known extension bug can make a successful note save appear to fail
- any inactive legacy runtime path is either removed from the release scope or documented as unsupported

## Version Update

Search for all version declarations before changing them.

Typical locations for the current repository include:

```text
Cargo.toml
Cargo.lock
apps/vscode-extension/package.json
apps/vscode-extension/package-lock.json
apps/vscode-extension/CHANGELOG.md
docs/RELEASES/v0.0.md
README.md
```

Do not assume every listed file exists.

Keep the same version across all components that are released together.

## Changelog

Maintain user-focused entries.

Recommended structure:

```markdown
# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

## [0.0.1] - YYYY-MM-DD

### Added

- VS Code extension release.
- Local FrilVault workspace support.
- Note creation and viewing inside the editor.

### Other

- Installation notes
- Supported platforms
```

Describe outcomes, not internal commit history.

## Release Validation

Run the full project validation appropriate to the release.

Rust baseline:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo build --workspace --release
```

Run relevant frontend and extension commands defined by their actual package files.

For the current VS Code extension checkout, the relevant scripts are:

```bash
npm run check-types
npm run lint
npm run compile
npm test
```

Record unsupported platform validation explicitly.

If `npm test` exits with `SIGABRT` under `vscode-test`, do not treat the extension as release-ready until the failure is either fixed or explicitly accepted as an external environment limitation by the maintainer and recorded in the release checklist.

## Release And Marketplace Flow

Keep GitHub Release asset generation and Marketplace publishing as separate workflows.

Actual flow:

```text
Merge reviewed changes to main
-> tag the release commit
-> create and publish a GitHub Release
-> release.yml builds CLI-backed VSIX assets and attaches them to the Release
-> run publish.yml manually
-> publish.yml downloads the Release assets and publishes them to the Marketplace
```

### GitHub Release Assets

`release.yml` runs on `release.published` and supports manual rebuilding of
assets through `workflow_dispatch`. Manual dispatch requires `tag`; optional
`source_ref` must be the full SHA of a reviewed commit already merged to `main`
and must have the same extension version as that tag. The workflow:

1. verifies that the GitHub release tag matches `apps/vscode-extension/package.json`
2. builds target-specific `flvt` binaries and VSIX packages for:
   - `darwin-arm64`
   - `darwin-x64`
   - `linux-x64`
   - `win32-x64`
3. attaches those VSIX files to the GitHub Release

Expected Release asset names:

```text
frilvault-<version>-darwin-arm64.vsix
frilvault-<version>-darwin-x64.vsix
frilvault-<version>-linux-x64.vsix
frilvault-<version>-win32-x64.vsix
```

### Marketplace Publishing

`publish.yml` is a separate manual workflow triggered with `workflow_dispatch`.

It:

1. checks out the selected release tag
2. verifies that the tag matches `apps/vscode-extension/package.json`
3. downloads the VSIX files attached to that GitHub Release
4. publishes each VSIX to the single `frillab.frilvault` Marketplace listing

Required GitHub Actions configuration:

- repository secret: `VSCE_PAT`

The `VSCE_PAT` token must belong to an account with permission to publish updates for the `frillab` publisher.

Marketplace users do not select `darwin-arm64`, `darwin-x64`, `linux-x64`, or `win32-x64` manually. Visual Studio Marketplace serves the matching package for the user's platform.

## Tagging

Create the tag from the verified commit on the canonical default branch.

Before tagging:

```bash
git switch main
git fetch upstream
git pull --ff-only upstream main
git status --short
```

Confirm the target commit:

```bash
git log -1 --oneline
```

Do not tag an uncommitted or unreviewed working tree.

Tag format:

```bash
git tag -a frilvault-v0.0.1 -m "FrilVault v0.0.1"
git push upstream frilvault-v0.0.1
```

Tagging and pushing to the canonical repository require explicit maintainer approval.

## GitHub Release

Create the release from the verified tag:

```bash
gh release create frilvault-v0.0.1 \
  --repo FrilLab/frilvault \
  --generate-notes \
  --title "FrilVault v0.0.1"
```

The workflow-triggering event is GitHub Release publication. After publishing:

- verify that `release.yml` started
- verify that all four VSIX assets were attached
- confirm the asset names match the expected platform targets

If you prefer a draft-first flow in the GitHub UI, publish the draft only after the notes and target tag have been reviewed. `release.yml` will not run until the Release is published.

## Release Notes

Release notes should answer:

- what FrilVault does
- what is included in this version
- how to install it
- which platforms are supported
- what limitations remain
- where to report problems

Avoid copying raw commit messages without editing.

## Manual Marketplace Publish

Publish to the Marketplace only after the GitHub Release assets have been verified.

Dispatch `publish.yml` with:

- `tag=frilvault-vX.Y.Z` using the verified tag for the release being published

The workflow downloads the Release assets, verifies that all four VSIX packages exist, and publishes them with `VSCE_PAT`.

Only publish platforms that were actually built and attached to the Release.
