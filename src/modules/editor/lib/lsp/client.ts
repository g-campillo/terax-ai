import { LanguageServerClient } from "@marimo-team/codemirror-languageserver";
import { TauriLspTransport } from "./transport";
import { pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1000;
// Once a (re)started server stays up this long it's considered healthy and its
// restart budget resets — so an early one-off crash doesn't permanently count
// against a server that later runs fine for hours.
const STABLE_UPTIME_MS = 60_000;
// Heavyweight servers (jdtls, sourcekit-lsp) routinely need far longer than the
// marimo client's 10s default to answer the first completion or to finish
// `initialize` while they index a project. Without a generous ceiling those
// slow-but-healthy responses are rejected and silently dropped, so completions
// never appear. The client uses this for every request and 3x it for initialize.
const LSP_REQUEST_TIMEOUT_MS = 60_000;

type Entry = {
  client: LanguageServerClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  // Fires after STABLE_UPTIME_MS of a live (re)started client to reset `restarts`.
  stableTimer: ReturnType<typeof setTimeout> | null;
  errorListeners: Set<(message: string) => void>;
  errored: boolean;
};

// Start the stable-uptime timer for an entry's current client; resets the
// restart budget if the server is still up when it fires.
function armStableTimer(key: string, entry: Entry): void {
  if (entry.stableTimer) clearTimeout(entry.stableTimer);
  entry.stableTimer = setTimeout(() => {
    const e = entries.get(key);
    if (!e) return;
    e.restarts = 0;
    e.stableTimer = null;
  }, STABLE_UPTIME_MS);
}

const entries = new Map<string, Entry>();

const keyOf = (language: string, root: string) => `${language}\0${root}`;

function buildClient(
  language: string,
  root: string,
  key: string,
): LanguageServerClient {
  const rootUri = pathToFileUri(root);
  return new LanguageServerClient({
    transport: new TauriLspTransport({
      language,
      workspaceRoot: root,
      onExit: (code) => {
        const entry = entries.get(key);
        // Normal shutdown path: entry removed or no live refs.
        if (!entry || entry.refs <= 0) return;
        // This client just died, so it never reached stable uptime.
        if (entry.stableTimer) {
          clearTimeout(entry.stableTimer);
          entry.stableTimer = null;
        }
        if (entry.restarts >= MAX_RESTARTS) {
          // Mark entry permanently dead so a later acquire can self-heal.
          entry.errored = true;
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
          // Release JS resources from the dead client before replacing it.
          try {
            current.client.close();
          } catch {
            // Process is already gone; ignore close errors.
          }
          current.client = buildClient(language, root, key);
          // If this replacement survives, clear the accumulated restart count.
          armStableTimer(key, current);
        }, delay);
      },
    }),
    rootUri,
    workspaceFolders: [
      { name: root.split("/").filter(Boolean).pop() ?? root, uri: rootUri },
    ],
    timeout: LSP_REQUEST_TIMEOUT_MS,
    // Force servers to report capabilities statically in the initialize
    // response. With dynamicRegistration enabled, jdtls / sourcekit-lsp omit
    // `completionProvider` (etc.) and register them later via
    // client/registerCapability -- which this client doesn't process, so the
    // capability never lands and completion/hover/definition silently no-op.
    capabilities: (defaults) => ({
      ...defaults,
      textDocument: {
        ...defaults?.textDocument,
        completion: {
          ...defaults?.textDocument?.completion,
          dynamicRegistration: false,
        },
        hover: {
          ...defaults?.textDocument?.hover,
          dynamicRegistration: false,
        },
        definition: {
          ...defaults?.textDocument?.definition,
          dynamicRegistration: false,
        },
        signatureHelp: {
          ...defaults?.textDocument?.signatureHelp,
          dynamicRegistration: false,
        },
        codeAction: {
          ...defaults?.textDocument?.codeAction,
          dynamicRegistration: false,
        },
        // textDocument/formatting is requested directly (see format.ts); it
        // still has to register statically or jdtls / sourcekit-lsp won't
        // advertise documentFormattingProvider in the initialize response.
        formatting: {
          ...defaults?.textDocument?.formatting,
          dynamicRegistration: false,
        },
      },
    }),
  });
}

export function acquireLspClient(
  language: string,
  root: string,
): LanguageServerClient {
  const key = keyOf(language, root);
  const existing = entries.get(key);
  if (existing) {
    if (existing.errored) {
      // The previous server exhausted its restart budget; replace it so the
      // caller gets a live client rather than a permanently dead one.
      try {
        existing.client.close();
      } catch {
        // Best-effort; the process is already dead.
      }
      if (existing.restartTimer) {
        clearTimeout(existing.restartTimer);
        existing.restartTimer = null;
      }
      if (existing.stableTimer) {
        clearTimeout(existing.stableTimer);
        existing.stableTimer = null;
      }
      const fresh = buildClient(language, root, key);
      entries.set(key, {
        client: fresh,
        // Preserve the ref count from existing holders plus this new caller.
        refs: existing.refs + 1,
        idleTimer: null,
        restarts: 0,
        restartTimer: null,
        stableTimer: null,
        errorListeners: existing.errorListeners,
        errored: false,
      });
      return fresh;
    }
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
    stableTimer: null,
    errorListeners: new Set(),
    errored: false,
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
    if (entry.stableTimer) {
      clearTimeout(entry.stableTimer);
      entry.stableTimer = null;
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
  // If the entry is already in the errored state, fire immediately so the
  // caller does not register a listener that can never be invoked.
  if (entry.errored) {
    listener("language server crashed repeatedly");
    return () => {};
  }
  entry.errorListeners.add(listener);
  return () => {
    entry.errorListeners.delete(listener);
  };
}

export function __resetLspClientsForTest(): void {
  for (const entry of entries.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
  }
  entries.clear();
}
