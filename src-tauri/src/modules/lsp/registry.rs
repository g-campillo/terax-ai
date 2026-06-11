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
