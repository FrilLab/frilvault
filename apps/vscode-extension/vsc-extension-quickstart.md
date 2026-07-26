# FrilVault VS Code Extension Quickstart

## Run the Extension

1. Install Rust and Node.js.
2. Open `apps/vscode-extension` in VS Code.
3. Run `npm run compile`.
4. Press `F5` to launch an Extension Development Host.
5. Open `FrilVault Notes` and select `Enable` inside the test workspace.

## Configure the CLI

Marketplace and target-specific VSIX builds bundle `flvt` automatically.

Set `frilvault.cliPath` only when you want to override the bundled binary:

```json
{
  "frilvault.cliPath": "/absolute/path/to/flvt"
}
```

## Publish

GitHub Release packaging and Marketplace publishing are separate steps.

- `.github/workflows/release.yml` builds target-specific VSIX assets from a published GitHub Release
- `.github/workflows/publish.yml` is the manual Marketplace publishing workflow

For a manual local publish, use a generated VSIX:

```bash
npx @vscode/vsce publish --packagePath frilvault-0.0.3-darwin-arm64.vsix
```

## Useful Commands

- `Add`
- `Search Notes`
- `Show Stats`
- `Show Health`
- `Apply Repairs`

## Test

```bash
npm test
```

## Current Notes

- the side panel tracks the current active editor
- gutter decorations refresh when notes change or when the active editor changes
- all extension flows use the bundled or overridden `flvt` CLI through `CliClient`
