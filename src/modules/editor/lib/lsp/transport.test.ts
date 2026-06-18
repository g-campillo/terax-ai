import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
let channelHandler: ((ev: unknown) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    set onmessage(fn: (ev: unknown) => void) {
      channelHandler = fn;
    }
  },
}));

import { TauriLspTransport } from "./transport";

describe("TauriLspTransport", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    channelHandler = null;
  });

  it("starts a session on connect with language and root", async () => {
    invokeMock.mockResolvedValueOnce(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    expect(invokeMock).toHaveBeenCalledWith(
      "lsp_start",
      expect.objectContaining({
        language: "typescript",
        workspaceRoot: "/repo",
        onEvent: expect.anything(),
      }),
    );
  });

  it("sends serialized payloads through lsp_send with the session id", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    void t.sendData(
      {
        request: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      } as never,
      1000,
    );
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "lsp_send",
        expect.objectContaining({
          id: 7,
          message: expect.stringContaining('"initialize"'),
        }),
      );
    });
  });

  it("notifies onExit when the server exits", async () => {
    invokeMock.mockResolvedValue(7);
    const onExit = vi.fn();
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
      onExit,
    });
    await t.connect();
    channelHandler?.({ type: "exited", code: 1 });
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("stops the session on close", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    invokeMock.mockClear();
    t.close();
    expect(invokeMock).toHaveBeenCalledWith("lsp_stop", { id: 7 });
  });

  it("resolves the sendData promise when the matching response arrives", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    invokeMock.mockResolvedValue(undefined);
    // internalID must match the wire id so TransportRequestManager can correlate
    const reqData = {
      internalID: 1,
      request: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    } as never;
    const prom = t.sendData(reqData, 30000);
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("lsp_send", expect.anything());
    });
    channelHandler?.({
      type: "message",
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    });
    // TransportRequestManager unwraps the envelope and resolves with payload.result
    await expect(prom).resolves.toMatchObject({ ok: true });
  });

  it("answers workspace/configuration server requests", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    channelHandler?.({
      type: "message",
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "workspace/configuration",
        params: { items: [{ section: "a" }, { section: "b" }] },
      }),
    });
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "lsp_send",
        expect.objectContaining({
          id: 7,
          // Unknown sections resolve to {} (an object, not null) so servers
          // expecting a config object still get one.
          message: JSON.stringify({
            jsonrpc: "2.0",
            id: 42,
            result: [{}, {}],
          }),
        }),
      );
    });
  });

  it("rejects in-flight requests when the server exits", async () => {
    invokeMock.mockResolvedValue(7);
    const t = new TauriLspTransport({
      language: "typescript",
      workspaceRoot: "/repo",
    });
    await t.connect();
    invokeMock.mockResolvedValue(undefined);
    const reqData = {
      internalID: 1,
      request: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    } as never;
    const prom = t.sendData(reqData, 30000);
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("lsp_send", expect.anything());
    });
    channelHandler?.({ type: "exited", code: 1 });
    await expect(prom).rejects.toThrow(/exited/);
  });
});
