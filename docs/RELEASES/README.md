# Release Documents

This directory contains the release workflow, the release note template, and the published history for each release line.
The template intentionally stays close to [v0.0.md](v0.0.md) so new notes remain simple.

## Files

- [PROCESS.md](PROCESS.md) defines the stable release procedure.
- [TEMPLATE.md](TEMPLATE.md) is the starting point for a new release note.
- [v0.0.md](v0.0.md) records the v0.0 release history.
- [checklist-v0.0.4.md](checklist-v0.0.4.md) tracks the current release readiness.

## How To Use

1. Start from [TEMPLATE.md](TEMPLATE.md) when preparing a new release note.
2. Follow [PROCESS.md](PROCESS.md) for the release workflow and validation steps.
3. Move the finished note into the matching versioned history file.

## Workflow Split

The current release automation is intentionally split:

- `release.yml` builds and uploads VSIX assets when a GitHub Release is published
- `publish.yml` is a separate manual workflow for Visual Studio Marketplace publishing

This keeps Marketplace failures from blocking GitHub Release asset creation.

## Notes

- Keep process changes in [PROCESS.md](PROCESS.md), not in versioned history files.
- Keep published release history files append-only unless a maintainer explicitly corrects them.
