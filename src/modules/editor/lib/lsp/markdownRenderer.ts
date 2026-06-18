import DOMPurify from "dompurify";
import { marked } from "marked";

// Hover and completion docs arrive from language servers as markdown. marimo's
// client only runs a renderer when `allowHTMLContent` is enabled; supply this
// one so the tooltips show formatted text instead of raw `**markup**`.

// jdtls / sourcekit-lsp append a "Source:" footer whose links use file:// URIs
// pointing at the symbol's declaration. The webview can't navigate file://, and
// the sanitizer strips the scheme anyway, so rewrite those anchors into inert
// markers the hover click handler resolves via the editor's open-file callback.
const FILE_ANCHOR_RE = /<a\s+href="(file:[^"]*)"\s*>/gi;

// marked + the file-link rewrite, without sanitization — pure and DOM-free so
// it can be unit-tested. Not for direct use: its output is unsanitized.
export function htmlFromMarkdown(markdown: string): string {
  const html = marked.parse(markdown.trim(), {
    async: false,
    gfm: true,
    breaks: true,
  }) as string;
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
