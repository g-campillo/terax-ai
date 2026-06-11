# Editor LSP Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the CodeMirror editor real LSP features (completions, diagnostics, hover, go-to-definition) backed by language servers found on PATH, with Rust as a dumb stdio pipe.

**Architecture:** A new Rust module `src-tauri/src/modules/lsp/` spawns language servers and does only Content-Length framing; raw JSON-RPC strings flow webview to server via `invoke("lsp_send")` and back via a Tauri `Channel<LspEvent>` (the PTY bridge pattern). The frontend uses `@marimo-team/codemirror-languageserver` with a custom `@open-rpc/client-js` Transport. One server per (language, workspace root), ref-counted, idle-shutdown after 5 minutes.

**Tech Stack:** Rust (std::process + shared_child, already a dependency), Tauri 2 Channels, `@marimo-team/codemirror-languageserver`, CodeMirror 6, zustand, vitest, cargo test.

**Conventions (from TERAX.md):** pnpm only. Imports always `@/...`. No em-dash, no emojis, comments only for why. Gates before claiming done: `pnpm lint`, `pnpm check-types`, `pnpm test`, `cd src-tauri && cargo clippy && cargo test --locked`.

**Spec:** `docs/superpowers/specs/2026-06-11-editor-lsp-design.md`. Server auto-download (acquire.rs, npm/node runtime, install UI) is a separate follow-up plan; this plan ships PATH-detected servers only, with install hints when missing.

---

### Task 1: Rust Content-Length framing codec

**Files:**
- Create: `src-tauri/src/modules/lsp/framing.rs`
- Create: `src-tauri/src/modules/lsp/mod.rs` (module shell only for now)
- Modify: `src-tauri/src/modules/mod.rs` (add `pub mod lsp;`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/modules/lsp/framing.rs` containing only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_produces_content_length_header() {
        let frame = encode_frame("{}");
        assert_eq!(frame, b"Content-Length: 2\r\n\r\n{}");
    }

    #[test]
    fn decodes_single_complete_frame() {
        let mut d = FrameDecoder::default();
        let msgs = d.push(b"Content-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(msgs, vec!["{}".to_string()]);
    }

    #[test]
    fn decodes_frame_split_across_pushes_byte_by_byte() {
        let mut d = FrameDecoder::default();
        let frame = encode_frame(r#"{"jsonrpc":"2.0","id":1}"#);
        let mut got = Vec::new();
        for b in frame {
            got.extend(d.push(&[b]).unwrap());
        }
        assert_eq!(got, vec![r#"{"jsonrpc":"2.0","id":1}"#.to_string()]);
    }

    #[test]
    fn decodes_two_frames_in_one_push() {
        let mut d = FrameDecoder::default();
        let mut bytes = encode_frame("{}");
        bytes.extend(encode_frame(r#"{"a":1}"#));
        let msgs = d.push(&bytes).unwrap();
        assert_eq!(msgs, vec!["{}".to_string(), r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn tolerates_extra_headers_and_case() {
        let mut d = FrameDecoder::default();
        let msgs = d
            .push(b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}")
            .unwrap();
        assert_eq!(msgs, vec!["{}".to_string()]);
    }

    #[test]
    fn rejects_missing_content_length() {
        let mut d = FrameDecoder::default();
        assert!(d.push(b"Content-Type: text\r\n\r\n{}").is_err());
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut d = FrameDecoder::default();
        let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        assert!(d.push(header.as_bytes()).is_err());
    }
}
```

Create `src-tauri/src/modules/lsp/mod.rs`:

```rust
pub mod framing;
```

Add `pub mod lsp;` to the module list in `src-tauri/src/modules/mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked lsp::framing`
Expected: compile error (encode_frame, FrameDecoder, MAX_FRAME_BYTES not defined)

- [ ] **Step 3: Implement the codec**

Add above the test module in `framing.rs`:

```rust
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub fn encode_frame(message: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 32);
    out.extend_from_slice(b"Content-Length: ");
    out.extend_from_slice(message.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(message.as_bytes());
    out
}

#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let Some(header_end) = find_header_end(&self.buf) else {
                if self.buf.len() > MAX_FRAME_BYTES {
                    return Err("lsp frame header exceeds size cap".to_string());
                }
                break;
            };
            let header = std::str::from_utf8(&self.buf[..header_end])
                .map_err(|_| "lsp frame header is not utf-8".to_string())?;
            let len = parse_content_length(header)?;
            if len > MAX_FRAME_BYTES {
                return Err(format!("lsp frame body of {len} bytes exceeds cap"));
            }
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break;
            }
            let body = std::str::from_utf8(&self.buf[body_start..body_start + len])
                .map_err(|_| "lsp frame body is not utf-8".to_string())?
                .to_string();
            self.buf.drain(..body_start + len);
            messages.push(body);
        }
        Ok(messages)
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> Result<usize, String> {
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse()
                .map_err(|_| format!("invalid content-length: {value}"));
        }
    }
    Err("missing content-length header".to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked lsp::framing`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/lsp/ src-tauri/src/modules/mod.rs
git commit -m "feat(lsp): add content-length framing codec"
```

---

### Task 2: Rust server registry with PATH probe

**Files:**
- Create: `src-tauri/src/modules/lsp/registry.rs`
- Modify: `src-tauri/src/modules/lsp/mod.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/modules/lsp/registry.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_typescript_family_to_one_server() {
        for ext in ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] {
            assert_eq!(server_for_extension(ext).unwrap().id, "typescript");
        }
    }

    #[test]
    fn maps_each_launch_language() {
        assert_eq!(server_for_extension("py").unwrap().id, "python");
        assert_eq!(server_for_extension("rs").unwrap().id, "rust");
        assert_eq!(server_for_extension("go").unwrap().id, "go");
        assert_eq!(server_for_extension("java").unwrap().id, "java");
        assert_eq!(server_for_extension("swift").unwrap().id, "swift");
        assert_eq!(server_for_extension("kt").unwrap().id, "kotlin");
        assert_eq!(server_for_extension("kts").unwrap().id, "kotlin");
    }

    #[test]
    fn unknown_extension_has_no_server() {
        assert!(server_for_extension("md").is_none());
        assert!(server_for_extension("").is_none());
    }

    #[test]
    fn server_by_id_finds_every_registered_server() {
        for def in SERVERS {
            assert_eq!(server_by_id(def.id).unwrap().id, def.id);
        }
        assert!(server_by_id("cobol").is_none());
    }

    #[test]
    fn find_binary_locates_executable_in_path_dir() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "fake-ls.exe" } else { "fake-ls" };
        let path = dir.path().join(name);
        std::fs::write(&path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = find_binary_in(&["fake-ls"], &[dir.path().to_path_buf()]);
        assert_eq!(found, Some(path));
    }

    #[test]
    fn find_binary_misses_absent_executable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(find_binary_in(&["nope-ls"], &[dir.path().to_path_buf()]).is_none());
    }
}
```

Add `pub mod registry;` to `src-tauri/src/modules/lsp/mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked lsp::registry`
Expected: compile error (SERVERS, server_for_extension, server_by_id, find_binary_in not defined)

- [ ] **Step 3: Implement the registry**

Add above the tests:

```rust
use std::path::PathBuf;

