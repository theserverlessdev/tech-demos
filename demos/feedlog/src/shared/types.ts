export const STATUSES = ["open", "planned", "in_progress", "done", "closed"] as const;
export type PostStatus = (typeof STATUSES)[number];

export const ROADMAP_STATUSES = ["planned", "in_progress", "done"] as const;

export const STATUS_LABEL: Record<PostStatus, string> = {
  open: "Open",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  closed: "Closed",
};

export type Post = {
  id: string;
  title: string;
  body: string;
  status: PostStatus;
  votes: number;
  displayName: string;
  hasImage: boolean;
  seeded: boolean;
  createdAt: number;
  expiresAt: number | null;
  voted: boolean;
};

export type ChangelogEntry = {
  id: string;
  title: string;
  body: string;
  publishedAt: number;
  seeded: boolean;
};

export type SimilarHit = {
  id: string;
  title: string;
  status: PostStatus;
  score: number;
  kind: "duplicate" | "related";
};

export type SimilarSource = "vectorize" | "lexical" | "skipped";

export type SimilarResult = {
  similar: SimilarHit[];
  source: SimilarSource;
};

export type BoardConfig = {
  turnstileSiteKey: string | null;
  writesOpen: boolean;
  embedModel: string;
  visitorTtlDays: number;
};

export type Health = {
  ok: true;
  posts: number;
  changelog: number;
  writesOpen: boolean;
  embedModel: string;
};

export function isStatus(value: string): value is PostStatus {
  return (STATUSES as readonly string[]).includes(value);
}
