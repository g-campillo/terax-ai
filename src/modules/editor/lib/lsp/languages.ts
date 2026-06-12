export type LspLanguage = { server: string; languageId: string };

// Must stay in sync with SERVERS in src-tauri/src/modules/lsp/registry.rs.
const EXT_TO_LSP: Record<string, LspLanguage> = {
  ts: { server: "typescript", languageId: "typescript" },
  mts: { server: "typescript", languageId: "typescript" },
  cts: { server: "typescript", languageId: "typescript" },
  tsx: { server: "typescript", languageId: "typescriptreact" },
  js: { server: "typescript", languageId: "javascript" },
  mjs: { server: "typescript", languageId: "javascript" },
  cjs: { server: "typescript", languageId: "javascript" },
  jsx: { server: "typescript", languageId: "javascriptreact" },
  py: { server: "python", languageId: "python" },
  pyi: { server: "python", languageId: "python" },
  rs: { server: "rust", languageId: "rust" },
  go: { server: "go", languageId: "go" },
  java: { server: "java", languageId: "java" },
  swift: { server: "swift", languageId: "swift" },
  kt: { server: "kotlin", languageId: "kotlin" },
  kts: { server: "kotlin", languageId: "kotlin" },
};

export function lspLanguageFor(path: string): LspLanguage | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_TO_LSP[name.slice(dot + 1).toLowerCase()] ?? null;
}
