import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LanguageServerClient } from "@marimo-team/codemirror-languageserver";
import { pathToFileUri } from "./uri";

const FORMATTING_TIMEOUT_MS = 10_000;

type LspPosition = { line: number; character: number };
type LspTextEdit = {
  range: { start: LspPosition; end: LspPosition };
  newText: string;
};

// marimo's client exposes no formatting method and keeps `request` protected,
// so reach the same JSON-RPC session to send textDocument/formatting. The
// method isn't in marimo's typed request map, hence the structural cast.
type RawFormattingClient = {
  request: (
    method: string,
    params: unknown,
    timeout: number,
  ) => Promise<unknown>;
  capabilities: { documentFormattingProvider?: unknown } | null;
};

function posToOffset(doc: Text, pos: LspPosition): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}

export type DocChange = { from: number; to: number; insert: string };

// Pure offset mapping (no view), so it can be unit-tested with an EditorState.
export function lspEditsToChanges(
  doc: Text,
  edits: LspTextEdit[],
): DocChange[] {
  return (
    edits
      .map((e) => ({
        from: posToOffset(doc, e.range.start),
        to: posToOffset(doc, e.range.end),
        insert: e.newText,
      }))
      // LSP edits are non-overlapping; CodeMirror wants them in document order.
      .sort((a, b) => a.from - b.from)
  );
}

function applyLspTextEdits(view: EditorView, edits: LspTextEdit[]): void {
  view.dispatch({
    changes: lspEditsToChanges(view.state.doc, edits),
    userEvent: "format",
  });
}

/**
 * Format the document via the language server, applying the returned edits.
 * Returns false (a no-op) when the server can't format or returns nothing.
 */
export async function formatDocument(
  client: LanguageServerClient,
  view: EditorView,
  path: string,
): Promise<boolean> {
  const raw = client as unknown as RawFormattingClient;
  if (!raw.capabilities?.documentFormattingProvider) return false;
  const result = await raw.request(
    "textDocument/formatting",
    {
      textDocument: { uri: pathToFileUri(path) },
      options: { tabSize: 2, insertSpaces: true },
    },
    FORMATTING_TIMEOUT_MS,
  );
  const edits = result as LspTextEdit[] | null;
  if (!edits || edits.length === 0) return false;
  applyLspTextEdits(view, edits);
  return true;
}
