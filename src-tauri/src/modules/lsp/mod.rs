pub mod framing;
pub mod registry;
pub mod session;

use std::collections::HashMap;
use std::path::PathBuf;
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

/// Compute the reported status from a server's resolved binary and JDK. A
/// server with a `min_java` requirement is available only when both its binary
/// and a suitable JDK are present; otherwise the hint explains what is missing
/// so the editor's status pill can surface it instead of a silent crash loop.
fn build_status(
    def: &registry::ServerDef,
    binary: Option<PathBuf>,
    jdk: Option<PathBuf>,
) -> LspServerStatus {
    let (available, install_hint) = match (&binary, def.min_java) {
        (None, _) => (false, def.install_hint.to_string()),
        (Some(_), Some(min)) if jdk.is_none() => (
            false,
            format!(
                "{} language server found, but it needs JDK {min}+. \
                 Install a JDK {min}+ or point JAVA_HOME at one.",
                def.display
            ),
        ),
        (Some(_), _) => (true, def.install_hint.to_string()),
    };
    LspServerStatus {
        language: def.id.to_string(),
        display: def.display.to_string(),
        available,
        command: binary.map(|p| p.to_string_lossy().into_owned()),
        install_hint,
    }
}

/// Environment overrides a server needs at spawn time. For a server with a JDK
/// requirement, resolve a suitable JDK and expose it via `JAVA_HOME` (and put
/// its `bin` first on `PATH`) so it runs on that JDK regardless of the app's
/// inherited default; error clearly if none is available.
fn jdk_env(def: &registry::ServerDef) -> Result<Vec<(String, String)>, String> {
    let Some(min) = def.min_java else {
        return Ok(Vec::new());
    };
    let jdk = registry::resolve_jdk(min)
        .ok_or_else(|| format!("{} needs a JDK {min}+ runtime; none found", def.display))?;
    let bin_dir = jdk.join("bin");
    let path = std::env::var_os("PATH")
        .map(|existing| {
            let mut parts = vec![bin_dir.clone()];
            parts.extend(std::env::split_paths(&existing));
            std::env::join_paths(parts)
                .map(|joined| joined.to_string_lossy().into_owned())
                .unwrap_or_else(|_| bin_dir.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| bin_dir.to_string_lossy().into_owned());
    Ok(vec![
        ("JAVA_HOME".to_string(), jdk.to_string_lossy().into_owned()),
        ("PATH".to_string(), path),
    ])
}

#[tauri::command]
pub fn lsp_status(language: String) -> Result<LspServerStatus, String> {
    let def = registry::server_by_id(&language)
        .ok_or_else(|| format!("unknown lsp language: {language}"))?;
    let binary = registry::resolve_binary(def);
    let jdk = def.min_java.and_then(registry::resolve_jdk);
    Ok(build_status(def, binary, jdk))
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
    let envs = jdk_env(def)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let ev_msg = on_event.clone();
    let exit_lang = language.clone();
    let args: Vec<String> = def.args.iter().map(|s| s.to_string()).collect();
    let session = session::spawn(
        &bin.to_string_lossy(),
        &args,
        &canonical.to_string_lossy(),
        &envs,
        move |msg| {
            // TEMP debug: trace completion responses (remove after diagnosing).
            if msg.contains("\"isIncomplete\"")
                || (msg.contains("\"result\"") && msg.contains("\"label\""))
            {
                let approx_items = msg.matches("\"label\"").count();
                log::info!(
                    "lsp recv completion-like response: ~{approx_items} items, {} bytes",
                    msg.len()
                );
            }
            let _ = ev_msg.send(LspEvent::Message { data: msg });
        },
        move |code| {
            log::debug!("lsp exited id={id} language={exit_lang} code={code}");
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
    // TEMP debug: trace outgoing completion requests (remove after diagnosing).
    if message.contains("\"textDocument/completion\"") {
        log::info!("lsp_send id={id} textDocument/completion ({} bytes)", message.len());
    }
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("lsp_send: unknown id={id}");
            format!("no lsp session id={id}")
        })?;
    session.send(&message)
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<'_, LspState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(session) = session {
        session.kill();
        log::info!("lsp stopped id={id}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use registry::server_by_id;
    use std::path::PathBuf;

    #[test]
    fn java_unavailable_without_required_jdk() {
        let def = server_by_id("java").unwrap();
        let bin = Some(PathBuf::from("/opt/homebrew/bin/jdtls"));
        // jdtls present but no JDK 21+ resolved -> unavailable, JDK-specific hint.
        let missing = build_status(def, bin.clone(), None);
        assert!(!missing.available);
        assert!(
            missing.install_hint.contains("21"),
            "hint should call out JDK 21+: {}",
            missing.install_hint
        );
        // With a suitable JDK resolved, it's available.
        let ok = build_status(def, bin, Some(PathBuf::from("/jdk24")));
        assert!(ok.available);
    }

    #[test]
    fn server_without_jdk_requirement_ignores_jdk() {
        let def = server_by_id("rust").unwrap();
        assert!(build_status(def, Some(PathBuf::from("/bin/rust-analyzer")), None).available);
        assert!(!build_status(def, None, None).available);
    }
}
