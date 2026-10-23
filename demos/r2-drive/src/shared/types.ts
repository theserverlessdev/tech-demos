export type PublicLock = {
  path: string;
  owner: string | null;
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
  timeout: string;
  expiresAt: number;
};

export type LogEvent = {
  at: number;
  method: string;
  path: string;
  status: number;
};

export type Caps = {
  maxFileBytes: number;
  maxDriveBytes: number;
  maxFiles: number;
  ttlMs: number;
};

export type SessionView = {
  driveId: string;
  expiresAt: number;
  bytesUsed: number;
  fileCount: number;
  status: "active" | "frozen" | "wiped";
  caps: Caps;
};

export type MintedDrive = {
  driveId: string;
  username: string;
  password: string;
  expiresAt: number;
  mountPath: string;
  caps: Caps;
};
