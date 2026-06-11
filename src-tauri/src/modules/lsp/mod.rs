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
