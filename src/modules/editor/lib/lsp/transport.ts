import { Channel, invoke } from "@tauri-apps/api/core";
import {
  getNotifications,
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

export class TauriLspTransport extends Transport {
  private sessionId: number | null = null;

  constructor(private readonly options: Options) {
    super();
  }

  async connect(): Promise<void> {
    const onEvent = new Channel<LspEvent>();
    onEvent.onmessage = (ev) => {
      if (ev.type === "message") {
        const err = this.transportRequestManager.resolveResponse(ev.data);
        if (err) console.warn("lsp: unresolved server payload", err);
      } else if (ev.type === "exited") {
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
    timeout: number | null = null,
  ): Promise<unknown> {
    const prom = this.transportRequestManager.addRequest(data, timeout);
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
}
