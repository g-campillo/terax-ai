// Language servers return function/method completions as LSP snippets
// (`insertTextFormat: 2`) with placeholder arguments, e.g.
// `requireMultiValueField(${1:fieldName}, ${2:values})`. The user prefers empty
// parens with the cursor between them — `name(│)` — and to type the args
// themselves, for every language. We rewrite completion responses at the
// transport seam (before marimo expands them) rather than depend on the
// client library exposing a snippet toggle.
//
// Pure and DOM-free so it can be unit-tested.

// LSP snippet tab stops: ${1}, ${1:default}, ${1|a,b|}, $1, $0.
const TAB_STOP_RE = /\$\{\d+(?::[^{}]*|\|[^|]*\|)?\}|\$\d+/g;

const SNIPPET_FORMAT = 2; // InsertTextFormat.Snippet

type CompletionItem = {
  insertTextFormat?: number;
  insertText?: string;
  textEdit?: { newText?: string } | null;
};

/** Index of the `)` matching the `(` at `openIdx`, or -1 if unbalanced. */
function matchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const stripTabStops = (s: string): string => s.replace(TAB_STOP_RE, "");

/**
 * Collapse a function-call snippet's argument list to a single `$0` so the
 * cursor lands inside empty parens. Snippets without call parens are left
 * untouched (only call-argument placeholders are in scope).
 */
export function rewriteSnippet(snippet: string): string {
  const open = snippet.indexOf("(");
  if (open === -1) return snippet;
  const close = matchingParen(snippet, open);
  if (close === -1) return snippet;

  const before = stripTabStops(snippet.slice(0, open));
  const after = stripTabStops(snippet.slice(close + 1));
  return `${before}($0)${after}`;
}

function rewriteItem(item: CompletionItem): CompletionItem {
  if (item.insertTextFormat !== SNIPPET_FORMAT) return item;
  // Prefer textEdit.newText (what jdtls/sourcekit actually send) as the source.
  const source =
    item.textEdit && typeof item.textEdit.newText === "string"
      ? item.textEdit.newText
      : item.insertText;
  if (typeof source !== "string") return item;
  const next: CompletionItem = { ...item, insertText: rewriteSnippet(source) };
  // Drop textEdit. marimo's textEdit branch inserts newText *raw* (no snippet
  // expansion) regardless of useSnippetOnCompletion, which would leave a literal
  // `$0`. Removing it makes marimo apply insertText through its snippet path so
  // `$0` becomes CodeMirror's final-cursor stop inside the empty parens. marimo
  // derives the insert range from the matched word, so the position is unchanged.
  // Requires useSnippetOnCompletion:true (set in extension.ts).
  delete next.textEdit;
  return next;
}

/**
 * Rewrite the `result` of a `textDocument/completion` response. Accepts the two
 * shapes servers return — a bare `CompletionItem[]` or a `CompletionList`
 * (`{ items: [...] }`) — and passes anything else (e.g. `null`) through.
 */
export function rewriteCompletionResult(result: unknown): unknown {
  if (Array.isArray(result)) {
    return (result as CompletionItem[]).map(rewriteItem);
  }
  if (result && typeof result === "object" && "items" in result) {
    const list = result as { items?: unknown };
    if (Array.isArray(list.items)) {
      return { ...result, items: (list.items as CompletionItem[]).map(rewriteItem) };
    }
  }
  return result;
}
