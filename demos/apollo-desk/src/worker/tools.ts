import { z } from "zod";
import { RECALL_TOOL_MIN_SCORE, SPEECH_MODES, type DeskState, type RecallHit, type SpeechModeId, type WeatherReport } from "../shared/protocol";
import { currentWeather, geocode } from "./weather";

/** What a tool handler can reach. The `Apollo` agent implements it. Upstream calls this `context.effects`. */
export interface DeskHost {
  readonly state: DeskState;
  patchState(patch: Partial<DeskState>): void;
  rememberFact(fact: string): Promise<{ id: number; dims: number; duplicate: boolean }>;
  recall(query: string, limit: number, minScore?: number): Promise<RecallHit[]>;
  forgetEverything(): { facts: number; items: number; messages: number };
  addListItem(list: string, item: string): { list: string; count: number };
  readList(list: string): string[];
  removeListItem(list: string, item: string): boolean;
  scheduleReminder(kind: "timer" | "reminder", label: string, delaySeconds: number): Promise<{ id: string; firesAt: string }>;
  listReminders(): Promise<{ id: string; kind: string; label: string; inSeconds: number }[]>;
  cancelReminder(id: string): Promise<boolean>;
  /** JSON-RPC `tools/call` to the MCP server that runs on the desk. */
  deviceTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  setWeather(report: WeatherReport): void;
}

