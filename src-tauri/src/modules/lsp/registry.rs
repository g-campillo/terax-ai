use std::path::PathBuf;

pub struct ServerDef {
    pub id: &'static str,
    pub display: &'static str,
    pub extensions: &'static [&'static str],
    pub binaries: &'static [&'static str],
    pub args: &'static [&'static str],
    pub install_hint: &'static str,
    /// Minimum major Java version the server's runtime requires, if any. When
    /// set, the server is only "available" if a JDK >= this can be resolved,
    /// and `lsp_start` points the server at that JDK via `JAVA_HOME`.
    pub min_java: Option<u32>,
}

pub const SERVERS: &[ServerDef] = &[
    ServerDef {
        id: "typescript",
        display: "TypeScript / JavaScript",
        extensions: &["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
        binaries: &["typescript-language-server"],
        args: &["--stdio"],
        install_hint: "npm install -g typescript-language-server typescript",
        min_java: None,
    },
    ServerDef {
        id: "python",
        display: "Python",
        extensions: &["py", "pyi"],
        binaries: &["pyright-langserver", "basedpyright-langserver"],
        args: &["--stdio"],
        install_hint: "npm install -g pyright",
        min_java: None,
    },
    ServerDef {
        id: "rust",
        display: "Rust",
        extensions: &["rs"],
        binaries: &["rust-analyzer"],
        args: &[],
        install_hint: "rustup component add rust-analyzer",
        min_java: None,
    },
    ServerDef {
        id: "go",
        display: "Go",
        extensions: &["go"],
        binaries: &["gopls"],
        args: &[],
        install_hint: "go install golang.org/x/tools/gopls@latest",
        min_java: None,
    },
    ServerDef {
        id: "java",
        display: "Java",
        extensions: &["java"],
        binaries: &["jdtls"],
        args: &[],
        install_hint: "install Eclipse JDT Language Server (jdtls) and a JDK 21+ runtime",
        min_java: Some(21),
    },
    ServerDef {
        id: "swift",
        display: "Swift",
        extensions: &["swift"],
        binaries: &["sourcekit-lsp"],
        args: &[],
        install_hint: "install Xcode or the Swift toolchain",
        min_java: None,
    },
    ServerDef {
        id: "kotlin",
        display: "Kotlin",
        extensions: &["kt", "kts"],
        binaries: &["kotlin-lsp", "kotlin-language-server"],
        args: &["--stdio"],
        install_hint: "install the JetBrains Kotlin LSP (kotlin-lsp) and a Java runtime",
        min_java: None,
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
        // Version managers install servers outside the GUI app's inherited PATH.
        out.push(home.join(".volta/bin"));
        out.push(home.join(".asdf/shims"));
        out.push(home.join(".pyenv/shims"));
        // nvm and pyenv keep one bin dir per installed version.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            out.extend(entries.flatten().map(|e| e.path().join("bin")));
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".pyenv/versions")) {
            out.extend(entries.flatten().map(|e| e.path().join("bin")));
        }
    }
    #[cfg(target_os = "macos")]
    {
        out.push(PathBuf::from("/opt/homebrew/bin"));
        out.push(PathBuf::from("/usr/local/bin"));
    }
    out
}

/// Project-local toolchain dirs, probed ahead of global PATH so a server pinned
/// to the workspace (a project's TypeScript, a server installed in a venv) wins.
fn project_local_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = vec![root.join("node_modules").join(".bin")];
    for venv in [".venv", "venv", "env"] {
        out.push(root.join(venv).join("bin")); // unix venv
        out.push(root.join(venv).join("Scripts")); // windows venv
    }
    out
}

/// Whether a path is a runnable binary. Public so the override path in `lsp_*`
/// commands can validate a user-supplied server command.
pub fn is_runnable(p: &std::path::Path) -> bool {
    is_executable(p)
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &std::path::Path) -> bool {
    p.is_file()
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
                if is_executable(&p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

pub fn resolve_binary(
    def: &ServerDef,
    workspace_root: Option<&std::path::Path>,
) -> Option<PathBuf> {
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
    // Project-local dirs take priority over the global toolchain.
    let mut dirs = workspace_root.map(project_local_dirs).unwrap_or_default();
    dirs.extend(candidate_dirs());
    find_binary_in(def.binaries, &dirs)
}

/// Parse the major Java version from `java -version` output (the first quoted
/// token). Handles the modern scheme (`"24.0.2"` -> 24, `"21"` -> 21) and the
/// legacy `1.x` scheme (`"1.8.0_392"` -> 8).
fn parse_java_major(version_output: &str) -> Option<u32> {
    let start = version_output.find('"')? + 1;
    let end = version_output[start..].find('"')? + start;
    let mut parts = version_output[start..end].split('.');
    let first = parts.next()?;
    if first == "1" {
        parts.next()?.parse().ok()
    } else {
        first.parse().ok()
    }
}

/// Pick the first candidate JDK whose major version meets `min_major`. Order is
/// significant: callers pass candidates in priority order, and the first one
/// that qualifies wins (parse failures / older JDKs are skipped).
fn select_jdk(candidates: &[(PathBuf, Option<u32>)], min_major: u32) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|(_, major)| major.is_some_and(|m| m >= min_major))
        .map(|(home, _)| home.clone())
}

