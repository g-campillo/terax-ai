import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeMock = vi.fn();
const clientCtor = vi.fn();

vi.mock("@marimo-team/codemirror-languageserver", () => ({
  LanguageServerClient: class {
    close = closeMock;
    constructor(opts: unknown) {
      clientCtor(opts);
    }
  },
}));
vi.mock("./transport", () => ({
  TauriLspTransport: class {},
}));

import { acquireLspClient, releaseLspClient } from "./client";

describe("lsp client cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    closeMock.mockClear();
    clientCtor.mockClear();
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
});
