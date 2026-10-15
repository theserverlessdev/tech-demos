import { LIMITS } from "./limits";
import type { ChoiceQuestion, Modality, SampleId } from "./types";

export type SampleMeta = {
  file: string;
  label: string;
  note: string;
  kind: Modality;
};

export type Preset = {
  id: string;
  group: string;
  title: string;
  proves: string;
  tryHint: string;
  sample: SampleId;
  expected: string;
  questions: { instructions: string; options: string[] }[];
};

export const SAMPLES: Record<SampleId, SampleMeta> = {
  "receipt-legible": {
    file: "receipt-legible.jpg",
    label: "Readable receipt",
    note: "Self-made cafe receipt. Merchant, date, and total are in focus.",
    kind: "image",
  },
  "receipt-blurry": {
    file: "receipt-blurry.jpg",
    label: "Blurry receipt",
    note: "The same receipt, motion-blurred so the lines cannot be read.",
    kind: "image",
  },
  "phone-cracked": {
    file: "phone-cracked.jpg",
    label: "Cracked phone screen",
    note: "CC0 photo of a shattered smartphone. Grandmaster Huon, Wikimedia Commons.",
    kind: "image",
  },
  "phone-intact": {
    file: "phone-intact.jpg",
    label: "Intact phone screen",
    note: "CC0 photo of an undamaged smartphone display, cropped to the glass. Wikimedia Commons.",
    kind: "image",
  },
  "parcel-damaged": {
    file: "parcel-damaged.jpg",
    label: "Damaged parcel",
    note: "Self-made delivery still. Corner crushed, flap torn, label marked through.",
    kind: "image",
  },
  "parcel-intact": {
    file: "parcel-intact.jpg",
    label: "Intact parcel",
    note: "Self-made still. Sealed carton, tape intact, clean edges, plain background.",
    kind: "image",
  },
  "voice-urgent": {
    file: "voice-urgent.wav",
    label: "Urgent support note",
    note: "Self-made spoken note. Angry billing complaint, asks for a fix now.",
    kind: "audio",
  },
  "voice-routine": {
    file: "voice-routine.wav",
    label: "Routine support note",
    note: "Self-made spoken note. Calm address change, no rush.",
    kind: "audio",
  },
  "safety-fall": {
    file: "safety-fall.mp4",
    label: "Person falling",
    note: "Self-made four-second clip. A figure loses balance, hits the floor, and a thud plays.",
    kind: "video",
  },
  "safety-walk": {
    file: "safety-walk.mp4",
    label: "Person walking",
    note: "Self-made four-second clip. A figure walks across the aisle with footsteps.",
    kind: "video",
  },
};

const RECEIPT_QUESTION = {
  instructions: "Can this expense receipt be read well enough to file?",
  options: ["Readable — merchant, date, and total are clear", "Too blurry to read", "Not a receipt"],
};

const PRODUCT_QUESTION = {
  instructions: "Does this product photo fail QA for a visible crack?",
  options: ["Fail — a crack or break is visible", "Pass — the item looks intact", "Not a product photo"],
};

const PARCEL_QUESTION = {
  instructions: "What is the condition of this parcel at delivery?",
  options: ["Damaged — crushed, torn, or open", "Intact — sealed, tape and edges clean", "Not a parcel"],
};

const VOICE_QUESTION = {
  instructions: "How should this support voice note be triaged?",
  options: ["Urgent — angry or in distress", "Routine — calm, can wait", "Not a support voice note"],
};

const SAFETY_QUESTION = {
  instructions: "What happens in this workplace safety clip?",
  options: ["A person is falling", "A person is walking normally", "No person is visible"],
};

