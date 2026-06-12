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
