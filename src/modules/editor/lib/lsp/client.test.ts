import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeMock = vi.fn();
const clientCtor = vi.fn();
const transportCtor = vi.fn();

vi.mock("@marimo-team/codemirror-languageserver", () => ({
  LanguageServerClient: class {
    close = closeMock;
    constructor(opts: unknown) {
      clientCtor(opts);
    }
  },
}));
vi.mock("./transport", () => ({
  TauriLspTransport: class {
    constructor(opts: unknown) {
      transportCtor(opts);
    }
  },
}));

import { acquireLspClient, releaseLspClient, onLspClientError, __resetLspClientsForTest } from "./client";

// Returns the onExit options from the most-recently constructed transport so
// tests can trigger crash callbacks without duplicating the cast.
const lastTransportOpts = () =>
  transportCtor.mock.calls[transportCtor.mock.calls.length - 1]?.[0] as {
    onExit?: (c: number) => void;
  };

describe("lsp client cache", () => {
  beforeEach(() => {
    __resetLspClientsForTest();
    vi.useFakeTimers();
    closeMock.mockClear();
    clientCtor.mockClear();
    transportCtor.mockClear();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("returns the same client for the same language and root", () => {
    const a = acquireLspClient("typescript", "/repo");
    const b = acquireLspClient("typescript", "/repo");
    expect(a).toBe(b);
    expect(clientCtor).toHaveBeenCalledTimes(1);
    releaseLspClient("typescript", "/repo");
    releaseLspClient("typescript", "/repo");
  });

  it("creates distinct clients per root", () => {
    const a = acquireLspClient("typescript", "/repo-a");
    const b = acquireLspClient("typescript", "/repo-b");
    expect(a).not.toBe(b);
    releaseLspClient("typescript", "/repo-a");
    releaseLspClient("typescript", "/repo-b");
  });

  it("closes the client only after the idle delay once refs hit zero", () => {
    acquireLspClient("rust", "/repo");
    releaseLspClient("rust", "/repo");
    expect(closeMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("cancels idle shutdown when re-acquired in time", () => {
    const a = acquireLspClient("rust", "/repo");
    releaseLspClient("rust", "/repo");
    vi.advanceTimersByTime(60 * 1000);
    const b = acquireLspClient("rust", "/repo");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(closeMock).not.toHaveBeenCalled();
    expect(a).toBe(b);
    releaseLspClient("rust", "/repo");
  });

  it("recreates the client on unexpected exit at most three times", () => {
    acquireLspClient("go", "/repo");
    expect(clientCtor).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      lastTransportOpts().onExit?.(1);
      vi.runOnlyPendingTimers();
    }
    expect(clientCtor).toHaveBeenCalledTimes(4);
    releaseLspClient("go", "/repo");
  });

  it("notifies error listeners when restarts are exhausted", () => {
    acquireLspClient("go", "/repo");
    const onError = vi.fn();
    onLspClientError("go", "/repo", onError);
    for (let i = 0; i < 5; i++) {
      lastTransportOpts().onExit?.(1);
      vi.runOnlyPendingTimers();
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/crashed/);
    releaseLspClient("go", "/repo");
  });

  it("does not restart after a normal release-driven shutdown", () => {
    acquireLspClient("go", "/repo");
    releaseLspClient("go", "/repo");
    vi.advanceTimersByTime(5 * 60 * 1000);
    lastTransportOpts().onExit?.(0);
    vi.runOnlyPendingTimers();
    expect(clientCtor).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially between restarts", () => {
    acquireLspClient("go", "/repo");
    expect(clientCtor).toHaveBeenCalledTimes(1);
    let opts = lastTransportOpts();
    opts.onExit?.(1);
    vi.advanceTimersByTime(999);
    expect(clientCtor).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(clientCtor).toHaveBeenCalledTimes(2);
    opts = lastTransportOpts();
    opts.onExit?.(1);
    vi.advanceTimersByTime(1999);
    expect(clientCtor).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(clientCtor).toHaveBeenCalledTimes(3);
    releaseLspClient("go", "/repo");
  });

  it("self-heals an errored entry on a later acquire", () => {
    acquireLspClient("go", "/repo");
    for (let i = 0; i < 5; i++) {
      lastTransportOpts().onExit?.(1);
      vi.runOnlyPendingTimers();
    }
    const ctorCallsAfterExhaustion = clientCtor.mock.calls.length;
    // ctorCallsAfterExhaustion is 4: original + 3 restarts.
    // The 4th onExit sets errored=true without building another client.
    const fresh = acquireLspClient("go", "/repo");
    expect(clientCtor.mock.calls.length).toBe(ctorCallsAfterExhaustion + 1);
    expect(fresh).toBeDefined();
    const onError = vi.fn();
    onLspClientError("go", "/repo", onError);
    expect(onError).not.toHaveBeenCalled();
    releaseLspClient("go", "/repo");
    releaseLspClient("go", "/repo");
  });
});
