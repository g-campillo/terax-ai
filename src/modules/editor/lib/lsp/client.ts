import { LanguageServerClient } from "@marimo-team/codemirror-languageserver";
import { TauriLspTransport } from "./transport";
import { pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1000;

type Entry = {
  client: LanguageServerClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  errorListeners: Set<(message: string) => void>;
};

const entries = new Map<string, Entry>();

const keyOf = (language: string, root: string) => `${language}\0${root}`;

function buildClient(language: string, root: string, key: string): LanguageServerClient {
  const rootUri = pathToFileUri(root);
  return new LanguageServerClient({
    transport: new TauriLspTransport({
      language,
      workspaceRoot: root,
      onExit: (code) => {
        const entry = entries.get(key);
        // Normal shutdown path: entry removed or no live refs.
        if (!entry || entry.refs <= 0) return;
        if (entry.restarts >= MAX_RESTARTS) {
          // Only fire the first time restarts are exhausted; subsequent exits are silent.
          if (entry.errorListeners.size > 0) {
            const msg = `language server crashed repeatedly (exit code ${code})`;
            for (const listener of entry.errorListeners) {
              listener(msg);
            }
            entry.errorListeners.clear();
          }
          return;
        }
        entry.restarts += 1;
        const delay = RESTART_BASE_MS * 2 ** (entry.restarts - 1);
        entry.restartTimer = setTimeout(() => {
          entry.restartTimer = null;
          const current = entries.get(key);
          if (!current || current.refs <= 0) return;
          current.client = buildClient(language, root, key);
        }, delay);
      },
    }),
    rootUri,
    workspaceFolders: [
      { name: root.split("/").filter(Boolean).pop() ?? root, uri: rootUri },
    ],
  });
}

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
  const client = buildClient(language, root, key);
  entries.set(key, {
    client,
    refs: 1,
    idleTimer: null,
    restarts: 0,
    restartTimer: null,
    errorListeners: new Set(),
  });
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
    const key = keyOf(language, root);
    // Remove from cache first so a re-acquire during close() gets a fresh client.
    entries.delete(key);
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    entry.client.close();
  }, IDLE_SHUTDOWN_MS);
}

export function onLspClientError(
  language: string,
  root: string,
  listener: (message: string) => void,
): () => void {
  const entry = entries.get(keyOf(language, root));
  if (!entry) return () => {};
  entry.errorListeners.add(listener);
  return () => {
    entry.errorListeners.delete(listener);
  };
}

export function __resetLspClientsForTest(): void {
  for (const entry of entries.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
  }
  entries.clear();
}
