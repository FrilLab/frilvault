import * as vscode from 'vscode';

/**
 * Finds the innermost document symbol at a cursor position.
 *
 * Used when creating symbol notes from the active editor context.
 *
 * 커서 위치의 가장 안쪽 document symbol을 찾습니다.
 *
 * 활성 editor context에서 symbol note를 만들 때 사용합니다.
 */
export async function findSymbolAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.DocumentSymbol | undefined> {
  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | undefined
  >('vscode.executeDocumentSymbolProvider', document.uri);

  if (!symbols || symbols.length === 0) {
    return undefined;
  }

  return findInnermostSymbol(symbols, position);
}

/**
 * Resolves a symbol anchor for note creation at a cursor position.
 *
 * Blank or whitespace-only lines prefer a line anchor even when the cursor is
 * inside a symbol range. Non-blank lines inside a symbol still use a symbol
 * anchor.
 *
 * 커서 위치에서 note 생성용 symbol anchor를 결정합니다.
 *
 * 공백/빈 줄은 symbol range 안이어도 line anchor를 사용하고, symbol 내부의
 * 실제 코드 줄은 symbol anchor를 사용합니다.
 */
export async function findSymbolAnchorAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.DocumentSymbol | undefined> {
  if (isBlankLineAtPosition(document, position)) {
    return undefined;
  }

  return findSymbolAtPosition(document, position);
}

export function isBlankLineAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  return document.lineAt(position.line).text.trim().length === 0;
}

function findInnermostSymbol(
  symbols: readonly vscode.DocumentSymbol[],
  position: vscode.Position,
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (!symbol.range.contains(position)) {
      continue;
    }

    const nested = findInnermostSymbol(symbol.children, position);
    return nested ?? symbol;
  }

  return undefined;
}

export function mapDocumentSymbolKind(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Function:
      return 'function';
    case vscode.SymbolKind.Method:
      return 'method';
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Struct:
      return 'struct';
    case vscode.SymbolKind.Enum:
      return 'enum';
    case vscode.SymbolKind.Interface:
      return 'trait';
    default:
      return 'unknown';
  }
}

export function readSymbolSignature(
  document: vscode.TextDocument,
  symbol: vscode.DocumentSymbol,
): string | undefined {
  const line = document.lineAt(symbol.range.start.line).text.trim();
  return line.length > 0 ? line : undefined;
}
