import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/**
 * Drives window-level translucency for the terminal-opacity feature:
 *  - toggles `data-terminal-translucent` on <html> so the gated CSS can make the
 *    app base transparent, revealing the desktop behind a see-through terminal
 *  - applies native window vibrancy (macOS) for the chosen blur level
 *
 * Both are no-ops at the defaults (opacity 1 / blur "off"), so the app looks
 * unchanged unless the user opts in. Call once from the main-window root.
 */
export function useWindowTransparency(): void {
  const opacity = usePreferencesStore((s) => s.terminalOpacity);
  const blur = usePreferencesStore((s) => s.terminalBlur);

  useEffect(() => {
    const root = document.documentElement;
    if (opacity < 1) root.dataset.terminalTranslucent = "1";
    else delete root.dataset.terminalTranslucent;
  }, [opacity]);

  useEffect(() => {
    invoke("set_window_vibrancy", { level: blur })
      .then(() => console.debug("[terax] window vibrancy ->", blur))
      .catch((e) => console.warn("[terax] set_window_vibrancy failed:", e));
  }, [blur]);
}
