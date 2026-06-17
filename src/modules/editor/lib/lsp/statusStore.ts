import { create } from "zustand";

export type LspPaneStatus = {
  state: "indexing" | "running" | "missing" | "error";
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
      const { [path]: _unused, ...rest } = s.byPath;
      return { byPath: rest };
    }),
}));