pub struct ServerDef {
    pub id: &'static str,
    pub display: &'static str,
    pub extensions: &'static [&'static str],
    pub binaries: &'static [&'static str],
    pub args: &'static [&'static str],
    pub install_hint: &'static str,
}

pub const SERVERS: &[ServerDef] = &[
    ServerDef {
        id: "typescript",
        display: "TypeScript / JavaScript",
        extensions: &["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
        binaries: &["typescript-language-server"],
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
    },
    ServerDef {
        id: "python",
        display: "Python",
        extensions: &["py", "pyi"],
        binaries: &["basedpyright-langserver", "pyright-langserver"],
        args: &["--stdio"],
        install_hint: "npm install -g pyright",
    },
    ServerDef {
        id: "rust",
        display: "Rust",
        extensions: &["rs"],
        binaries: &["rust-analyzer"],
        args: &[],
        install_hint: "rustup component add rust-analyzer",
    },
    ServerDef {
        id: "go",
        display: "Go",
        extensions: &["go"],
        binaries: &["gopls"],
        args: &[],
        install_hint: "go install golang.org/x/tools/gopls@latest",
    },
    ServerDef {
        id: "java",
        display: "Java",
        extensions: &["java"],
        binaries: &["jdtls"],
        args: &[],
        install_hint: "install Eclipse JDT Language Server and a Java 17+ runtime",
    },
    ServerDef {
        id: "swift",
        display: "Swift",
        extensions: &["swift"],
        binaries: &["sourcekit-lsp"],
        args: &[],
        install_hint: "install Xcode or the Swift toolchain",
    },
    ServerDef {
        id: "kotlin",
        display: "Kotlin",
        extensions: &["kt", "kts"],
        binaries: &["kotlin-lsp", "kotlin-language-server"],
        args: &["--stdio"],
        install_hint: "install the JetBrains Kotlin LSP (kotlin-lsp) and a Java runtime",
    },
];

pub fn server_for_extension(ext: &str) -> Option<&'static ServerDef> {
    let ext = ext.to_ascii_lowercase();
    SERVERS.iter().find(|d| d.extensions.contains(&ext.as_str()))
}

pub fn server_by_id(id: &str) -> Option<&'static ServerDef> {
    SERVERS.iter().find(|d| d.id == id)
}

// GUI apps on macOS inherit a minimal PATH from launchd, so probe the common
// toolchain install dirs in addition to PATH.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        for extra in [".cargo/bin", "go/bin", ".local/bin"] {
            out.push(home.join(extra));
        }
    }
    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/opt/homebrew/bin"));
        out.push(PathBuf::from("/usr/local/bin"));
    }
    out
}

