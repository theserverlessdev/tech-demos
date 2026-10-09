import type { FileDiff } from "../shared/types";

type LineOp = { kind: " " | "+" | "-"; text: string };

/** Longest-common-subsequence line diff. Files in this demo stay under a few hundred lines. */
function lineDiff(before: string[], after: string[]): LineOp[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i]!;
      const next = dp[i + 1]!;
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", text: before[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", text: before[i++]! });
  while (j < m) ops.push({ kind: "+", text: after[j++]! });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const ops = lineDiff(a, b);
  const body = ops.map((op) => `${op.kind}${op.text}`).join("\n");
  const from = before === null ? "/dev/null" : `a/${path}`;
  const to = after === null ? "/dev/null" : `b/${path}`;
  return `--- ${from}\n+++ ${to}\n${body}\n`;
}

export function diffStatus(before: string | null, after: string | null): FileDiff["status"] {
  if (before === null) return "added";
  if (after === null) return "deleted";
  return "modified";
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): FileDiff[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: FileDiff[] = [];
  for (const path of paths) {
    const prev = before.has(path) ? before.get(path)! : null;
    const next = after.has(path) ? after.get(path)! : null;
    if (prev === next) continue;
    files.push({
      path,
      status: diffStatus(prev, next),
      patch: unifiedDiff(path, prev, next),
    });
  }
  return files;
}
