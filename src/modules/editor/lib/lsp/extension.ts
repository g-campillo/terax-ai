import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { invoke } from "@tauri-apps/api/core";
import { acquireLspClient, onLspClientError, releaseLspClient } from "./client";
import { formatDocument } from "./format";
import { goToDefinitionExtension } from "./goToDefinition";
import { lspLanguageFor } from "./languages";
import { renderLspMarkdown } from "./markdownRenderer";
import { fileUriToPath, pathToFileUri } from "./uri";

// renderLspMarkdown rewrites the servers' "Source:" file:// links into inert
// `.cm-lsp-file-link` markers; this view plugin turns a click on one into an
// in-editor navigation instead of a (blocked) file:// browser navigation.
function fileLinkClickHandler(
  onOpenFileAt: (path: string, line: number) => void,
): Extension {
  return ViewPlugin.define((view) => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest?.(
        ".cm-lsp-file-link",
      );
      const uri = link?.getAttribute("data-file-uri");
      if (!uri) return;
      e.preventDefault();
      const [base, fragment] = uri.split("#");
      const line = fragment ? Number.parseInt(fragment, 10) : Number.NaN;
      onOpenFileAt(
        fileUriToPath(base),
        Number.isFinite(line) && line > 0 ? line : 1,
      );
    };
    view.dom.addEventListener("click", onClick);
    return {
      destroy() {
        view.dom.removeEventListener("click", onClick);
      },
    };
  });
}

// If a server never sends a clear readiness signal, flip the "indexing"
// indicator to ready after this long so the pill can't appear stuck forever.
const LSP_READY_FALLBACK_MS = 90_000;

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
  /** Format the document via the server; resolves false if it can't / won't. */
  format: (view: EditorView) => Promise<boolean>;
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
  // Center a 1-based line in the current pane (same-file go-to-definition).
  scrollToLine: (line: number) => void;
  onServerError?: (message: string) => void;
  // Called once the server can serve language features (jdtls ServiceReady, or
  // first diagnostics / finished progress for servers that don't announce it).
  onReady?: () => void;
};

export async function resolveLspExtension({
  path,
  workspaceRoot,
  onOpenFileAt,
  scrollToLine,
  onServerError,
  onReady,
}: Deps): Promise<LspResolveResult> {
  const lang = lspLanguageFor(path);
  if (!lang) return { kind: "unsupported" };
  const prefs = usePreferencesStore.getState();
  if (!prefs.lspEnabled) return { kind: "disabled" };
  const override = prefs.lspServerOverrides?.[lang.server];
  const status = await invoke<LspServerStatus>("lsp_status", {
    language: lang.server,
    workspaceRoot,
    serverOverride: override?.command ? override : null,
  });
  if (!status.available) return { kind: "missing-server", status };

  const client = acquireLspClient(lang.server, workspaceRoot);
  const offError = onLspClientError(lang.server, workspaceRoot, (message) => {
    onServerError?.(message);
  });

  // Flip the status pill from "indexing" to ready on the first signal that the
  // server can serve requests. jdtls sends `language/status` ServiceReady;
  // sourcekit-lsp / tsserver / others don't, so first diagnostics or a finished
  // progress task acts as a proxy, with a timed fallback so it never sticks.
  let settled = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let offReady: () => void = () => {};
  const markReady = () => {
    if (settled) return;
    settled = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    offReady();
    onReady?.();
  };
  offReady = client.onNotification((n: unknown) => {
    const msg = n as {
      method?: string;
      params?: { type?: string; value?: { kind?: string } };
    };
    if (
      (msg?.method === "language/status" &&
        msg.params?.type === "ServiceReady") ||
      msg?.method === "textDocument/publishDiagnostics" ||
      (msg?.method === "$/progress" && msg.params?.value?.kind === "end")
    ) {
      markReady();
    }
  });
  readyTimer = setTimeout(markReady, LSP_READY_FALLBACK_MS);

  let released = false;
  // LanguageServerOptions extends FeatureOptions directly -- feature flags are
  // top-level, not nested under a featureOptions key.
  const extension = languageServerWithClient({
    client,
    documentUri: pathToFileUri(path),
    languageId: lang.languageId,
    // Render hover / completion / signature docs as sanitized HTML so markdown
    // shows formatted instead of raw (marimo only invokes the renderer here).
    allowHTMLContent: true,
    markdownRenderer: renderLspMarkdown,
    // LSP completion is the editor's only completer.
    completionEnabled: true,
    // Apply completions as CodeMirror snippets so our rewritten `name($0)`
    // (see completionRewrite.ts) lands the cursor inside the empty parens
    // instead of inserting a literal "$0". Default is false (raw text insert).
    useSnippetOnCompletion: true,
    hoverEnabled: true,
    diagnosticsEnabled: true,
    // Go-to-definition is handled by goToDefinitionExtension (added below) so we
    // can underline on Cmd/Ctrl-hover, scroll to same-file targets, and show a
    // "No definition found" tooltip. Disable marimo's so they don't both fire.
    definitionEnabled: false,
    renameEnabled: false,
    codeActionsEnabled: true,
    signatureHelpEnabled: true,
  });
  return {
    kind: "ready",
    handle: {
      extension: [
        extension,
        fileLinkClickHandler(onOpenFileAt),
        goToDefinitionExtension({
          client,
          documentUri: pathToFileUri(path),
          onOpenFileAt,
          scrollToLine,
        }),
      ],
      status,
      format: (view: EditorView) => formatDocument(client, view, path),
      release: () => {
        if (released) return;
        released = true;
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        offReady();
        offError();
        releaseLspClient(lang.server, workspaceRoot);
      },
    },
  };
}
