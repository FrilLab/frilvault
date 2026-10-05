const vscode = require('vscode');

let controller;
let thread;

async function openProbe(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await vscode.window.showErrorMessage('Open the probe workspace first.');
    return;
  }

  const sourceUri = vscode.Uri.joinPath(folder.uri, 'sample.js');
  const document = await vscode.workspace.openTextDocument(sourceUri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });

  const preview = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  A rendered decoration preview (not an input control)',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 2ch',
    },
  });
  context.subscriptions.push(preview);
  editor.setDecorations(preview, [new vscode.Range(2, 0, 2, 1)]);

  controller ??= vscode.comments.createCommentController(
    'frilvaultIssue243Probe',
    'FrilVault #243 feasibility probe',
  );
  controller.options = {
    prompt: 'Native comment probe',
    placeHolder: 'Markdown body input supplied by VS Code',
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges: (candidate) =>
      candidate.uri.toString() === sourceUri.toString()
        ? [new vscode.Range(2, 0, 2, 1)]
        : [],
  };
  context.subscriptions.push(controller);

  thread?.dispose();
  thread = controller.createCommentThread(sourceUri, new vscode.Range(2, 0, 2, 1), [
    {
      body: 'Existing note body\n\n```ts\nconst untouched = true;\n```',
      mode: vscode.CommentMode.Editing,
      author: { name: 'FrilVault probe' },
    },
  ]);
  thread.label = 'One native comment editor anchored at line 3';
  thread.canReply = true;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'frilvault243.probe.openCommentSurface',
      () => openProbe(context),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'frilvault243.probe.openQuickInput',
      () => vscode.window.showInputBox({
        title: 'Quick Input fallback probe',
        prompt: 'This stable input API has no anchor or multiline body option.',
        placeHolder: 'Single-line input',
      }),
    ),
  );
  void openProbe(context);
}

function deactivate() {
  thread?.dispose();
  thread = undefined;
  controller?.dispose();
  controller = undefined;
}

module.exports = { activate, deactivate };
