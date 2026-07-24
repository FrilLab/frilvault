# Release Process

This document defines the release workflow for FrilVault.
Use [README.md](README.md) for the directory map, [TEMPLATE.md](TEMPLATE.md) for new release notes, and versioned files like [v0.0.md](v0.0.md) for published history.

Repository reality as of July 23, 2026:

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
- desktop package configuration is correct
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

Typical locations may include:

```text
Cargo.toml
Cargo.lock
package.json
package-lock.json
tauri.conf.json
tauri.conf.json5
tauri.conf.toml
CHANGELOG.md
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

- First desktop release.
- Local FrilVault workspace support.
- Note display for the current source file.

### Known limitations

- Automatic updates are not available.
- Some advanced symbol repair features are deferred.
```

Describe outcomes, not internal commit history.

## Release Branch

For a small project, release directly from a short-lived branch:

```text
release/<version>
```

Example:

```text
release/0.0.1
```

The release branch should contain only release preparation:

- version updates
- changelog updates
- release metadata
- packaging fixes required for release
- documentation corrections required for installation

Do not add unrelated product features to the release branch.

## Release Validation

Run the full project validation appropriate to the release.

Rust baseline:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo build --workspace --release
```

Run relevant frontend, extension, and desktop commands defined by their actual package files.

For the current VS Code extension checkout, the relevant scripts are:

```bash
npm run check-types
npm run lint
npm run compile
npm test
```

Record unsupported platform validation explicitly.

If `npm test` exits with `SIGABRT` under `vscode-test`, do not treat the extension as release-ready until the failure is either fixed or explicitly accepted as an external environment limitation by the maintainer and recorded in the release checklist.

## Marketplace Publishing Workflow

Keep release asset generation and Marketplace publishing as separate workflows.

Recommended flow:

```text
GitHub Release -> published -> release.yml -> VSIX assets on the release
workflow_dispatch -> publish.yml -> Visual Studio Marketplace
```

The release workflow should:

1. verify that the GitHub release tag matches `apps/vscode-extension/package.json`
2. build target-specific `flvt` binaries and VSIX packages for:
   - `darwin-arm64`
   - `darwin-x64`
   - `linux-x64`
   - `win32-x64`
3. attach those VSIX files to the GitHub Release

The Marketplace workflow should:

1. be triggered manually with `workflow_dispatch`
2. download the target-specific VSIX files from the selected GitHub Release
3. publish those VSIX files to the Visual Studio Marketplace

Use Azure Workload Identity Federation for the manual publish workflow. This avoids long-lived personal access tokens and allows the GitHub Actions runner to authenticate as a service principal that is a member of the `frillab` VS Marketplace publisher.

Required GitHub Actions secrets and configuration:

- secret: `AZURE_CLIENT_ID` — the Azure AD application (client) ID
- secret: `AZURE_TENANT_ID` — the Azure AD tenant ID
- secret: `AZURE_SUBSCRIPTION_ID` — the Azure subscription ID

The Azure AD application must have a federated identity credential configured for this repository and the service principal must be added as a member of the `frillab` VS Marketplace publisher.

The publisher remains a single Marketplace extension identity. Platform-specific VSIX files do not create separate extension listings.

## Release Pull Request

Open a dedicated Pull Request.

Suggested title:

```text
release: prepare v0.0.1
```

Suggested body:

```markdown
## Release

`v0.0.1`

## Included

- List the user-visible features.
- List important fixes.
- List supported platforms.

## Deferred

- List non-blocking work moved to later releases.

## Validation

- [x] Formatting
- [x] Linting
- [x] Tests
- [x] Release build
- [ ] Platform-specific manual checks

## Known limitations

- Document current limitations.
```

Merge using the repository's normal reviewed workflow.

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

When the GitHub Actions release workflow creates tags automatically, follow the workflow's documented trigger instead of creating a duplicate tag manually.

## GitHub Release

Create a draft first:

```bash
gh release create frilvault-v0.0.1 \
  --repo FrilLab/frilvault \
  --draft \
  --generate-notes \
  --title "FrilVault v0.0.1"
```

Upload artifacts when they are not attached automatically:

```bash
gh release upload frilvault-v0.0.1 \
  <ARTIFACTS> \
  --repo FrilLab/frilvault \
  --clobber
```

Use `--clobber` only when intentionally replacing incorrect draft artifacts.

Verify:

- release points to the expected tag
- artifact names include platform and architecture
- artifacts open or execute as expected
- checksums match
- release notes explain installation
- known limitations are included

Publish only after explicit maintainer approval.

## Suggested Artifact Naming

Use predictable names:

```text
frilvault-0.0.2-darwin-arm64.vsix
frilvault-0.0.2-darwin-x64.vsix
frilvault-0.0.2-linux-x64.vsix
frilvault-0.0.2-win32-x64.vsix
frilvault-0.0.2-checksums.txt
```

Only publish platforms that were actually built and validated.

## Release Notes

Release notes should answer:

- what FrilVault does
- what is included in this version
- how to install it
- which platforms are supported
- what limitations remain
- where to report problems

Avoid copying raw commit messages without editing.

## Post-Release Verification

After publication:

- download the public artifacts
- verify installation from the public release page
- start the application
- create or open a local vault
- verify the primary release path
- confirm the tag and release are visible
- confirm release notes are correct
- open issues for newly discovered defects
- update the next milestone

Do not silently replace a published release to hide a defect. Document the problem and issue a corrected release when necessary.

## Rollback and Correction

If a draft release is wrong:

- keep it as a draft
- replace the incorrect artifacts
- correct the release notes
- rerun validation

If a published release is defective:

- document the defect
- avoid deleting the release unless absolutely necessary
- prepare a patch version
- publish corrected artifacts under the new version

Destructive release or tag operations require explicit maintainer approval.

## First Release Recommendation

For the current repository, prioritize:

- a working Rust core and CLI
- stable local vault behavior
- current-file note display in the VS Code extension
- clear installation and validation instructions
- release artifacts only for surfaces that actually exist in the repository

Defer when necessary:

- automatic application updates
- advanced cache and indexing
- file watchers
- rename and repair automation
- image attachments
- advanced symbol resolution

## Current Release Assessment

As of July 23, 2026, this checkout is not ready for a repository-level release that includes the VS Code extension.

Release blockers currently visible in the source tree and validation results:

- `apps/vscode-extension/src/features/inline-editor/editor.ts` and `apps/vscode-extension/src/features/gitignore/prompt.ts`
  a successful note save can still be surfaced as a failure if the post-save `.gitignore` check or prompt path throws
- `apps/vscode-extension/src/features/uri/handler.ts`
  malformed `frilvault://` URIs can escape the handler's normal user-facing error path during query decoding
- `apps/vscode-extension/src/features/inline-editor/codelens.ts`
  path matching is more fragile than the shared path helpers and is risky for Windows or nested configured roots
- `apps/vscode-extension`
  `npm test` currently aborts with `SIGABRT` under `vscode-test`, so the extension release gate is not green

Non-blocking cleanup items:

- `apps/vscode-extension/src/core/nodeBridge.ts` remains inactive legacy scaffolding
- `apps/vscode-extension/src/features/add-note/*` is legacy command code that is no longer part of active command registration
