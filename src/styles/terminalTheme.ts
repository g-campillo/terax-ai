import { usePreferencesStore } from "@/modules/settings/preferences";
import { readTerminalTokens } from "@/styles/tokens";
import type { ITheme } from "@xterm/xterm";

// readTerminalTokens resolves CSS vars to computed `rgb(r, g, b)` / `rgba(...)`
// strings; rewrite the alpha so the terminal background can be made translucent.
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return color;
  const [r, g, b] = m[1].split(/[\s,/]+/).filter(Boolean);
  if (r == null || g == null || b == null) return color;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildTerminalTheme(): ITheme {
  const t = readTerminalTokens();
  const opacity = usePreferencesStore.getState().terminalOpacity;
  return {
    background: opacity < 1 ? withAlpha(t.background, opacity) : t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    black: t.ansiBlack,
    red: t.ansiRed,
    green: t.ansiGreen,
    yellow: t.ansiYellow,
    blue: t.ansiBlue,
    magenta: t.ansiMagenta,
    cyan: t.ansiCyan,
    white: t.ansiWhite,
    brightBlack: t.ansiBrightBlack,
    brightRed: t.ansiBrightRed,
    brightGreen: t.ansiBrightGreen,
    brightYellow: t.ansiBrightYellow,
    brightBlue: t.ansiBrightBlue,
    brightMagenta: t.ansiBrightMagenta,
    brightCyan: t.ansiBrightCyan,
    brightWhite: t.ansiBrightWhite,
  };
}
