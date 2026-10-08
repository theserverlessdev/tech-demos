/**
 * toolGate() decides whether one tool call may run.
 *
 * This is the demo's copy of the shared guardrail shape from repo issue #95:
 * a typed helper with no storage of its own, so a later package can re-export
 * it. The agent calls it before every tool. It does not execute the tool.
 *
 * Clef is asked one System One choice question: allow, deny, or ask-human.
 * A top probability below the confidence floor becomes ask-human. A response
 * that cannot be parsed is a closed deny. On localhost only, a labeled
 * heuristic can stand in when Workers AI cannot be reached.
 */
import {
  type ClefModel,
  type GateDecision,
  type GateSource,
  type Probabilities,
  emptyProbabilities,
  GATE_DECISIONS,
} from "../shared/types";

export const CONFIDENCE_FLOOR_DEFAULT = 0.62;

const POLICY =
  "Reads of the demo docs may be allowed. Fetching one public https URL may be allowed. " +
  "Sending email, deleting a record, and running SQL are side effects: prefer ask-human when the user asked for that call, " +
  "and deny when they did not. Never allow a destructive call the user did not ask for.";

export type ToolGateCall = {
  tool: string;
  arguments: Record<string, unknown>;
  argsSummary: string;
  userRequest: string;
};

export type ToolGateVerdict = {
  decision: GateDecision;
  probabilities: Probabilities;
  confidence: number;
  latencyMs: number;
  model: string;
  source: GateSource;
  reason: string;
};

export type ToolGateDeps = {
  model: ClefModel;
  modelId: string;
  confidenceFloor: number;
  /** Localhost may fall back to the labeled heuristic. Production passes false. */
  allowHeuristic: boolean;
  /** Already authorized by the edge. Smoke sets this so the pause path is deterministic. */
  forceHeuristic: boolean;
  run: (modelId: string, body: ClefRequest) => Promise<unknown>;
};

export type ClefRequest = {
  model: ClefModel;
  state: {
    policy: string;
    user_request: string;
    tool_call: { tool: string; arguments: Record<string, unknown> };
  };
  questions: {
    action: {
      type: "choice";
      instructions: string;
      criteria: Record<GateDecision, string>;
    };
  };
};

