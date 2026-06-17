import { usePreferencesStore } from "@/modules/settings/preferences";
import type { CompletionContext } from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";
import type { Extension } from "@codemirror/state";
import { languageServerWithClient } from "@marimo-team/codemirror-languageserver";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { acquireLspClient, onLspClientError, releaseLspClient } from "./client";
import { lspLanguageFor } from "./languages";
import { fileUriToPath, pathToFileUri } from "./uri";

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
  onServerError?: (message: string) => void;
  // Called once the server can serve language features (jdtls ServiceReady, or
  // first diagnostics / finished progress for servers that don't announce it).
  onReady?: () => void;
};

export async function resolveLspExtension({
  path,
  workspaceRoot,
  onOpenFileAt,
  onServerError,
  onReady,
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
    // AI ghost text is being removed; LSP completion is always on.
    completionEnabled: true,
    // TEMP debug: marimo appends this source after its own, so it runs on every
    // completion query and records the guard state to Terax.log (remove later).
    completionConfig: {
      override: [
        (ctx: CompletionContext) => {
          const c = client as unknown as {
            ready?: boolean;
            capabilities?: { completionProvider?: unknown };
          };
          void logWarn(
            `[lsp-debug] ${lang.languageId} explicit=${ctx.explicit} ready=${c.ready} hasCaps=${!!c.capabilities} completionProvider=${!!c.capabilities?.completionProvider} before=${JSON.stringify(ctx.state.sliceDoc(Math.max(0, ctx.pos - 12), ctx.pos))}`,
          );
          return null;
        },
      ],
    },
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
