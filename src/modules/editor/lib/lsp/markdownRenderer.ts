import DOMPurify from "dompurify";
import { Marked } from "marked";

// Hover and completion docs arrive from language servers as markdown. marimo's
// client only runs a renderer when `allowHTMLContent` is enabled; supply this
// one so the tooltips show formatted text instead of raw `**markup**`.

// jdtls / sourcekit-lsp append a "Source:" footer whose links use file:// URIs
// pointing at the symbol's declaration. The webview can't navigate file://, and
// the sanitizer strips the scheme anyway, so rewrite those anchors into inert
// markers the hover click handler resolves via the editor's open-file callback.
const FILE_ANCHOR_RE = /<a\s+href="(file:[^"]*)"\s*>/gi;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Dedicated marked instance (isolated from the global singleton) that renders
// raw HTML tokens as escaped text. Language-server docs are full of inline type
// generics like `<T>` / `<K, V>`; marked would otherwise parse them as tags and
// the sanitizer would then drop them, leaving stray markup. We never want
// server-supplied HTML rendered anyway, so escaping keeps the type text visible.
const md = new Marked({ async: false, gfm: true, breaks: true });
md.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

// marked + the file-link rewrite, without sanitization — pure and DOM-free so
// it can be unit-tested. Not for direct use: its output is unsanitized.
export function htmlFromMarkdown(markdown: string): string {
  const html = md.parse(markdown.trim()) as string;
  return html.replace(
    FILE_ANCHOR_RE,
    (_match, uri: string) =>
      `<a class="cm-lsp-file-link" data-file-uri="${uri}">`,
  );
}

export function renderLspMarkdown(markdown: string): string {
  // innerHTML is about to be set on this output, so strip scripts / event
  // handlers a doc-comment in an untrusted repo could smuggle in.
  return DOMPurify.sanitize(htmlFromMarkdown(markdown));
}
