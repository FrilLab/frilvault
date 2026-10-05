# Issue #243 VS Code Extension Host probe

This isolated extension exercises two stable public API candidates without adding a production command or editing the source document:

- `TextEditorDecorationType.after.contentText` renders a preview beside line 3.
- `CommentController.createCommentThread` displays VS Code's native comment editor at line 3.
- `window.showInputBox` displays the supported Quick Input candidate without an anchor or multiline editor.

The comment editor is deliberately seeded with a multiline Markdown body in `CommentMode.Editing`. The fixture uses no VS Code DOM access, Monaco APIs, proposed API, or note persistence.

## Run

Open a new VS Code process on `apps/vscode-extension/feasibility/issue-243` as a disposable workspace and pass this directory as `--extensionDevelopmentPath`. The probe opens `sample.js` and creates both surfaces on its third line. The command palette also contains **FrilVault #243 Probe: Open Native Comment Surface** and **FrilVault #243 Probe: Open Quick Input**.

Example from the repository root on macOS:

```bash
code \
  --new-window \
  --user-data-dir /tmp/frilvault-issue-243-user-data \
  --extensions-dir /tmp/frilvault-issue-243-extensions \
  --extensionDevelopmentPath "$PWD/apps/vscode-extension/feasibility/issue-243" \
  "$PWD/apps/vscode-extension/feasibility/issue-243"
```

This probe is intentionally not a product implementation. It is retained so reviewers can reproduce the API feasibility result in an Extension Host.
