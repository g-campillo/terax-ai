# Editor LSP and Autocompletion Design

Date: 2026-06-11
Status: Approved

## Context

Terax has a built-in CodeMirror 6 text editor with syntax highlighting (lazy language modes in `src/modules/editor/lib/languageResolver.ts`), an AI ghost-text autocomplete (`src/modules/editor/lib/autocomplete/`), and an unused `lintGutter()`. It has no semantic intelligence: no real completions, no diagnostics, no hover, no go-to-definition. This design adds Language Server Protocol support so the editor behaves like an IDE.

## Decisions

- Feature scope v1: completions, diagnostics, hover, go-to-definition. Rename, code actions, signature help, and formatting are out of scope for v1.
- Server acquisition: probe PATH first; otherwise auto-download into Terax's data dir (the Zed/Helix model). Bundle weight is explicitly deprioritized for this feature.
- Launch languages: TypeScript/JavaScript, Python, Rust, Go, Java, Swift, Kotlin. Swift is detect-only (sourcekit-lsp ships with the Xcode/Swift toolchain). Java requires a detected Java 17+ runtime. gopls is detect or `go install`.
- AI interplay: the LSP completion popup is active only when the AI ghost-text autocomplete setting is off. Hover, diagnostics, and go-to-definition are independent of that setting.
- Architecture: Rust is a dumb pipe (spawn plus stdio Content-Length framing); all LSP protocol logic lives in the frontend via `@marimo-team/codemirror-languageserver` with a custom Tauri transport. Mirrors the existing PTY bridge pattern (Channel streaming, invoke writes). No open ports.

## Architecture

```
EditorPane (CodeMirror 6)
  +- @marimo-team/codemirror-languageserver extensions
       +- TauriLspTransport (src/modules/editor/lib/lsp/transport.ts)
            +- invoke("lsp_send")            (client to server)
            +- Channel<LspEvent>             (server to client, lifecycle events)
src-tauri/src/modules/lsp/
  +- session.rs   spawn server, frame stdio, forward bytes (no JSON parsing beyond framing)
  +- framing.rs   pure Content-Length codec
  +- registry.rs  language to { language_ids, binary_names, args, acquisition }
  +- acquire.rs   PATH probe, github-release download, managed-node npm install, toolchain detect
```

One server process per (server, workspace_root), shared by all editor panes; ref-counted on the frontend; idle shutdown after roughly 5 minutes with no open documents, so the feature costs nothing when unused.

## Rust module (src-tauri/src/modules/lsp/)

- Commands: `lsp_start(language, workspace_root, on_event) -> session_id` (deduped per server and workspace root), `lsp_send(session_id, message)`, `lsp_stop(session_id)`, `lsp_server_status(language)`, `lsp_install_server(language)` (progress events), `lsp_uninstall_server(language)`. `workspace_root` gates through the existing workspace authorization registry, like git and shell commands.
- `framing.rs`: pure incremental Content-Length decoder and encoder. Handles partial reads, multiple messages per chunk, and an oversized-frame guard.
- `session.rs`: `LspState (RwLock<HashMap<u32, Session>>)` modeled on `PtyState`. Reader thread decodes frames and emits `LspEvent::Message` plus `Exited` and `Error` through a Tauri Channel. Kill on drop. Windows children are assigned to a Job Object (pattern from `pty/job.rs`).
- `registry.rs` launch set and acquisition strategies:
  - typescript-language-server (ts/tsx/js/jsx): npm
  - pyright-langserver (py): npm
  - rust-analyzer (rs): github-release
  - gopls (go): toolchain, hint `go install golang.org/x/tools/gopls@latest`
  - jdtls (java): release download, requires detected Java 17+
  - sourcekit-lsp (swift): toolchain only (`xcrun --find sourcekit-lsp` on macOS, PATH elsewhere)
  - kotlin-lsp (kt): github-release, requires Java runtime
- `acquire.rs`: PATH probe always runs first. github-release downloads are platform and arch matched, checksum verified, version pinned, and installed atomically into the app data dir. npm servers use one managed standalone Node runtime downloaded once into the data dir, then pinned package installs. Toolchain strategy is detect-only and returns Found or Missing with an install hint.

## Frontend (src/modules/editor/lib/lsp/)

- `transport.ts`: adapter implementing the package transport interface over invoke plus Channel; surfaces server exit and error to the client layer.
- `client.ts`: module-scoped cache of clients per server and workspace root, ref-counted by open editor panes (pattern from `chatStore.ts`). Releases trigger `lsp_stop` after an idle delay. Workspace root comes from the tab cwd in forward-slash canonical form.
- `extension.ts`: builds the per-file CM6 extension. Diagnostics wire into the existing lint gutter plus squiggles. Hover tooltips are themed with app CSS variables. Go-to-definition on Cmd/Ctrl-click: same file uses the existing `gotoLine` handle; cross-file opens an editor tab via `useTabs` then `gotoLine`.
- EditorPane integration: a new `lspCompartment`, resolved in the same async flow that loads language modes; degrades to an empty extension when no server matches or the feature is off.
- Completion gating invariant: the LSP completion source is included only when AI ghost-text autocomplete is disabled in preferences; reconfigured live via the compartment on preference change.

## UX

- Status bar indicator for the active editor tab: downloading (with percent), starting, healthy (language name), error. Click opens restart and settings actions.
- Missing server on file open: one non-blocking status-bar hint (existing preview-pill pattern), never a modal. The editor works exactly as today without a server.
- Settings: master language-intelligence toggle (default on) plus a per-language row with status (not installed, installed with version, found on PATH, toolchain missing with hint) and Install/Uninstall buttons with progress.

## Error handling

- Server crash: auto-restart with backoff (max 3 attempts), then a failed state in the status bar and plain editing.
- Download failure: toast with retry; never blocks opening files.
- Malformed or oversized server output: drop the frame, log, keep the session alive.
- Downloaded binaries execute only from the Terax data dir, versions pinned, checksums verified for release downloads.

## Testing

- Rust: framing codec unit tests; registry resolution and platform asset selection tests; an integration test that spawns a scripted fake LSP server and verifies the initialize round-trip through the channel (pattern from `tests/shell_background.rs`).
- Frontend (vitest): transport adapter with mocked invoke and Channel; language-to-server mapping; the AI-off versus LSP-completions gating invariant; client ref-count and idle-release logic.
- Manual gate: open this repo in Terax. A TS file gets completions, hover, diagnostics, and cross-file go-to-definition. A Rust file exercises the rust-analyzer download path. Quitting Terax leaves no orphaned server processes. Closing all editor tabs releases the server after the idle timeout.
