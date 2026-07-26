import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { findSymbolAnchorAtPosition, isBlankLineAtPosition } from '../utils/symbols';

suite('Symbol anchor selection', () => {
  test('isBlankLineAtPosition treats whitespace-only lines as blank', () => {
    const document = createMockDocument([
      'fn parse() {',
      '    ',
      '    let value = 1;',
      '',
    ]);

    assert.strictEqual(isBlankLineAtPosition(document, new vscode.Position(1, 4)), true);
    assert.strictEqual(isBlankLineAtPosition(document, new vscode.Position(2, 4)), false);
    assert.strictEqual(isBlankLineAtPosition(document, new vscode.Position(3, 0)), true);
  });

  test('findSymbolAnchorAtPosition prefers line anchor on blank lines inside symbols', async () => {
    const parseSymbol = createSymbol('parse', 0, 3);
    const restoreExecuteCommand = stubDocumentSymbols([parseSymbol]);

    try {
      const document = createMockDocument(['fn parse() {', '', '    let value = 1;', '}']);
      const blankLinePosition = new vscode.Position(1, 0);
      const codeLinePosition = new vscode.Position(2, 8);

      assert.strictEqual(
        await findSymbolAnchorAtPosition(document, blankLinePosition),
        undefined,
      );

      const symbol = await findSymbolAnchorAtPosition(document, codeLinePosition);
      assert.strictEqual(symbol?.name, 'parse');
    } finally {
      restoreExecuteCommand();
    }
  });

  test('findSymbolAnchorAtPosition keeps symbol anchor on declaration lines', async () => {
    const parseSymbol = createSymbol('parse', 0, 3);
    const restoreExecuteCommand = stubDocumentSymbols([parseSymbol]);

    try {
      const document = createMockDocument(['fn parse() {', '    let value = 1;', '}']);
      const declarationPosition = new vscode.Position(0, 3);

      const symbol = await findSymbolAnchorAtPosition(document, declarationPosition);
      assert.strictEqual(symbol?.name, 'parse');
    } finally {
      restoreExecuteCommand();
    }
  });

  test('findSymbolAnchorAtPosition prefers line anchor on blank lines between symbols', async () => {
    const restoreExecuteCommand = stubDocumentSymbols([
      createSymbol('a', 0, 0),
      createSymbol('b', 2, 2),
    ]);

    try {
      const document = createMockDocument(['fn a() {}', '', 'fn b() {}']);
      const betweenSymbolsPosition = new vscode.Position(1, 0);

      assert.strictEqual(
        await findSymbolAnchorAtPosition(document, betweenSymbolsPosition),
        undefined,
      );
    } finally {
      restoreExecuteCommand();
    }
  });
});

function createMockDocument(lines: string[]): vscode.TextDocument {
  return {
    lineAt(line: number) {
      return { text: lines[line] ?? '' };
    },
    uri: {
      fsPath: '/tmp/workspace/src/main.rs',
    },
  } as vscode.TextDocument;
}

function createSymbol(name: string, startLine: number, endLine: number): vscode.DocumentSymbol {
  const start = new vscode.Position(startLine, 0);
  const end = new vscode.Position(endLine, 100);

  return {
    name,
    detail: '',
    kind: vscode.SymbolKind.Function,
    range: new vscode.Range(start, end),
    selectionRange: new vscode.Range(start, new vscode.Position(startLine, name.length + 3)),
    children: [],
  } as vscode.DocumentSymbol;
}

function stubDocumentSymbols(symbols: vscode.DocumentSymbol[]): () => void {
  const originalExecuteCommand = vscode.commands.executeCommand;

  vscode.commands.executeCommand = (async (command, ...args) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      return symbols;
    }

    return originalExecuteCommand(command, ...args);
  }) as typeof vscode.commands.executeCommand;

  return () => {
    vscode.commands.executeCommand = originalExecuteCommand;
  };
}