/// Candidate JDK home directories in priority order. Mirrors `candidate_dirs`
/// for binaries: a GUI app inherits a minimal environment, so probe well-known
/// JDK locations in addition to `JAVA_HOME` and PATH.
fn jdk_homes() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(jh) = std::env::var_os("JAVA_HOME") {
        out.push(PathBuf::from(jh));
    }
    if let Some(home) = dirs::home_dir() {
        // sdkman keeps each JDK under candidates/java/<version>.
        if let Ok(entries) = std::fs::read_dir(home.join(".sdkman/candidates/java")) {
            out.extend(entries.flatten().map(|e| e.path()));
        }
    }
    // A `java` on PATH (or a probed bin dir) implies its JDK home is the parent
    // of its `bin` directory.
    if let Some(java) = find_binary_in(&["java"], &candidate_dirs()) {
        if let Some(home) = java.parent().and_then(|bin| bin.parent()) {
            out.push(home.to_path_buf());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Library/Java/JavaVirtualMachines") {
            out.extend(entries.flatten().map(|e| e.path().join("Contents/Home")));
        }
        if let Ok(jh) = std::process::Command::new("/usr/libexec/java_home").output() {
            if jh.status.success() {
                let p = PathBuf::from(String::from_utf8_lossy(&jh.stdout).trim());
                if p.is_dir() {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Run `<home>/bin/java -version` and parse its major version.
fn jdk_major(home: &std::path::Path) -> Option<u32> {
    let java = home
        .join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" });
    let out = std::process::Command::new(&java)
        .arg("-version")
        .output()
        .ok()?;
    // `java -version` reports the version on stderr.
    let text = String::from_utf8_lossy(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    });
    parse_java_major(&text)
}

/// Resolve a JDK home whose major version is at least `min_major`, probing
/// well-known locations in priority order. Successful lookups are memoized to
/// avoid re-spawning `java` on every status check.
pub fn resolve_jdk(min_major: u32) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<u32, PathBuf>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(&min_major) {
        return Some(hit.clone());
    }
    let candidates: Vec<(PathBuf, Option<u32>)> = jdk_homes()
        .into_iter()
        .map(|home| {
            let major = jdk_major(&home);
            (home, major)
        })
        .collect();
    let resolved = select_jdk(&candidates, min_major);
    if let Some(ref home) = resolved {
        cache.lock().unwrap().insert(min_major, home.clone());
    }
    resolved
}

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

    #[cfg(unix)]
    #[test]
    fn find_binary_skips_non_executable_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("fake-ls"), b"").unwrap();
        assert!(find_binary_in(&["fake-ls"], &[dir.path().to_path_buf()]).is_none());
    }

    #[test]
    fn project_local_dirs_lead_with_node_modules_then_venvs() {
        let dirs = project_local_dirs(std::path::Path::new("/repo"));
        assert_eq!(dirs[0], PathBuf::from("/repo/node_modules/.bin"));
        assert!(dirs.contains(&PathBuf::from("/repo/.venv/bin")));
        assert!(dirs.contains(&PathBuf::from("/repo/venv/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn is_runnable_tracks_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server");
        std::fs::write(&path, b"").unwrap();
        assert!(!is_runnable(&path));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_runnable(&path));
    }

    #[test]
    fn parses_java_major_version() {
        assert_eq!(
            parse_java_major(r#"openjdk version "24.0.2" 2025-07-15"#),
            Some(24)
        );
        assert_eq!(
            parse_java_major(r#"openjdk version "17.0.19" 2026-04-21"#),
            Some(17)
        );
        assert_eq!(
            parse_java_major(r#"openjdk version "21" 2023-09-19"#),
            Some(21)
        );
        // Legacy 1.x scheme: the real major version is the second component.
        assert_eq!(parse_java_major(r#"java version "1.8.0_392""#), Some(8));
        assert_eq!(parse_java_major("not a version string"), None);
        assert_eq!(parse_java_major(""), None);
    }

    #[test]
    fn selects_first_jdk_meeting_minimum() {
        let candidates = vec![
            (PathBuf::from("/jdk17"), Some(17)),
            (PathBuf::from("/jdk-unknown"), None),
            (PathBuf::from("/jdk24"), Some(24)),
            (PathBuf::from("/jdk25"), Some(25)),
        ];
        // Skips the too-old 17 and the unparseable one, takes the first >= min.
        assert_eq!(select_jdk(&candidates, 21), Some(PathBuf::from("/jdk24")));
        // When 17 qualifies it wins (priority = discovery order).
        assert_eq!(select_jdk(&candidates, 17), Some(PathBuf::from("/jdk17")));
        // Nothing qualifies.
        assert_eq!(select_jdk(&candidates, 30), None);
        assert_eq!(select_jdk(&[], 21), None);
    }
}
