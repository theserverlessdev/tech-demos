export type Attachment = {
  id: string;
  roomId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  author: string;
  sessionId: string;
  body: string;
  attachment: Attachment | null;
  createdAt: number;
};

export type RoomSummary = {
  id: string;
  name: string;
  createdAt: number;
  lastMessageAt: number;
  lastPreview: string;
  messageCount: number;
};

export type Session = {
  id: string;
  displayName: string;
  createdAt: number;
};

export type Presence = {
  count: number;
  names: string[];
};

export type ServerEvent =
  | { type: "hello"; room: RoomSummary; you: Session; presence: Presence; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage }
  | { type: "presence"; presence: Presence }
  | { type: "error"; message: string };

export type ClientEvent = { type: "send"; body: string } | { type: "ping" };

export type Health = {
  ok: true;
  rooms: number;
  messages: number;
};
