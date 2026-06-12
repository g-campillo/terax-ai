import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import type { Extension } from "@codemirror/state";
import { languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { acquireLspClient, releaseLspClient } from "./client";
import { lspLanguageFor } from "./languages";
import { fileUriToPath, pathToFileUri } from "./uri";

export type LspServerStatus = {
  language: string;
  display: string;
  available: boolean;
  command: string | null;
  installHint: string;
};

export type LspHandle = {
  extension: Extension;
  status: LspServerStatus;
  release: () => void;
};

export type LspResolveResult =
  | { kind: "ready"; handle: LspHandle }
  | { kind: "missing-server"; status: LspServerStatus }
  | { kind: "unsupported" }
  | { kind: "disabled" };

type Deps = {
  path: string;
  workspaceRoot: string;
  onOpenFileAt: (path: string, line: number) => void;
};

export async function resolveLspExtension({
  path,
  workspaceRoot,
  onOpenFileAt,
}: Deps): Promise<LspResolveResult> {
  const lang = lspLanguageFor(path);
  if (!lang) return { kind: "unsupported" };
  const prefs = usePreferencesStore.getState();
  if (!prefs.lspEnabled) return { kind: "disabled" };
  const status = await invoke<LspServerStatus>("lsp_status", {
    language: lang.server,
  });
  if (!status.available) return { kind: "missing-server", status };

  const client = acquireLspClient(lang.server, workspaceRoot);
  let released = false;
  // LanguageServerOptions extends FeatureOptions directly -- feature flags are
  // top-level, not nested under a featureOptions key.
  const extension = languageServerWithClient({
    client,
    documentUri: pathToFileUri(path),
    languageId: lang.languageId,
    // AI ghost text and the LSP popup are mutually exclusive by design.
    completionEnabled: !prefs.autocompleteEnabled,
    hoverEnabled: true,
    diagnosticsEnabled: true,
    definitionEnabled: true,
    renameEnabled: false,
    codeActionsEnabled: false,
    signatureHelpEnabled: false,
    onGoToDefinition: (result) => {
      const target = fileUriToPath(result.uri);
      if (target !== path) {
        onOpenFileAt(target, result.range.start.line + 1);
      }
    },
  });
  return {
    kind: "ready",
    handle: {
      extension,
      status,
      release: () => {
        if (released) return;
        released = true;
        releaseLspClient(lang.server, workspaceRoot);
      },
    },
  };
}