export const PRESETS: Preset[] = [
  {
    id: "receipt-legible",
    group: "Expense intake",
    title: "Readable receipt",
    proves: "Clef-omni can accept a sharp receipt for expense intake.",
    tryHint: "Then open the blurry twin and watch it refuse the same form.",
    sample: "receipt-legible",
    expected: RECEIPT_QUESTION.options[0]!,
    questions: [RECEIPT_QUESTION],
  },
  {
    id: "receipt-blurry",
    group: "Expense intake",
    title: "Blurry receipt",
    proves: "A motion-blurred slip is rejected before anyone keys it in.",
    tryHint: "Compare with the readable receipt on the same question.",
    sample: "receipt-blurry",
    expected: RECEIPT_QUESTION.options[1]!,
    questions: [RECEIPT_QUESTION],
  },
  {
    id: "phone-cracked",
    group: "Product QA",
    title: "Cracked screen",
    proves: "A shattered phone screen fails a one-shot QA check.",
    tryHint: "Then judge the intact screen with the same options.",
    sample: "phone-cracked",
    expected: PRODUCT_QUESTION.options[0]!,
    questions: [PRODUCT_QUESTION],
  },
  {
    id: "phone-intact",
    group: "Product QA",
    title: "Intact screen",
    proves: "An undamaged display passes the same QA question.",
    tryHint: "Swap to the cracked phone to see the fail path.",
    sample: "phone-intact",
    expected: PRODUCT_QUESTION.options[1]!,
    questions: [PRODUCT_QUESTION],
  },
  {
    id: "parcel-damaged",
    group: "Delivery",
    title: "Damaged parcel",
    proves: "A crushed box at the door is marked damaged.",
    tryHint: "Judge the closed box next to see the intact path.",
    sample: "parcel-damaged",
    expected: PARCEL_QUESTION.options[0]!,
    questions: [PARCEL_QUESTION],
  },
  {
    id: "parcel-intact",
    group: "Delivery",
    title: "Intact parcel",
    proves: "A sealed carton with clean tape is marked intact at delivery.",
    tryHint: "The damaged twin uses the same three options.",
    sample: "parcel-intact",
    expected: PARCEL_QUESTION.options[1]!,
    questions: [PARCEL_QUESTION],
  },
  {
    id: "voice-urgent",
    group: "Support voice",
    title: "Urgent / angry",
    proves: "An angry billing note routes as urgent without a transcript step.",
    tryHint: "Play the calm address-change note next.",
    sample: "voice-urgent",
    expected: VOICE_QUESTION.options[0]!,
    questions: [VOICE_QUESTION],
  },
  {
    id: "voice-routine",
    group: "Support voice",
    title: "Routine / calm",
    proves: "A calm request waits in the routine queue.",
    tryHint: "The angry twin uses the same triage options.",
    sample: "voice-routine",
    expected: VOICE_QUESTION.options[1]!,
    questions: [VOICE_QUESTION],
  },
  {
    id: "safety-fall",
    group: "Safety clip",
    title: "Person falling",
    proves: "A short clip of a fall is flagged without splitting frames.",
    tryHint: "The walking clip answers the same question.",
    sample: "safety-fall",
    expected: SAFETY_QUESTION.options[0]!,
    questions: [SAFETY_QUESTION],
  },
  {
    id: "safety-walk",
    group: "Safety clip",
    title: "Walking normally",
    proves: "A person walking across the floor is not an incident.",
    tryHint: "Compare with the fall on the same checklist.",
    sample: "safety-walk",
    expected: SAFETY_QUESTION.options[1]!,
    questions: [SAFETY_QUESTION],
  },
];

export const PRESET_GROUPS = ["Expense intake", "Product QA", "Delivery", "Support voice", "Safety clip"] as const;

const OPTION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

function clean(value: string, max: number): string {
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function presetForSample(id: SampleId): Preset | undefined {
  return PRESETS.find((preset) => preset.sample === id);
}

export function validateQuestions(input: unknown): { ok: true; questions: ChoiceQuestion[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.maxQuestions) {
    return { ok: false, message: `Send 1 to ${LIMITS.maxQuestions} questions.` };
  }
  const questions: ChoiceQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!isRecord(row)) return { ok: false, message: "Each question needs text and options." };
    const instructions = clean(typeof row.instructions === "string" ? row.instructions : "", LIMITS.maxQuestionChars);
    if (instructions.length < LIMITS.minQuestionChars) {
      return { ok: false, message: `Question ${i + 1} needs at least ${LIMITS.minQuestionChars} characters.` };
    }
    if (!Array.isArray(row.options)) return { ok: false, message: `Question ${i + 1} needs options.` };
    if (row.options.length < LIMITS.minOptions || row.options.length > LIMITS.maxOptions) {
      return { ok: false, message: `Question ${i + 1} needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options.` };
    }
    const options: ChoiceQuestion["options"] = [];
    const seen = new Set<string>();
    for (let j = 0; j < row.options.length; j++) {
      const raw = row.options[j];
      const label = clean(typeof raw === "string" ? raw : isRecord(raw) && typeof raw.label === "string" ? raw.label : "", LIMITS.maxOptionChars);
      if (label.length < LIMITS.minOptionChars) return { ok: false, message: `Option ${j + 1} on question ${i + 1} is empty.` };
      const key = label.toLowerCase();
      if (seen.has(key)) return { ok: false, message: `Question ${i + 1} repeats an option.` };
      seen.add(key);
      const id = OPTION_IDS[j];
      if (!id) return { ok: false, message: "Too many options." };
      options.push({ id, label });
    }
    questions.push({ id: `q${i}`, instructions, options });
  }
  return { ok: true, questions };
}
