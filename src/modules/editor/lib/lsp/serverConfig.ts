// Defaults returned in reply to `workspace/configuration`. Servers request
// settings by `section`; replying with a config object (rather than null) keeps
// servers that expect one behaving sensibly. Unknown sections get `{}` so the
// server still receives an object instead of null.
const CONFIG_BY_SECTION: Record<string, unknown> = {
  "rust-analyzer": {
    check: { command: "check" },
    cargo: { buildScripts: { enable: true } },
    procMacro: { enable: true },
  },
  // pyright / basedpyright read their settings from the `python` section; both
  // auto-detect a project venv, so we only nudge the analysis defaults.
  python: {
    analysis: {
      autoSearchPaths: true,
      useLibraryCodeForTypes: true,
      diagnosticMode: "openFilesOnly",
      typeCheckingMode: "basic",
    },
  },
  basedpyright: {
    analysis: {
      autoSearchPaths: true,
      useLibraryCodeForTypes: true,
      diagnosticMode: "openFilesOnly",
      typeCheckingMode: "basic",
    },
  },
};

export function lspConfigForSection(section: string | undefined): unknown {
  if (!section) return {};
  return CONFIG_BY_SECTION[section] ?? {};
}
