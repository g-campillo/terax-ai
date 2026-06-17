import { Channel, invoke } from "@tauri-apps/api/core";
import {
  getNotifications,
  type IBatchRequest,
  type IJSONRPCData,
  type JSONRPCRequestData,
} from "@open-rpc/client-js/build/Request";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";

export type LspEvent =
  | { type: "message"; data: string }
  | { type: "exited"; code: number };

type Options = {
  language: string;
  workspaceRoot: string;
  onExit?: (code: number) => void;
};

type ServerRequest = {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: unknown;
};

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isServerRequest(payload: unknown): payload is ServerRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.method === "string" && p.id !== undefined && p.id !== null;
}

function configurationItems(params: unknown): unknown[] {
  if (typeof params !== "object" || params === null) return [];
  const items = (params as Record<string, unknown>).items;
  return Array.isArray(items) ? items : [];
}

export class TauriLspTransport extends Transport {
  private sessionId: number | null = null;
  private inflight = new Set<JSONRPCRequestData>();

  constructor(private readonly options: Options) {
    super();
  }

  async connect(): Promise<void> {
    // Guard against reconnecting an already-live session
    if (this.sessionId != null) return;
    const onEvent = new Channel<LspEvent>();
    onEvent.onmessage = (ev) => {
      if (ev.type === "message") {
        const payload = safeParse(ev.data);
        if (isServerRequest(payload)) {
          void this.replyToServerRequest(payload);
          return;
        }
        const err = this.transportRequestManager.resolveResponse(ev.data);
        if (err) console.warn("lsp: unresolved server payload", err);
      } else if (ev.type === "exited") {
        const exitErr = new Error(`lsp server exited with code ${ev.code}`);
        for (const req of this.inflight) {
          const batch = Array.isArray(req)
            ? (req as IBatchRequest[]).map((b) => b.request)
            : [req as IJSONRPCData];
          this.transportRequestManager.settlePendingRequest(batch, exitErr);
        }
        this.inflight.clear();
        this.sessionId = null;
        this.options.onExit?.(ev.code);
      }
    };
    this.sessionId = await invoke<number>("lsp_start", {
      language: this.options.language,
      workspaceRoot: this.options.workspaceRoot,
      onEvent,
    });
  }

  async sendData(
    data: JSONRPCRequestData,
    // The marimo client always passes its configured request timeout, so this
    // default only applies to callers that omit one (notifications, which settle
    // as soon as the send resolves). `null` = no artificial cap; the effective
    // request ceiling is the client's `timeout` (see LSP_REQUEST_TIMEOUT_MS).
    timeout: number | null = null,
  ): Promise<unknown> {
    const prom = this.transportRequestManager.addRequest(data, timeout);
    this.inflight.add(data);
    const clear = () => this.inflight.delete(data);
    (prom as Promise<unknown>).then(clear, clear);
    const notifications = getNotifications(data);
    if (this.sessionId == null) {
      const err = new Error("lsp session is not connected");
      this.transportRequestManager.settlePendingRequest(notifications, err);
      throw err;
    }
    try {
      await invoke("lsp_send", {
        id: this.sessionId,
        message: JSON.stringify(this.parseData(data)),
      });
      this.transportRequestManager.settlePendingRequest(notifications);
    } catch (e) {
      this.transportRequestManager.settlePendingRequest(
        notifications,
        e instanceof Error ? e : new Error(String(e)),
      );
      throw e;
    }
    return prom;
  }

  close(): void {
    if (this.sessionId == null) return;
    const id = this.sessionId;
    this.sessionId = null;
    void invoke("lsp_stop", { id });
  }

  // The marimo client only answers server requests on WebSocket transports
  // (it looks for transport.connection), so this transport must reply itself
  // or servers stall waiting on workspace/configuration.
  private async replyToServerRequest(req: ServerRequest): Promise<void> {
    if (this.sessionId == null) return;
    const result =
      req.method === "workspace/configuration"
        ? configurationItems(req.params).map(() => null)
        : null;
    try {
      await invoke("lsp_send", {
        id: this.sessionId,
        message: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }),
      });
    } catch (e) {
      console.warn("lsp: failed to answer server request", req.method, e);
    }
  }
}
