import { create } from "zustand";

export type LspPaneStatus = {
  state: "indexing" | "running" | "missing" | "error";
  label: string;
  hint: string | null;
};

type State = {
  byPath: Record<string, LspPaneStatus>;
  // Per-path callback that re-resolves the language server for that pane,
  // registered by the editor so the status pill can offer a manual restart.
  restarters: Record<string, () => void>;
  setStatus: (path: string, status: LspPaneStatus) => void;
  clearStatus: (path: string) => void;
  setRestarter: (path: string, restart: () => void) => void;
  clearRestarter: (path: string) => void;
};

export const useLspStatusStore = create<State>((set) => ({
  byPath: {},
  restarters: {},
  setStatus: (path, status) =>
    set((s) => ({ byPath: { ...s.byPath, [path]: status } })),
  clearStatus: (path) =>
    set((s) => {
      const { [path]: _unused, ...rest } = s.byPath;
      return { byPath: rest };
    }),
  setRestarter: (path, restart) =>
    set((s) => ({ restarters: { ...s.restarters, [path]: restart } })),
  clearRestarter: (path) =>
    set((s) => {
      const { [path]: _unused, ...rest } = s.restarters;
      return { restarters: rest };
    }),
}));
