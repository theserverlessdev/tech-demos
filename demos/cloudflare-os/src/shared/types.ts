// Types shared by the Worker and the browser shell. Type-only: no runtime code.

export type BindingName = "WEB" | "AI";

export type Viewer = {
  /** One per browser tab. */
  id: string;
  name: string;
  color: string;
};

export type BlueprintInfo = {
  id: string;
  title: string;
  icon: string;
  description: string;
  bindings: BindingName[];
  prompt: string;
};

export type GadgetInfo = {
  id: string;
  title: string;
  blueprint: string;
  icon: string;
  version: number;
  bindings: BindingName[];
  /** The Worker Loader ID for the current code version. */
  loaderId: string;
  createdAt: number;
  updatedAt: number;
};

export type ToolCallRecord = {
  name: string;
  args: string;
  ok: boolean;
  result: string;
  gadget?: string;
};

export type ChatMessage = {
  id: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  author?: string;
  color?: string;
  tool?: ToolCallRecord;
  at: number;
};

export type ActionStatus = "pending" | "approved" | "auto" | "denied" | "expired";

export type ActionRecord = {
  id: number;
  gadget: string;
  gatekeeper: BindingName;
  title: string;
  detail: string;
  status: ActionStatus;
  decidedBy?: string;
  at: number;
};

export type WorkspaceSnapshot = {
  id: string;
  title: string;
  gadgets: GadgetInfo[];
  chat: ChatMessage[];
  actions: ActionRecord[];
  presence: Viewer[];
  /** Keys are `${gadgetId}:${binding}`. */
  autoApprove: string[];
  cost: { usd: number; tokensIn: number; tokensOut: number };
  agent: { busy: boolean; status: string | null; model: string };
  limits: { maxGadgets: number };
};

export type RpcEvent = {
  gadget: string;
  method: string;
  ms: number;
  ok: boolean;
  via: "ui" | "agent" | "gatekeeper" | "platform";
  who?: string;
  at: number;
};

export type WorkspaceEvent =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "gadget-reloaded"; gadget: string; version: number }
  | { type: "gadget-removed"; gadget: string }
  | { type: "focus"; gadget: string }
  | { type: "rpc"; event: RpcEvent }
  | { type: "log"; gadget: string; level: "info" | "error"; message: string };

export type StorageReport = {
  tables: { name: string; rows: number; columns: string[]; sample: Record<string, unknown>[] }[];
  kv: { count: number; keys: { key: string; preview: string }[] };
  databaseSize: number | null;
  error?: string;
};

export type UiBundle = { jsCode: string; version: number };

export type GadgetFiles = Record<"server.js" | "client.js" | "README.md", string>;

/** Methods the browser can call on a workspace session. Implemented in the Workspace DO. */
export interface WorkspaceClientApi {
  subscribe(listener: { event(e: WorkspaceEvent): void }): Promise<void>;
  ping(): Promise<void>;
  setTitle(title: string): Promise<void>;
  listBlueprints(): Promise<BlueprintInfo[]>;
  createGadget(blueprintId: string, title?: string): Promise<GadgetInfo>;
  removeGadget(gadgetId: string): Promise<void>;
  getUiBundle(gadgetId: string): Promise<UiBundle>;
  connectToGadget(gadgetId: string): Promise<unknown>;
  getFiles(gadgetId: string): Promise<GadgetFiles>;
  writeFile(gadgetId: string, path: keyof GadgetFiles, content: string): Promise<GadgetInfo>;
  setBinding(gadgetId: string, binding: BindingName, enabled: boolean): Promise<GadgetInfo>;
  inspectStorage(gadgetId: string): Promise<StorageReport>;
  decideAction(actionId: number, approve: boolean, always: boolean): Promise<void>;
  setAutoApprove(gadgetId: string, binding: BindingName, enabled: boolean): Promise<void>;
  chat(text: string): Promise<void>;
  reportLog(gadgetId: string, level: "info" | "error", message: string): Promise<void>;
}

export interface PublicApi {
  openWorkspace(id: string, viewer: Viewer): WorkspaceClientApi;
  listBlueprints(): BlueprintInfo[];
}