type ParsedChoice = {
  probabilities: Probabilities;
  confidence: number | null;
  choice: GateDecision | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function isDecision(value: unknown): value is GateDecision {
  return value === "allow" || value === "deny" || value === "ask-human";
}

/** TypeSafe's choice confidence: (n * pMax - 1) / (n - 1). Uniform is 0, a sure answer is 1. */
export function distributionConfidence(probabilities: Probabilities): number {
  const values = GATE_DECISIONS.map((key) => probabilities[key]);
  const max = Math.max(...values);
  const n = values.length;
  return Math.min(1, Math.max(0, (n * max - 1) / (n - 1)));
}

/**
 * Argmax, with deny beating ask-human beating allow on a tie.
 * Below the floor, the call waits for a person instead of acting.
 */
export function decideFromProbabilities(
  probabilities: Probabilities,
  reportedConfidence: number | null,
  floor: number,
): { decision: GateDecision; confidence: number; escalated: boolean } {
  const order: GateDecision[] = ["deny", "ask-human", "allow"];
  let decision: GateDecision = "deny";
  let best = -1;
  for (const key of order) {
    if (probabilities[key] > best) {
      best = probabilities[key];
      decision = key;
    }
  }
  const confidence = reportedConfidence ?? distributionConfidence(probabilities);
  if (confidence < floor) return { decision: "ask-human", confidence, escalated: decision !== "ask-human" };
  return { decision, confidence, escalated: false };
}

function unwrapBody(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (body.success === false) return null;
  if (isRecord(body.result)) return body.result;
  return body;
}

/** Pull the choice answer out of a Clef / System One payload. Null means fail closed. */
export function parseChoiceAnswer(body: unknown): ParsedChoice | null {
  const root = unwrapBody(body);
  if (!root) return null;
  const answers = root.answers;
  if (!isRecord(answers)) return null;
  const action = answers.action;
  if (!isRecord(action)) return null;
  const raw = action.probabilities;
  if (!isRecord(raw)) return null;

  const probabilities = emptyProbabilities();
  let sum = 0;
  for (const key of GATE_DECISIONS) {
    const value = unit(raw[key]);
    if (value === null) return null;
    probabilities[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > 0.2) return null;

  const choice = isDecision(action.choice) ? action.choice : null;
  return { probabilities, confidence: unit(action.confidence), choice };
}

export function verdictFromClefBody(body: unknown, floor: number, modelId: string): ToolGateVerdict | null {
  const parsed = parseChoiceAnswer(body);
  if (!parsed) return null;
  const decided = decideFromProbabilities(parsed.probabilities, parsed.confidence, floor);
  return {
    decision: decided.decision,
    probabilities: parsed.probabilities,
    confidence: decided.confidence,
    latencyMs: 0,
    model: modelId,
    source: "clef",
    reason: reasonFor(decided.decision, decided.escalated, false),
  };
}

function reasonFor(decision: GateDecision, escalated: boolean, heuristic: boolean): string {
  const prefix = heuristic ? "Local heuristic, because Workers AI was not used. " : "";
  if (escalated) return `${prefix}The leading answer was below the confidence floor, so the call waits for a person.`;
  if (decision === "allow") return `${prefix}The gate would let this call run.`;
  if (decision === "deny") return `${prefix}The gate would block this call.`;
  return `${prefix}The gate wants a person to decide before this call runs.`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "0.0.0.0" || host === "::1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Labeled stand-in used only when Clef cannot be asked on localhost. */
export function heuristicProbabilities(call: ToolGateCall): Probabilities {
  const asked = call.userRequest.toLowerCase();
  if (call.tool === "read_docs") return { allow: 0.9, deny: 0.03, "ask-human": 0.07 };
  if (call.tool === "fetch_url") {
    const raw = typeof call.arguments.url === "string" ? call.arguments.url : "";
    let blocked = true;
    try {
      const url = new URL(raw);
      blocked = url.protocol !== "https:" || isPrivateHost(url.hostname);
    } catch {
      blocked = true;
    }
    if (blocked) return { allow: 0.04, deny: 0.9, "ask-human": 0.06 };
    return { allow: 0.86, deny: 0.04, "ask-human": 0.1 };
  }
  if (call.tool === "send_email") return { allow: 0.08, deny: 0.14, "ask-human": 0.78 };
  if (call.tool === "delete_record") {
    if (!/delete|remove/.test(asked)) return { allow: 0.03, deny: 0.92, "ask-human": 0.05 };
    return { allow: 0.1, deny: 0.12, "ask-human": 0.78 };
  }
  if (call.tool === "run_sql") {
    const sql = typeof call.arguments.sql === "string" ? call.arguments.sql.trim().toLowerCase() : "";
    if (/^(drop|delete|update|insert|alter|truncate)\b/.test(sql)) return { allow: 0.04, deny: 0.9, "ask-human": 0.06 };
    return { allow: 0.12, deny: 0.1, "ask-human": 0.78 };
  }
  return { allow: 0.05, deny: 0.15, "ask-human": 0.8 };
}

function heuristicVerdict(call: ToolGateCall, floor: number): ToolGateVerdict {
  const probabilities = heuristicProbabilities(call);
  const decided = decideFromProbabilities(probabilities, null, floor);
  return {
    decision: decided.decision,
    probabilities,
    confidence: decided.confidence,
    latencyMs: 0,
    model: "local-heuristic",
    source: "local-heuristic",
    reason: reasonFor(decided.decision, decided.escalated, true),
  };
}

function unavailableVerdict(): ToolGateVerdict {
  return {
    decision: "deny",
    probabilities: { allow: 0, deny: 1, "ask-human": 0 },
    confidence: 1,
    latencyMs: 0,
    model: "unavailable",
    source: "unavailable",
    reason: "The decision model could not be consulted. The gate fails closed and the tool did not run.",
  };
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 8)) {
    if (typeof value === "string") out[key] = clipText(value, 200);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function clefRequest(model: ClefModel, call: ToolGateCall): ClefRequest {
  return {
    model,
    state: {
      policy: POLICY,
      user_request: clipText(call.userRequest, 500),
      tool_call: { tool: call.tool, arguments: clipArgs(call.arguments) },
    },
    questions: {
      action: {
        type: "choice",
        instructions:
          "Should this sandboxed tool call run? allow means it is safe and the user asked for it. deny means it is destructive or not requested. ask-human means a person should confirm first.",
        criteria: {
          allow: "The call only reads demo data or one public https page, and the user asked for it.",
          deny: "The call emails, deletes, or mutates, and the user did not ask for that call.",
          "ask-human": "The call has a side effect and the user did ask, or the intent is ambiguous.",
        },
      },
    },
  };
}

export async function toolGate(call: ToolGateCall, deps: ToolGateDeps): Promise<ToolGateVerdict> {
  const started = Date.now();
  if (deps.forceHeuristic && deps.allowHeuristic) {
    const verdict = heuristicVerdict(call, deps.confidenceFloor);
    verdict.latencyMs = Date.now() - started;
    return verdict;
  }

  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("clef_timeout")), 8_000);
    });
    const body = await Promise.race([deps.run(deps.modelId, clefRequest(deps.model, call)), timeout]);
    const parsed = verdictFromClefBody(body, deps.confidenceFloor, deps.modelId);
    if (!parsed) throw new Error("clef_unparsed");
    parsed.latencyMs = Date.now() - started;
    return parsed;
  } catch (err) {
    console.warn(JSON.stringify({ event: "clef_unavailable", tool: call.tool, error: err instanceof Error ? err.message : "error" }));
    if (deps.allowHeuristic) {
      const verdict = heuristicVerdict(call, deps.confidenceFloor);
      verdict.latencyMs = Date.now() - started;
      return verdict;
    }
    const closed = unavailableVerdict();
    closed.latencyMs = Date.now() - started;
    return closed;
  }
}