pub fn find_binary_in(names: &[&str], dirs: &[PathBuf]) -> Option<PathBuf> {
    #[cfg(windows)]
    let suffixes: &[&str] = &[".exe", ".cmd", ".bat"];
    #[cfg(not(windows))]
    let suffixes: &[&str] = &[""];
    for dir in dirs {
        for name in names {
            for suffix in suffixes {
                let p = dir.join(format!("{name}{suffix}"));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

pub fn resolve_binary(def: &ServerDef) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    if def.id == "swift" {
        if let Ok(out) = std::process::Command::new("xcrun")
            .args(["--find", "sourcekit-lsp"])
            .output()
        {
            if out.status.success() {
                let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    find_binary_in(def.binaries, &candidate_dirs())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked lsp::registry`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/lsp/
git commit -m "feat(lsp): add server registry with path probe"
```

---

### Task 3: Rust LSP session (spawn, pipe, lifecycle)

**Files:**
- Create: `src-tauri/src/modules/lsp/session.rs`
- Modify: `src-tauri/src/modules/lsp/mod.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs:3-4` (make the Windows job module crate-visible: `pub(crate) mod job;`)

The session layer is callback-based (no Tauri types) so it is testable without a Tauri runtime, like `shell/background.rs`.

- [ ] **Step 1: Write the failing test (unix-gated, like session tests in pty)**

Create `src-tauri/src/modules/lsp/session.rs` with the test module first:

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn reads_framed_message_and_reports_exit() {
        let (msg_tx, msg_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let script = r#"printf 'Content-Length: 13\r\n\r\n{"jsonrpc":2}'"#;
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            move |m| {
                let _ = msg_tx.send(m);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn fake lsp");
        let msg = msg_rx.recv_timeout(Duration::from_secs(5)).expect("message");
        assert_eq!(msg, r#"{"jsonrpc":2}"#);
        let code = exit_rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        assert_eq!(code, 0);
        drop(session);
    }

    #[test]
    fn send_writes_framed_bytes_to_child_stdin() {
        let (msg_tx, msg_rx) = mpsc::channel::<String>();
        // cat echoes our framed message straight back; decoding it proves the
        // frame we wrote was well formed.
        let session = spawn(
            "/bin/cat",
            &[],
            "/tmp",
            move |m| {
                let _ = msg_tx.send(m);
            },
            |_| {},
        )
        .expect("spawn cat");
        session.send(r#"{"id":1}"#).expect("send");
        let echoed = msg_rx.recv_timeout(Duration::from_secs(5)).expect("echo");
        assert_eq!(echoed, r#"{"id":1}"#);
        session.kill();
    }

    #[test]
    fn kill_terminates_child() {
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            "/tmp",
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn");
        session.kill();
        exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("exit after kill");
    }
}
```

Add `pub mod session;` to `src-tauri/src/modules/lsp/mod.rs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --locked lsp::session`
Expected: compile error (spawn, LspSession not defined)

- [ ] **Step 3: Implement the session**

Add above the tests in `session.rs`:

```rust
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use shared_child::SharedChild;

use super::framing::{encode_frame, FrameDecoder};

const READ_BUF: usize = 64 * 1024;

pub struct LspSession {
    child: Arc<SharedChild>,
    stdin: Mutex<ChildStdin>,
    // Closing the Job handle on drop kills the server's descendants if the
    // Terax process dies without a clean lsp_stop (same rationale as pty).
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
}

impl LspSession {
    pub fn send(&self, message: &str) -> Result<(), String> {
        let frame = encode_frame(message);
        let mut stdin = self.stdin.lock().unwrap();
        stdin.write_all(&frame).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        let _ = self.child.kill();
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn spawn(
    program: &str,
    args: &[String],
    cwd: &str,
    on_message: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(i32) + Send + 'static,
) -> Result<Arc<LspSession>, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);

    #[cfg(windows)]
    let job = crate::modules::pty::job::PtyJob::create_for(child.id())
        .map_err(|e| log::warn!("lsp job-object setup failed: {e}"))
        .ok();

    let stdin = child
        .take_stdin()
        .ok_or_else(|| "lsp child stdin unavailable".to_string())?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "lsp child stdout unavailable".to_string())?;
    let stderr = child.take_stderr();

    let killer = child.clone();
    thread::Builder::new()
        .name("terax-lsp-reader".into())
        .spawn(move || {
            let mut stdout = stdout;
            let mut decoder = FrameDecoder::default();
            let mut buf = [0u8; READ_BUF];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => match decoder.push(&buf[..n]) {
                        Ok(msgs) => {
                            for m in msgs {
                                on_message(m);
                            }
                        }
                        Err(e) => {
                            log::warn!("lsp stream corrupt, killing server: {e}");
                            let _ = killer.kill();
                            break;
                        }
                    },
                    Err(e) => {
                        log::debug!("lsp reader ended: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    if let Some(stderr) = stderr {
        thread::Builder::new()
            .name("terax-lsp-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::debug!("lsp stderr: {line}");
                }
            })
            .map_err(|e| e.to_string())?;
    }

    let waiter_child = child.clone();
    thread::Builder::new()
        .name("terax-lsp-waiter".into())
        .spawn(move || {
            let code = match waiter_child.wait() {
                Ok(status) => status.code().unwrap_or(-1),
                Err(e) => {
                    log::warn!("lsp child wait failed: {e}");
                    -1
                }
            };
            on_exit(code);
        })
        .map_err(|e| e.to_string())?;

    Ok(Arc::new(LspSession {
        child,
        stdin: Mutex::new(stdin),
        #[cfg(windows)]
        _job: job,
    }))
}
```

In `src-tauri/src/modules/pty/mod.rs` change line 3-4 from:

```rust
#[cfg(windows)]
mod job;
```

to:

```rust
#[cfg(windows)]
pub(crate) mod job;
```

Note: `PtyJob::create_for` currently takes the shell pid; `SharedChild::id()` returns u32 the same way. If `shared_child`'s `take_stdin`/`take_stdout`/`take_stderr` method names differ in the pinned version, check with `cargo doc -p shared_child --open` and adjust call sites only (the structure stays).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked lsp::session`
Expected: 3 passed (on macOS/Linux; module compiles on Windows)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/lsp/ src-tauri/src/modules/pty/mod.rs
git commit -m "feat(lsp): add stdio session with framing and lifecycle"
```

---

### Task 4: Tauri commands and registration

**Files:**
- Modify: `src-tauri/src/modules/lsp/mod.rs`
- Modify: `src-tauri/src/lib.rs` (manage `LspState`, register commands)

- [ ] **Step 1: Implement state, events, and commands**

Replace `src-tauri/src/modules/lsp/mod.rs` with:

```rust
pub mod framing;
pub mod registry;
pub mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::modules::workspace::WorkspaceRegistry;
use session::LspSession;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspEvent {
    #[serde(rename_all = "camelCase")]
    Message { data: String },
    #[serde(rename_all = "camelCase")]
    Exited { code: i32 },
}

pub struct LspState {
    sessions: RwLock<HashMap<u32, Arc<LspSession>>>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub language: String,
    pub display: String,
    pub available: bool,
    pub command: Option<String>,
    pub install_hint: String,
}

#[tauri::command]
pub fn lsp_status(language: String) -> Result<LspServerStatus, String> {
    let def = registry::server_by_id(&language)
        .ok_or_else(|| format!("unknown lsp language: {language}"))?;
    let command = registry::resolve_binary(def);
    Ok(LspServerStatus {
        language: def.id.to_string(),
        display: def.display.to_string(),
        available: command.is_some(),
        command: command.map(|p| p.to_string_lossy().into_owned()),
        install_hint: def.install_hint.to_string(),
    })
}

#[tauri::command]
pub fn lsp_start(
    state: tauri::State<'_, LspState>,
    registry_state: tauri::State<'_, WorkspaceRegistry>,
    language: String,
    workspace_root: String,
    on_event: Channel<LspEvent>,
) -> Result<u32, String> {
    let canonical = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("lsp_start: bad workspace root: {e}"))?;
    if !registry_state.is_authorized(&canonical) {
        return Err(format!(
            "lsp_start: workspace root outside authorized workspace: {}",
            canonical.display()
        ));
    }
    let def = registry::server_by_id(&language)
        .ok_or_else(|| format!("unknown lsp language: {language}"))?;
    let bin = registry::resolve_binary(def)
        .ok_or_else(|| format!("no server installed for {language}: {}", def.install_hint))?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let ev_msg = on_event.clone();
    let args: Vec<String> = def.args.iter().map(|s| s.to_string()).collect();
    let session = session::spawn(
        &bin.to_string_lossy(),
        &args,
        &canonical.to_string_lossy(),
        move |msg| {
            let _ = ev_msg.send(LspEvent::Message { data: msg });
        },
        move |code| {
            let _ = on_event.send(LspEvent::Exited { code });
        },
    )?;
    state.sessions.write().unwrap().insert(id, session);
    log::info!("lsp started id={id} language={language}");
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(
    state: tauri::State<'_, LspState>,
    id: u32,
    message: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no lsp session".to_string())?;
    session.send(&message)
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<'_, LspState>, id: u32) -> Result<(), String> {
    if let Some(session) = state.sessions.write().unwrap().remove(&id) {
        session.kill();
        log::info!("lsp stopped id={id}");
    }
    Ok(())
}
```

- [ ] **Step 2: Register in lib.rs**

In `src-tauri/src/lib.rs`:
- Line 3: add `lsp` to the `use modules::{...}` list.
- After `.manage(pty::PtyState::default())` add `.manage(lsp::LspState::default())`.
- In `invoke_handler` after the `pty::*` block add:

```rust
            lsp::lsp_status,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
```

- [ ] **Step 3: Verify build and full Rust gates**

Run: `cd src-tauri && cargo clippy && cargo test --locked`
Expected: no clippy warnings, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/lsp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): expose lsp_start/send/stop/status tauri commands"
```

---

### Task 5: Frontend dependency and file URI helpers

**Files:**
- Modify: `package.json` (via pnpm)
- Create: `src/modules/editor/lib/lsp/uri.ts`
- Test: `src/modules/editor/lib/lsp/uri.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @marimo-team/codemirror-languageserver`
Expected: lockfile updated; `@open-rpc/client-js` and `vscode-languageserver-protocol` arrive as transitive deps.

- [ ] **Step 2: Write the failing tests**

Create `src/modules/editor/lib/lsp/uri.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { fileUriToPath, pathToFileUri } from "./uri";

describe("pathToFileUri", () => {
  it("converts unix paths", () => {
    expect(pathToFileUri("/Users/g/proj/a.ts")).toBe("file:///Users/g/proj/a.ts");
  });
  it("converts windows drive paths in canonical forward-slash form", () => {
    expect(pathToFileUri("C:/Users/g/a.ts")).toBe("file:///C:/Users/g/a.ts");
  });
  it("normalizes backslashes", () => {
    expect(pathToFileUri("C:\\Users\\g\\a.ts")).toBe("file:///C:/Users/g/a.ts");
  });
  it("percent-encodes spaces", () => {
    expect(pathToFileUri("/a b/c.ts")).toBe("file:///a%20b/c.ts");
  });
});

describe("fileUriToPath", () => {
  it("round-trips unix paths", () => {
    expect(fileUriToPath("file:///Users/g/proj/a.ts")).toBe("/Users/g/proj/a.ts");
  });
  it("strips the leading slash from windows drive paths", () => {
    expect(fileUriToPath("file:///C:/Users/g/a.ts")).toBe("C:/Users/g/a.ts");
  });
  it("decodes percent-encoding", () => {
    expect(fileUriToPath("file:///a%20b/c.ts")).toBe("/a b/c.ts");
  });
  it("handles lowercase encoded drive colons from some servers", () => {
    expect(fileUriToPath("file:///c%3A/Users/g/a.ts")).toBe("c:/Users/g/a.ts");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test uri`
Expected: FAIL, module `./uri` not found

- [ ] **Step 4: Implement**

Create `src/modules/editor/lib/lsp/uri.ts`:

```typescript
// Canonical frontend path form is forward-slash (TERAX.md); both helpers
// stay in that form so equality checks against tab paths keep working.
export function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(prefixed)}`;
}

export function fileUriToPath(uri: string): string {
  const withoutScheme = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  const drive = withoutScheme.match(/^\/([A-Za-z]:\/.*)$/);
  return drive ? drive[1] : withoutScheme;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test uri`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/modules/editor/lib/lsp/
git commit -m "feat(editor): add lsp package and file uri helpers"
```

---

### Task 6: Tauri LSP transport adapter

**Files:**
- Create: `src/modules/editor/lib/lsp/transport.ts`
- Test: `src/modules/editor/lib/lsp/transport.test.ts`

- [ ] **Step 1: Confirm the installed Transport API**

Read `node_modules/@open-rpc/client-js/build/transports/Transport.d.ts` and `node_modules/@open-rpc/client-js/build/Request.d.ts`. Confirm:
- `Transport` is an abstract class with `protected transportRequestManager: TransportRequestManager`, abstract `connect()`, `close()`, `sendData(data, timeout?)`, and a `parseData(data)` helper.
- `TransportRequestManager` exposes `addRequest(data, timeout)`, `settlePendingRequest(requests, error?)`, `resolveResponse(payload: string)`.
- `getNotifications(data)` is exported from `Request`.

If names differ in the installed version, adapt the calls in Step 4 to the installed names; the shape of the adapter stays the same.

- [ ] **Step 2: Write the failing tests**

Create `src/modules/editor/lib/lsp/transport.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
let channelHandler: ((ev: unknown) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    set onmessage(fn: (ev: unknown) => void) {
      channelHandler = fn;
    }
  },
}));

import { TauriLspTransport } from "./transport";

describe("TauriLspTransport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    channelHandler = null;
  });

  it("starts a session on connect with language and root", async () => {
    invokeMock.mockResolvedValueOnce(7);
    const t = new TauriLspTransport({ language: "typescript", workspaceRoot: "/repo" });
    await t.connect();
    expect(invokeMock).toHaveBeenCalledWith(
      "lsp_start",
      expect.objectContaining({
        language: "typescript",
        workspaceRoot: "/repo",
        onEvent: expect.anything(),
      }),
    );
  });

  it("sends serialized payloads through lsp_send with the session id", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({ language: "typescript", workspaceRoot: "/repo" });
    await t.connect();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    void t.sendData(
      { request: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } } as never,
      1000,
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "lsp_send",
        expect.objectContaining({ id: 7, message: expect.stringContaining('"initialize"') }),
      );
    });
  });

  it("notifies onExit when the server exits", async () => {
    invokeMock.mockResolvedValue(7);
    const onExit = vi.fn();
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
      onExit,
    });
    await t.connect();
    channelHandler?.({ type: "exited", code: 1 });
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("stops the session on close", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({ language: "typescript", workspaceRoot: "/repo" });
    await t.connect();
    invokeMock.mockClear();
    t.close();
    expect(invokeMock).toHaveBeenCalledWith("lsp_stop", { id: 7 });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test transport`
Expected: FAIL, module `./transport` not found

- [ ] **Step 4: Implement the adapter**

Create `src/modules/editor/lib/lsp/transport.ts`:

```typescript
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  getNotifications,
  type JSONRPCRequestData,
} from "@open-rpc/client-js/build/Request";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";

export type LspEvent =
  | { type: "message"; data: string }
  | { type: "exited"; code: number };

type Options = {
  language: string;
  workspaceRoot: string;
  onExit?: (code: number) => void;
};

export class TauriLspTransport extends Transport {
  private sessionId: number | null = null;

  constructor(private readonly options: Options) {
    super();
  }

  async connect(): Promise<void> {
    const onEvent = new Channel<LspEvent>();
    onEvent.onmessage = (ev) => {
      if (ev.type === "message") {
        const err = this.transportRequestManager.resolveResponse(ev.data);
        if (err) console.warn("lsp: unresolved server payload", err);
      } else if (ev.type === "exited") {
        this.sessionId = null;
        this.options.onExit?.(ev.code);
      }
    };
    this.sessionId = await invoke<number>("lsp_start", {
      language: this.options.language,
      workspaceRoot: this.options.workspaceRoot,
      onEvent,
    });
  }

  async sendData(
    data: JSONRPCRequestData,
    timeout: number | null = null,
  ): Promise<unknown> {
    const prom = this.transportRequestManager.addRequest(data, timeout);
    const notifications = getNotifications(data);
    if (this.sessionId == null) {
      const err = new Error("lsp session is not connected");
      this.transportRequestManager.settlePendingRequest(notifications, err);
      throw err;
    }
    try {
      await invoke("lsp_send", {
        id: this.sessionId,
        message: JSON.stringify(this.parseData(data)),
      });
      this.transportRequestManager.settlePendingRequest(notifications);
    } catch (e) {
      this.transportRequestManager.settlePendingRequest(
        notifications,
        e instanceof Error ? e : new Error(String(e)),
      );
      throw e;
    }
    return prom;
  }

  close(): void {
    if (this.sessionId == null) return;
    const id = this.sessionId;
    this.sessionId = null;
    void invoke("lsp_stop", { id });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test transport`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add src/modules/editor/lib/lsp/
git commit -m "feat(editor): add tauri lsp transport adapter"
```

---

### Task 7: Client cache with ref-counting and idle shutdown

**Files:**
- Create: `src/modules/editor/lib/lsp/client.ts`
- Test: `src/modules/editor/lib/lsp/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/editor/lib/lsp/client.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeMock = vi.fn();
const clientCtor = vi.fn();

vi.mock("@marimo-team/codemirror-languageserver", () => ({
  LanguageServerClient: class {
    close = closeMock;
    constructor(opts: unknown) {
      clientCtor(opts);
    }
  },
}));
vi.mock("./transport", () => ({
  TauriLspTransport: class {},
}));

import { acquireLspClient, releaseLspClient } from "./client";

describe("lsp client cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    closeMock.mockClear();
    clientCtor.mockClear();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("returns the same client for the same language and root", () => {
    const a = acquireLspClient("typescript", "/repo");
    const b = acquireLspClient("typescript", "/repo");
    expect(a).toBe(b);
    expect(clientCtor).toHaveBeenCalledTimes(1);
    releaseLspClient("typescript", "/repo");
    releaseLspClient("typescript", "/repo");
  });

  it("creates distinct clients per root", () => {
    const a = acquireLspClient("typescript", "/repo-a");
    const b = acquireLspClient("typescript", "/repo-b");
    expect(a).not.toBe(b);
    releaseLspClient("typescript", "/repo-a");
    releaseLspClient("typescript", "/repo-b");
  });

  it("closes the client only after the idle delay once refs hit zero", () => {
    acquireLspClient("rust", "/repo");
    releaseLspClient("rust", "/repo");
    expect(closeMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("cancels idle shutdown when re-acquired in time", () => {
    const a = acquireLspClient("rust", "/repo");
    releaseLspClient("rust", "/repo");
    vi.advanceTimersByTime(60 * 1000);
    const b = acquireLspClient("rust", "/repo");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(closeMock).not.toHaveBeenCalled();
    expect(a).toBe(b);
    releaseLspClient("rust", "/repo");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test "lsp/client"`
Expected: FAIL, module `./client` not found

- [ ] **Step 3: Implement**

Create `src/modules/editor/lib/lsp/client.ts`:

```typescript
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

const keyOf = (language: string, root: string) => `${language} ${root}`;

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
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.idleTimer = setTimeout(() => {
    entries.delete(keyOf(language, root));
    entry.client.close();
  }, IDLE_SHUTDOWN_MS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test "lsp/client"`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/modules/editor/lib/lsp/
git commit -m "feat(editor): add ref-counted lsp client cache with idle shutdown"
```

---

### Task 8: Language mapping and LSP extension builder

**Files:**
- Create: `src/modules/editor/lib/lsp/languages.ts`
- Create: `src/modules/editor/lib/lsp/extension.ts`
- Test: `src/modules/editor/lib/lsp/languages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/editor/lib/lsp/languages.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { lspLanguageFor } from "./languages";

describe("lspLanguageFor", () => {
  it("maps the typescript family with react variants", () => {
    expect(lspLanguageFor("/r/a.ts")).toEqual({ server: "typescript", languageId: "typescript" });
    expect(lspLanguageFor("/r/a.tsx")).toEqual({ server: "typescript", languageId: "typescriptreact" });
    expect(lspLanguageFor("/r/a.js")).toEqual({ server: "typescript", languageId: "javascript" });
    expect(lspLanguageFor("/r/a.jsx")).toEqual({ server: "typescript", languageId: "javascriptreact" });
  });

  it("maps the remaining launch languages", () => {
    expect(lspLanguageFor("/r/a.py")?.server).toBe("python");
    expect(lspLanguageFor("/r/a.rs")?.server).toBe("rust");
    expect(lspLanguageFor("/r/a.go")?.server).toBe("go");
    expect(lspLanguageFor("/r/A.java")?.server).toBe("java");
    expect(lspLanguageFor("/r/a.swift")?.server).toBe("swift");
    expect(lspLanguageFor("/r/a.kt")?.server).toBe("kotlin");
  });

  it("is case-insensitive on the extension", () => {
    expect(lspLanguageFor("/r/A.TS")?.languageId).toBe("typescript");
  });

  it("returns null for unsupported files and windows paths work", () => {
    expect(lspLanguageFor("/r/readme.md")).toBeNull();
    expect(lspLanguageFor("C:\\r\\a.rs")?.server).toBe("rust");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test languages`
Expected: FAIL, module `./languages` not found

- [ ] **Step 3: Implement the mapping**

Create `src/modules/editor/lib/lsp/languages.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test languages`
Expected: 4 passed

- [ ] **Step 5: Implement the extension builder**

Create `src/modules/editor/lib/lsp/extension.ts`:

```typescript
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
  const extension = languageServerWithClient({
    client,
    documentUri: pathToFileUri(path),
    languageId: lang.languageId,
    featureOptions: {
      completionEnabled: !prefs.autocompleteEnabled,
      hoverEnabled: true,
      diagnosticsEnabled: true,
      definitionEnabled: true,
      renameEnabled: false,
      codeActionsEnabled: false,
      signatureHelpEnabled: false,
    },
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
```

Note on `featureOptions`: the plugin types it as `Required<FeatureOptions>`; if the installed version requires fields not listed here (check `node_modules/@marimo-team/codemirror-languageserver/dist/index.d.ts`), set the extra feature flags to false and keep the four core features as written. The `lspEnabled` preference is added in Task 10; until that task lands, `check-types` will flag it, so Tasks 8 through 10 should be type-checked together at Task 10 Step 5 (lint and vitest stay green per task).

- [ ] **Step 6: Run vitest suite**

Run: `pnpm test`
Expected: all suites pass

- [ ] **Step 7: Commit**

```bash
git add src/modules/editor/lib/lsp/
git commit -m "feat(editor): add lsp language mapping and extension builder"
```

---

### Task 9: Status store for the status bar

**Files:**
- Create: `src/modules/editor/lib/lsp/statusStore.ts`
- Test: `src/modules/editor/lib/lsp/statusStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/editor/lib/lsp/statusStore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { useLspStatusStore } from "./statusStore";

describe("lsp status store", () => {
  it("tracks per-path status and clears it", () => {
    const { setStatus, clearStatus } = useLspStatusStore.getState();
    setStatus("/r/a.ts", { state: "running", label: "TypeScript / JavaScript", hint: null });
    expect(useLspStatusStore.getState().byPath["/r/a.ts"]?.state).toBe("running");
    setStatus("/r/a.ts", { state: "error", label: "TypeScript / JavaScript", hint: "server exited" });
    expect(useLspStatusStore.getState().byPath["/r/a.ts"]?.state).toBe("error");
    clearStatus("/r/a.ts");
    expect(useLspStatusStore.getState().byPath["/r/a.ts"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test statusStore`
Expected: FAIL, module `./statusStore` not found

- [ ] **Step 3: Implement**

Create `src/modules/editor/lib/lsp/statusStore.ts`:

```typescript
import { create } from "zustand";

export type LspPaneStatus = {
  state: "running" | "missing" | "error";
  label: string;
  hint: string | null;
};

type State = {
  byPath: Record<string, LspPaneStatus>;
  setStatus: (path: string, status: LspPaneStatus) => void;
  clearStatus: (path: string) => void;
};

export const useLspStatusStore = create<State>((set) => ({
  byPath: {},
  setStatus: (path, status) =>
    set((s) => ({ byPath: { ...s.byPath, [path]: status } })),
  clearStatus: (path) =>
    set((s) => {
      const { [path]: _, ...rest } = s.byPath;
      return { byPath: rest };
    }),
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test statusStore`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add src/modules/editor/lib/lsp/
git commit -m "feat(editor): add per-path lsp status store"
```

---

### Task 10: Preference, EditorPane integration, and App wiring

**Files:**
- Modify: `src/modules/settings/store.ts` (Preferences type, key, default, loader, setter)
- Modify: `src/modules/editor/lib/extensions.ts` (new `lspCompartment`)
- Modify: `src/modules/editor/EditorPane.tsx` (props, compartment effect, release on unmount)
- Modify: `src/modules/editor/EditorStack.tsx` (thread new props)
- Modify: `src/app/App.tsx` (pass `explorerRoot` and `openContentHit` into `EditorStack`)

- [ ] **Step 1: Add the `lspEnabled` preference**

In `src/modules/settings/store.ts`, mirroring the `editorAutoSave` pattern exactly:
- Add `lspEnabled: boolean;` to the `Preferences` type (after `editorAutoSaveDelay`).
- Add `const KEY_LSP_ENABLED = "lspEnabled";` next to `KEY_EDITOR_AUTO_SAVE_DELAY`.
- Add `lspEnabled: true,` to `DEFAULT_PREFERENCES`.
- In `loadPreferences()` add `lspEnabled: get<boolean>(KEY_LSP_ENABLED) ?? DEFAULT_PREFERENCES.lspEnabled,`.
- Add a setter following the adjacent setters in the same file (same write helper and event emit the `setEditorAutoSave` setter uses):

```typescript
export async function setLspEnabled(value: boolean): Promise<void> {
  await writePref(KEY_LSP_ENABLED, value);
}
```

(If the file's setters use a different shared helper name, match it; copy the `editorAutoSave` setter line for line.)

- [ ] **Step 2: Add the compartment**

In `src/modules/editor/lib/extensions.ts` add next to the existing compartments:

```typescript
export const lspCompartment = new Compartment();
```

- [ ] **Step 3: Wire EditorPane**

In `src/modules/editor/EditorPane.tsx`:

Extend `Props`:

```typescript
type Props = {
  path: string;
  workspaceRoot?: string | null;
  onOpenFileAt?: (path: string, line: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};
```

Add `lspCompartment.of([])` to the `extensions` useMemo array (after `languageCompartment.of([])`), importing `lspCompartment` from `./lib/extensions`.

Add refs and the resolve effect after the existing language-compartment effect (around line 247):

```typescript
const onOpenFileAtRef = useRef(onOpenFileAt);
useEffect(() => {
  onOpenFileAtRef.current = onOpenFileAt;
}, [onOpenFileAt]);
const lspReleaseRef = useRef<(() => void) | null>(null);

useEffect(() => {
  if (doc.status !== "ready" || !workspaceRoot) return;
  let cancelled = false;

  const apply = async () => {
    const { resolveLspExtension } = await import("./lib/lsp/extension");
    const { useLspStatusStore } = await import("./lib/lsp/statusStore");
    const result = await resolveLspExtension({
      path,
      workspaceRoot,
      onOpenFileAt: (p, line) => onOpenFileAtRef.current?.(p, line),
    });
    if (cancelled) {
      if (result.kind === "ready") result.handle.release();
      return;
    }
    lspReleaseRef.current?.();
    lspReleaseRef.current = null;
    const view = cmRef.current?.view;
    if (result.kind === "ready") {
      lspReleaseRef.current = result.handle.release;
      useLspStatusStore.getState().setStatus(path, {
        state: "running",
        label: result.handle.status.display,
        hint: null,
      });
      view?.dispatch({
        effects: lspCompartment.reconfigure(result.handle.extension),
      });
    } else {
      if (result.kind === "missing-server") {
        useLspStatusStore.getState().setStatus(path, {
          state: "missing",
          label: result.status.display,
          hint: result.status.installHint,
        });
      }
      view?.dispatch({ effects: lspCompartment.reconfigure([]) });
    }
  };
  void apply();

  // Ghost-text autocomplete and the LSP popup are mutually exclusive, and
  // the master toggle can flip at runtime: rebuild on either change.
  const unsub = usePreferencesStore.subscribe((state, prev) => {
    if (
      state.autocompleteEnabled !== prev.autocompleteEnabled ||
      state.lspEnabled !== prev.lspEnabled
    ) {
      void apply();
    }
  });

  return () => {
    cancelled = true;
    unsub();
    lspReleaseRef.current?.();
    lspReleaseRef.current = null;
    void import("./lib/lsp/statusStore").then(({ useLspStatusStore }) =>
      useLspStatusStore.getState().clearStatus(path),
    );
  };
}, [path, doc.status, workspaceRoot]);
```

- [ ] **Step 4: Thread props through EditorStack and App**

In `src/modules/editor/EditorStack.tsx` extend `Props` with `workspaceRoot: string | null;` and `onOpenFileAt: (path: string, line: number) => void;` and pass both to `<EditorPane ... workspaceRoot={workspaceRoot} onOpenFileAt={onOpenFileAt} />` (plain props; they are stable or ref-wrapped inside EditorPane, so the existing per-id callback memoization pattern is not needed for them).

In `src/app/App.tsx`, at the `<EditorStack` call site, add `workspaceRoot={explorerRoot}` and `onOpenFileAt={openContentHit}` (`openContentHit` is defined around `App.tsx:953` and already opens a file tab and jumps to a line).

- [ ] **Step 5: Type-check, lint, vitest**

Run: `pnpm check-types && pnpm lint && pnpm test`
Expected: all pass (this step also clears the Task 8 forward reference to `lspEnabled`)

- [ ] **Step 6: Commit**

```bash
git add src/modules/settings/store.ts src/modules/editor/ src/app/App.tsx
git commit -m "feat(editor): wire lsp extension into editor panes"
```

---

### Task 11: Settings toggle and status bar pill

**Files:**
- Modify: `src/settings/sections/GeneralSection.tsx` (LSP toggle row)
- Create: `src/modules/statusbar/LspStatusPill.tsx`
- Modify: `src/modules/statusbar/StatusBar.tsx` (render the pill)

- [ ] **Step 1: Add the settings toggle**

In `src/settings/sections/GeneralSection.tsx`, locate the editor auto-save row (it uses the shared `SettingRow` component and a `Switch`) and add a sibling row above it, copying its exact structure:

- Label: `Language intelligence`
- Description: `Completions, errors, hover docs, and go-to-definition from language servers found on this machine.`
- Value: `prefs.lspEnabled`, onChange: `void setLspEnabled(checked)` with `setLspEnabled` imported from `@/modules/settings/store`.

Match the file's existing row markup exactly; only the label, description, preference key, and setter differ.

- [ ] **Step 2: Create the status pill**

Create `src/modules/statusbar/LspStatusPill.tsx`:

```tsx
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLspStatusStore } from "@/modules/editor/lib/lsp/statusStore";
import { cn } from "@/lib/utils";

type Props = { filePath: string | null | undefined };

export function LspStatusPill({ filePath }: Props) {
  const status = useLspStatusStore((s) =>
    filePath ? s.byPath[filePath] : undefined,
  );
  if (!status) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
            status.state === "running" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            status.state === "missing" &&
              "bg-muted text-muted-foreground",
            status.state === "error" &&
              "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
        >
          {status.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-[11px] leading-relaxed">
        {status.state === "running" && "Language server connected."}
        {status.state === "missing" &&
          `No language server found. Install with: ${status.hint ?? ""}`}
        {status.state === "error" && (status.hint ?? "Language server error.")}
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 3: Render it in the status bar**

In `src/modules/statusbar/StatusBar.tsx`, import `LspStatusPill` and render `<LspStatusPill filePath={filePath} />` inside the left section, after the `CwdBreadcrumb` element (before the private pill).

- [ ] **Step 4: Theme LSP tooltips with app variables**

In `src/modules/editor/lib/extensions.ts`, add to the `EditorView.theme({...})` object (next to the `.cm-panels` entry):

```typescript
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 10%, transparent)",
        color: "var(--popover-foreground)",
      },
```

- [ ] **Step 5: Full gates**

Run: `pnpm lint && pnpm check-types && pnpm test && cd src-tauri && cargo clippy && cargo test --locked`
Expected: everything green

- [ ] **Step 6: Commit**

```bash
git add src/settings/sections/GeneralSection.tsx src/modules/statusbar/ src/modules/editor/lib/extensions.ts
git commit -m "feat(editor): add lsp settings toggle, status pill, themed tooltips"
```

---

### Task 12: Crash restart with backoff and manual verification

**Files:**
- Modify: `src/modules/editor/lib/lsp/client.ts` (restart on unexpected exit)
- Test: extend `src/modules/editor/lib/lsp/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `client.test.ts` (the mock for `./transport` must be extended to capture the constructor options so the test can fire `onExit`):

```typescript
const transportCtor = vi.fn();
vi.mock("./transport", () => ({
  TauriLspTransport: class {
    constructor(opts: unknown) {
      transportCtor(opts);
    }
  },
}));
```

```typescript
it("recreates the client on unexpected exit at most three times", () => {
  acquireLspClient("go", "/repo");
  expect(clientCtor).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 5; i++) {
    const opts = transportCtor.mock.calls.at(-1)?.[0] as { onExit?: (c: number) => void };
    opts.onExit?.(1);
    vi.runOnlyPendingTimers();
  }
  // 1 initial + 3 restarts, then gives up
  expect(clientCtor).toHaveBeenCalledTimes(4);
  releaseLspClient("go", "/repo");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test "lsp/client"`
Expected: FAIL (restart logic absent; clientCtor called once)

- [ ] **Step 3: Implement restart with backoff**

In `client.ts`, replace the client construction in `acquireLspClient` with a small factory the entry retains, and track restarts:

```typescript
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 1000;

type Entry = {
  client: LanguageServerClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restarts: number;
};

function buildClient(language: string, root: string, key: string): LanguageServerClient {
  const rootUri = pathToFileUri(root);
  return new LanguageServerClient({
    transport: new TauriLspTransport({
      language,
      workspaceRoot: root,
      onExit: () => {
        const entry = entries.get(key);
        if (!entry || entry.refs <= 0 || entry.restarts >= MAX_RESTARTS) return;
        entry.restarts += 1;
        setTimeout(() => {
          const live = entries.get(key);
          if (!live || live.refs <= 0) return;
          live.client = buildClient(language, root, key);
        }, RESTART_BASE_MS * 2 ** (entry.restarts - 1));
      },
    }),
    rootUri,
    workspaceFolders: [
      { name: root.split("/").filter(Boolean).pop() ?? root, uri: rootUri },
    ],
  });
}
```

and in `acquireLspClient` create entries via `buildClient(language, root, key)` with `restarts: 0`.

Known limitation to note in the commit body: already-open panes keep their old plugin instance until the file is reopened or re-resolved; the restart primarily protects newly opened panes and shared-root siblings. Full hot-reattach is out of scope for v1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test "lsp/client"`
Expected: all client tests pass

- [ ] **Step 5: Manual verification (requires a machine with servers installed)**

Run: `pnpm tauri dev`, open this repo, then:
1. With AI autocomplete OFF (Settings, Autocomplete): open `src/app/App.tsx`, type `usePref` and confirm an LSP completion popup appears; hover a symbol for type info; Cmd/Ctrl-click a cross-file import and confirm a new editor tab opens at the right line; introduce a type error and confirm a squiggle plus lint gutter marker.
2. Turn AI autocomplete ON: confirm the LSP popup no longer appears while ghost text returns, and diagnostics plus hover still work.
3. Status bar shows the language pill while an LSP-backed file is active; for a language with no server installed it shows the muted pill whose tooltip carries the install hint.
4. Toggle Language intelligence OFF in Settings: pill disappears, no LSP requests fire on newly opened files.
5. Close all editor tabs, wait 5 minutes (or temporarily lower `IDLE_SHUTDOWN_MS`), confirm the server process exits (`ps aux | grep typescript-language-server`).
6. Quit Terax with a server running: confirm no orphaned server processes remain.

- [ ] **Step 6: Final commit**

```bash
git add src/modules/editor/lib/lsp/
git commit -m "feat(editor): restart crashed lsp servers with backoff"
```

---

## Out of scope (follow-up plan)

- Server auto-download and provisioning (`acquire.rs`, managed Node runtime, npm installs, GitHub release downloads, install/uninstall settings UI with progress). Planned as `docs/superpowers/plans/<date>-lsp-server-provisioning.md` once this plan lands; it extends `registry.rs` with acquisition strategies and adds `lsp_install_server` / `lsp_uninstall_server` commands.
- Rename, code actions, signature help, formatting.
- Per-language enable toggles (master toggle only in v1).
