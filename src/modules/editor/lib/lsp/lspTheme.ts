import { EditorView } from "@codemirror/view";

// Styling for the tooltips marimo renders for LSP: the completion popup and its
// side documentation panel, hover cards, and signature help. The base
// `.cm-tooltip` frame (background/border/radius) is themed in
// buildSharedExtensions; this layers the LSP-specific structure and the
// markdown content rendered inside those tooltips. Selectors mirror the
// `&.cm-editor ...` scoping the shared theme already uses.

// Markdown-body element selectors, applied inside every tooltip that renders
// LSP markdown: the hover card (marimo's `.cm-tooltip.documentation`), our own
// `.cm-lsp-hover-tooltip`, and the completion info panel. Without the
// documentation container here, hover headings fall back to the browser's 2em
// default — the "enormous import" tooltips — while body text stays 12px.
const MD = [
  "&.cm-editor .cm-lsp-hover-tooltip",
  "&.cm-editor .cm-tooltip.documentation",
  "&.cm-editor .cm-completionInfo",
];
const md = (suffix: string) => MD.map((base) => `${base} ${suffix}`).join(", ");

const codeBg = "color-mix(in srgb, var(--foreground) 8%, transparent)";
const blockBg = "color-mix(in srgb, var(--foreground) 6%, transparent)";

export const lspTooltipTheme = EditorView.theme({
  // ── Completion popup list ──────────────────────────────────────────────
  "&.cm-editor .cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
    maxHeight: "18rem",
    maxWidth: "34rem",
  },
  "&.cm-editor .cm-tooltip-autocomplete > ul > li": {
    padding: "2px 7px",
    borderRadius: "4px",
    lineHeight: "1.55",
  },
  "&.cm-editor .cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    marginLeft: "0.75rem",
  },
  // ── Completion side documentation panel ────────────────────────────────
  "&.cm-editor .cm-completionInfo": {
    margin: "-1px 0 0 4px",
    padding: "8px 10px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    // Consistent size across every tooltip type (see hover card below).
    minWidth: "18rem",
    maxWidth: "32rem",
    maxHeight: "24rem",
    overflow: "auto",
    fontSize: "12.5px",
    lineHeight: "1.5",
  },
  // ── Hover card ─────────────────────────────────────────────────────────
  // Same min/max width, height, and font-size as the completion info panel so
  // hovers don't swing between cramped and oversized.
  "&.cm-editor .cm-tooltip.documentation, &.cm-editor .cm-lsp-hover-tooltip": {
    padding: "8px 10px",
    minWidth: "18rem",
    maxWidth: "32rem",
    maxHeight: "24rem",
    overflow: "auto",
    fontSize: "12.5px",
    lineHeight: "1.5",
  },
  // ── Signature help (override marimo's inline #666 / hard borders) ───────
  "&.cm-editor .cm-signature-tooltip": { padding: "6px 9px" },
  "&.cm-editor .cm-signature-docs": {
    color: "var(--muted-foreground) !important",
    marginTop: "4px !important",
  },
  "&.cm-editor .cm-parameter-docs": {
    color: "var(--muted-foreground) !important",
    borderTop: "1px solid var(--border) !important",
    marginTop: "4px !important",
    paddingTop: "4px !important",
    fontStyle: "normal !important",
  },
  // ── Markdown body shared by hover + completion info ─────────────────────
  [md("> :first-child")]: { marginTop: "0" },
  [md("> :last-child")]: { marginBottom: "0" },
  [md("p")]: { margin: "0 0 6px" },
  [md("ul, ol")]: { margin: "0 0 6px", paddingLeft: "1.2em" },
  [md("li")]: { margin: "1px 0" },
  [md("h1, h2, h3, h4")]: {
    margin: "8px 0 4px",
    fontSize: "12.5px",
    fontWeight: "600",
  },
  [md("hr")]: {
    margin: "6px 0",
    border: "none",
    borderTop: "1px solid var(--border)",
  },
  [md("a")]: { color: "var(--primary)", textDecoration: "none" },
  [md("a:hover")]: { textDecoration: "underline" },
  [md("code")]: {
    fontFamily: "monospace",
    fontSize: "0.92em",
    backgroundColor: codeBg,
    padding: "0.5px 4px",
    borderRadius: "4px",
  },
  [md("pre")]: {
    margin: "6px 0",
    padding: "8px",
    borderRadius: "6px",
    overflow: "auto",
    backgroundColor: blockBg,
  },
  [md("pre code")]: { background: "none", padding: "0", fontSize: "0.92em" },
  [md("blockquote")]: {
    margin: "6px 0",
    paddingLeft: "8px",
    borderLeft: "2px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  // ── "Source:" file links rewritten by renderLspMarkdown ────────────────
  "&.cm-editor .cm-lsp-file-link": {
    color: "var(--primary)",
    cursor: "pointer",
    textDecoration: "none",
  },
  "&.cm-editor .cm-lsp-file-link:hover": { textDecoration: "underline" },
  // ── Go-to-definition (goToDefinition.ts) ───────────────────────────────
  // Underline the symbol under the pointer while Cmd/Ctrl is held.
  "&.cm-editor .cm-lsp-definition-link": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  // "No definition found" transient tooltip.
  "&.cm-editor .cm-lsp-no-definition": {
    padding: "3px 8px",
    fontSize: "12px",
    color: "var(--popover-foreground)",
  },
});
