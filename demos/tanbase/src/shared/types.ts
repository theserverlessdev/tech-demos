export const COLUMNS = ["todo", "doing", "done"] as const;
export type ColumnId = (typeof COLUMNS)[number];

export const LIMITS = {
  maxBoardsPerVisitor: 3,
  maxTasksPerBoard: 40,
  maxAttachmentsPerTask: 4,
  maxAttachmentsPerBoard: 16,
  maxAttachmentBytes: 256 * 1024,
  boardTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxTitle: 120,
  maxDescription: 2000,
} as const;

export const SPLIT_STEPS = ["load task", "ask workers ai", "write subtasks"] as const;

export type Task = {
  id: string;
  column: ColumnId;
  title: string;
  description: string;
  dueAt: number | null;
  position: number;
  parentId: string | null;
  splitId: string | null;
  overdue: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AttachmentMeta = {
  id: string;
  taskId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type Reminder = {
  id: string;
  taskId: string;
  message: string;
  createdAt: number;
};

export type SplitStep = { name: string; at: number };

export type SplitRun = {
  id: string;
  taskId: string;
  instanceId: string;
  status: string;
  source: string;
  steps: SplitStep[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BoardMeta = {
  id: string;
  title: string;
  createdAt: number;
  expiresAt: number;
};

export type BoardSnapshot = BoardMeta & {
  tasks: Task[];
  attachments: AttachmentMeta[];
  reminders: Reminder[];
  splits: SplitRun[];
};

export type SessionPayload = {
  visitorId: string;
  siteKey: string;
  limits: typeof LIMITS;
  boards: BoardMeta[];
};

export type ServerEvent =
  | { type: "snapshot"; peers: number; board: BoardSnapshot }
  | { type: "peers"; peers: number }
  | { type: "expired" }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "create"; title: string; description?: string; dueAt?: number | null; column?: ColumnId }
  | { type: "patch"; taskId: string; title?: string; description?: string; dueAt?: number | null; column?: ColumnId; index?: number }
  | { type: "delete"; taskId: string };
