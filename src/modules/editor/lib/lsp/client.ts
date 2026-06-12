import { LanguageServerClient } from "@marimo-team/codemirror-languageserver";
import { TauriLspTransport } from "./transport";
import { pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

type Entry = {
  client: LanguageServerClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, Entry>();

const keyOf = (language: string, root: string) => `${language}\0${root}`;

export function acquireLspClient(
  language: string,
  root: string,
): LanguageServerClient {
  const key = keyOf(language, root);
  const existing = entries.get(key);
  if (existing) {
    existing.refs += 1;
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing.client;
  }
  const rootUri = pathToFileUri(root);
  const client = new LanguageServerClient({
    transport: new TauriLspTransport({ language, workspaceRoot: root }),
    rootUri,
    workspaceFolders: [
      { name: root.split("/").filter(Boolean).pop() ?? root, uri: rootUri },
    ],
  });
  entries.set(key, { client, refs: 1, idleTimer: null });
  return client;
}

export function releaseLspClient(language: string, root: string): void {
  const entry = entries.get(keyOf(language, root));
  if (!entry) return;
  if (entry.refs <= 0) {
    console.warn("lsp: releaseLspClient called more times than acquire");
    return;
  }
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.idleTimer = setTimeout(() => {
    // Remove from cache first so a re-acquire during close() gets a fresh client.
    entries.delete(keyOf(language, root));
    entry.client.close();
  }, IDLE_SHUTDOWN_MS);
}

export function __resetLspClientsForTest(): void {
  for (const entry of entries.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }
  entries.clear();
}
