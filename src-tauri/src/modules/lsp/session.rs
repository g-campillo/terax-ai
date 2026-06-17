use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use shared_child::SharedChild;

use super::framing::{encode_frame, FrameDecoder};

const READ_BUF: usize = 64 * 1024;

pub struct LspSession {
    child: Arc<SharedChild>,
    stdin: Mutex<ChildStdin>,
    // Set before a deliberate kill (lsp_stop / idle shutdown / drop) so the
    // waiter thread can tell an intentional stop apart from an unexpected exit.
    stopping: Arc<AtomicBool>,
    // Closing the Job handle on drop kills the server's descendants if the
    // Terax process dies without a clean lsp_stop (same rationale as pty).
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
}

impl LspSession {
    pub fn send(&self, message: &str) -> Result<(), String> {
        let frame = encode_frame(message);
        let mut stdin = self
            .stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stdin.write_all(&frame).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
    }
}

/// Callbacks run on the session's reader and waiter threads: they must not
/// block and must not call back into the session, or LSP reads stall.
pub fn spawn(
    program: &str,
    args: &[String],
    cwd: &str,
    envs: &[(String, String)],
    on_message: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(i32) + Send + 'static,
) -> Result<Arc<LspSession>, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);

    #[cfg(windows)]
    let job = crate::modules::pty::job::PtyJob::create_for(child.id())
        .map_err(|e| {
            log::warn!("lsp job-object setup failed: {e}");
        })
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

    // Keep a bounded tail of the server's stderr so an abnormal exit can be
    // diagnosed (e.g. jdtls failing to start) without flooding the log with
    // every startup line.
    const STDERR_TAIL_LINES: usize = 40;
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_handle = match stderr {
        Some(stderr) => {
            let tail = stderr_tail.clone();
            let handle = thread::Builder::new()
                .name("terax-lsp-stderr".into())
                .spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        log::debug!("lsp stderr: {line}");
                        let mut tail = tail.lock().unwrap_or_else(|p| p.into_inner());
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                })
                .map_err(|e| e.to_string())?;
            Some(handle)
        }
        None => None,
    };

    let stopping = Arc::new(AtomicBool::new(false));
    let waiter_child = child.clone();
    let waiter_tail = stderr_tail;
    let waiter_stopping = stopping.clone();
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
            // Drain remaining stderr before reading the tail so it reflects the
            // crash, not a partially-read buffer.
            if let Some(handle) = stderr_handle {
                let _ = handle.join();
            }
            // Only surface a warning for *unexpected* exits. A deliberate stop
            // (lsp_stop / idle shutdown / drop) kills with a signal (code -1)
            // and is normal, so it logs at debug instead.
            if waiter_stopping.load(Ordering::SeqCst) {
                log::debug!("lsp server stopped (code={code})");
            } else {
                let tail = waiter_tail.lock().unwrap_or_else(|p| p.into_inner());
                if tail.is_empty() {
                    log::warn!("lsp server exited unexpectedly code={code} (no stderr captured)");
                } else {
                    let joined: Vec<&str> = tail.iter().map(String::as_str).collect();
                    log::warn!(
                        "lsp server exited unexpectedly code={code}; recent stderr:\n{}",
                        joined.join("\n")
                    );
                }
            }
            on_exit(code);
        })
        .map_err(|e| e.to_string())?;

    Ok(Arc::new(LspSession {
        child,
        stdin: Mutex::new(stdin),
        stopping,
        #[cfg(windows)]
        _job: job,
    }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_applies_env_overrides() {
        let (msg_tx, msg_rx) = mpsc::channel::<String>();
        // The child echoes an injected env var back inside a framed message.
        let script =
            r#"body="$LSP_TEST_VAR"; printf 'Content-Length: %d\r\n\r\n%s' ${#body} "$body""#;
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            &[("LSP_TEST_VAR".to_string(), "jdk-from-env".to_string())],
            move |m| {
                let _ = msg_tx.send(m);
            },
            |_| {},
        )
        .expect("spawn with env");
        let msg = msg_rx.recv_timeout(Duration::from_secs(5)).expect("message");
        assert_eq!(msg, "jdk-from-env");
        session.kill();
    }

    #[test]
    fn reads_framed_message_and_reports_exit() {
        let (msg_tx, msg_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let script = r#"printf 'Content-Length: 13\r\n\r\n{"jsonrpc":2}'"#;
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            &[],
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
            &[],
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
            &[],
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

    #[test]
    fn corrupt_stream_kills_server() {
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let script = r#"printf 'not-a-header\r\n\r\nxx'; sleep 30"#;
        let _session = spawn(
            "/bin/sh",
            &["-c".to_string(), script.to_string()],
            "/tmp",
            &[],
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn corrupt server");
        exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server killed after corrupt frame");
    }

    #[test]
    fn drop_kills_child_and_reports_exit() {
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            "/tmp",
            &[],
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn");
        drop(session);
        exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("exit after drop");
    }

    #[test]
    fn send_after_child_death_errors() {
        let (exit_tx, exit_rx) = mpsc::channel::<i32>();
        let session = spawn(
            "/bin/sh",
            &["-c".to_string(), "exit 0".to_string()],
            "/tmp",
            &[],
            |_| {},
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn");
        exit_rx.recv_timeout(Duration::from_secs(5)).expect("exit");
        // The pipe may need two writes before EPIPE surfaces reliably.
        let first = session.send(r#"{"id":1}"#);
        let second = session.send(r#"{"id":2}"#);
        assert!(first.is_err() || second.is_err());
    }
}