export type ToolDefinition = {
  name: string;
  /** Upstream `ToolSafety`. An unsafe tool waits for a Yes on the desk before it runs. */
  safety: "safe" | "unsafe";
  description: string;
  /** The desk shows this caption while the tool runs. Upstream `turn/caption.ts`. */
  caption: string;
  schema: z.ZodObject;
  handler: (args: any, host: DeskHost) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  confirmSummary?: (args: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
};

function tool<S extends z.ZodObject>(def: Omit<ToolDefinition, "schema" | "handler" | "confirmSummary"> & {
  schema: S;
  handler: (args: z.infer<S>, host: DeskHost) => Promise<unknown>;
  confirmSummary?: (args: z.infer<S>) => string;
}): ToolDefinition {
  return def as ToolDefinition;
}

const level = z.coerce.number().int().min(0).max(100).describe("Level from 0 to 100.");
const listName = z.string().trim().min(1).max(40).describe('List name, for example "groceries".');

export const TOOLS: ToolDefinition[] = [
  tool({
    name: "weather_now",
    safety: "safe",
    caption: "Checking the weather…",
    description: "Current weather and today's high and low. Uses the saved desk location when you give no location.",
    schema: z.object({ location: z.string().max(80).optional().describe("City name. Leave empty for the saved location.") }),
    async handler({ location }, host) {
      const loc = location ? await geocode(location) : host.state.location;
      if (!loc) return { error: "No saved location. Ask the user for a city, then call set_weather_location." };
      const report = await currentWeather(loc);
      if (!location || loc.label === host.state.location?.label) host.setWeather(report);
      return report;
    },
  }),
  tool({
    name: "set_weather_location",
    safety: "safe",
    caption: "Saving the location…",
    description: "Save the city for weather and for the dashboard clock.",
    schema: z.object({ location: z.string().min(2).max(80).describe("City name, for example Lisbon.") }),
    async handler({ location }, host) {
      const loc = await geocode(location);
      host.patchState({ location: loc });
      const report = await currentWeather(loc);
      host.setWeather(report);
      return { saved: loc.label, timezone: loc.timezone, now: report };
    },
  }),
  tool({
    name: "remember_fact",
    safety: "safe",
    caption: "Saving to memory…",
    description: "Store one lasting fact about the user or their preferences. Write it as a short third-person sentence.",
    schema: z.object({ fact: z.string().trim().min(3).max(240).describe('For example "The user drinks jasmine tea."') }),
    async handler({ fact }, host) {
      return host.rememberFact(fact);
    },
  }),
  tool({
    name: "recall_memory",
    safety: "safe",
    caption: "Searching memory…",
    description: "Search stored facts by meaning and by keyword.",
    schema: z.object({ query: z.string().trim().min(2).max(200) }),
    async handler({ query }, host) {
      const hits = await host.recall(query, 5, RECALL_TOOL_MIN_SCORE);
      return hits.length ? hits : { hits: [], note: "Nothing stored matches." };
    },
  }),
  tool({
    name: "set_timer",
    safety: "safe",
    caption: "Starting a timer…",
    description: "Start a countdown timer. The desk draws the arc and chimes at the end.",
    schema: z.object({
      durationSeconds: z.coerce.number().int().min(5).max(86_400),
      label: z.string().trim().max(40).optional().describe('Short label, for example "tea".'),
    }),
    async handler({ durationSeconds, label }, host) {
      return host.scheduleReminder("timer", label || "Timer", durationSeconds);
    },
  }),
  tool({
    name: "set_reminder",
    safety: "safe",
    caption: "Setting a reminder…",
    description: "Speak a reminder message after a delay. Work out the delay from the current time in the system prompt.",
    schema: z.object({
      message: z.string().trim().min(2).max(160).describe('What the desk says, for example "Stretch your legs".'),
      delaySeconds: z.coerce.number().int().min(5).max(86_400),
    }),
    async handler({ message, delaySeconds }, host) {
      return host.scheduleReminder("reminder", message, delaySeconds);
    },
  }),
  tool({
    name: "list_reminders",
    safety: "safe",
    caption: "Reading reminders…",
    description: "List the timers and reminders that have not fired.",
    schema: z.object({}),
    async handler(_args, host) {
      return host.listReminders();
    },
  }),
  tool({
    name: "cancel_reminder",
    safety: "safe",
    caption: "Cancelling…",
    description: "Cancel a timer or reminder by id. Call list_reminders first to get the id.",
    schema: z.object({ id: z.string().min(1).max(80) }),
    async handler({ id }, host) {
      return { cancelled: await host.cancelReminder(id) };
    },
  }),
  tool({
    name: "add_to_list",
    safety: "safe",
    caption: "Adding to the list…",
    description: "Add one item to a named list.",
    schema: z.object({ list: listName, item: z.string().trim().min(1).max(80) }),
    async handler({ list, item }, host) {
      return host.addListItem(list, item);
    },
  }),
  tool({
    name: "read_list",
    safety: "safe",
    caption: "Reading the list…",
    description: "Read the items on a named list.",
    schema: z.object({ list: listName }),
    async handler({ list }, host) {
      return { list, items: host.readList(list) };
    },
  }),
  tool({
    name: "remove_from_list",
    safety: "safe",
    caption: "Updating the list…",
    description: "Remove one item from a named list.",
    schema: z.object({ list: listName, item: z.string().trim().min(1).max(80) }),
    async handler({ list, item }, host) {
      return { removed: host.removeListItem(list, item) };
    },
  }),
  tool({
    name: "set_speech_mode",
    safety: "safe",
    caption: "Changing my voice…",
    description: `Change how you speak. Modes: ${SPEECH_MODES.map((m) => m.id).join(", ")}.`,
    schema: z.object({ mode: z.enum(SPEECH_MODES.map((m) => m.id) as [SpeechModeId, ...SpeechModeId[]]) }),
    async handler({ mode }, host) {
      host.patchState({ speechMode: mode });
      return { speechMode: mode };
    },
  }),
  tool({
    name: "set_volume",
    safety: "safe",
    caption: "Setting the volume…",
    description: "Set the desk speaker volume. This calls the MCP server on the desk.",
    schema: z.object({ level }),
    async handler({ level }, host) {
      return host.deviceTool("self.audio_speaker.set_volume", { volume: level });
    },
  }),
  tool({
    name: "set_brightness",
    safety: "safe",
    caption: "Setting the brightness…",
    description: "Set the desk screen brightness. This calls the MCP server on the desk.",
    schema: z.object({ level }),
    async handler({ level }, host) {
      return host.deviceTool("self.screen.set_brightness", { brightness: level });
    },
  }),
  tool({
    name: "device_status",
    safety: "safe",
    caption: "Checking the desk…",
    description: "Read volume, brightness, firmware, and uptime from the desk MCP server.",
    schema: z.object({}),
    async handler(_args, host) {
      return host.deviceTool("self.get_device_status", {});
    },
  }),
  tool({
    name: "forget_everything",
    safety: "unsafe",
    caption: "Waiting for your OK…",
    description: "Delete all stored facts, lists, and conversation history for this desk. The user must press Yes on the desk.",
    schema: z.object({}),
    confirmSummary: () => "Forget all facts, lists, and history?",
    async handler(_args, host) {
      return host.forgetEverything();
    },
  }),
];

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** OpenAI-style function definitions for Workers AI. The JSON Schema comes from the Zod schema. */
export const MODEL_TOOLS = TOOLS.map((t) => {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
});
