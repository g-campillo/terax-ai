import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getNotifications,
  type IBatchRequest,
  type IJSONRPCData,
  type JSONRPCRequestData,
} from "@open-rpc/client-js/build/Request";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import { Channel, invoke } from "@tauri-apps/api/core";
import { rewriteCompletionResult } from "./completionRewrite";
import { lspConfigForSection } from "./serverConfig";

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
  // Outstanding textDocument/completion request ids, so their responses can be
  // rewritten before marimo expands snippet placeholders (see rewriteCompletionResponse).
  private completionRequestIds = new Set<number | string>();

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
        const data = this.rewriteCompletionResponse(payload, ev.data);
        const err = this.transportRequestManager.resolveResponse(data);
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
        this.completionRequestIds.clear();
        this.sessionId = null;
        this.options.onExit?.(ev.code);
      }
    };
    const override =
      usePreferencesStore.getState().lspServerOverrides?.[
        this.options.language
      ];
    this.sessionId = await invoke<number>("lsp_start", {
      language: this.options.language,
      workspaceRoot: this.options.workspaceRoot,
      serverOverride: override?.command ? override : null,
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
    this.trackCompletionRequest(data);
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

  // Completion is never batched, so only single requests are tracked.
  private trackCompletionRequest(data: JSONRPCRequestData): void {
    if (Array.isArray(data)) return;
    const req = (data as IJSONRPCData).request;
    if (req?.method === "textDocument/completion" && req.id != null) {
      this.completionRequestIds.add(req.id);
    }
  }

  // Collapse snippet placeholder args in completion responses to `name($0)` so
  // accepting a completion leaves the cursor in empty parens instead of filling
  // ${1:arg} placeholders. Only completion responses are rewritten; every other
  // payload (hover, definition, signature help, errors) passes through verbatim.
  private rewriteCompletionResponse(payload: unknown, raw: string): string {
    if (typeof payload !== "object" || payload === null) return raw;
    const p = payload as { id?: number | string; result?: unknown };
    if (p.id == null || !this.completionRequestIds.has(p.id)) return raw;
    this.completionRequestIds.delete(p.id);
    if (!("result" in p)) return raw;
    return JSON.stringify({ ...p, result: rewriteCompletionResult(p.result) });
  }

  // The marimo client only answers server requests on WebSocket transports
  // (it looks for transport.connection), so this transport must reply itself
  // or servers stall waiting on workspace/configuration.
  private async replyToServerRequest(req: ServerRequest): Promise<void> {
    if (this.sessionId == null) return;
    const result =
      req.method === "workspace/configuration"
        ? configurationItems(req.params).map((item) =>
            lspConfigForSection((item as { section?: string } | null)?.section),
          )
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
