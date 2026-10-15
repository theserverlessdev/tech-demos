import { LIMITS } from "./limits";
import type { ChoiceQuestion, SampleId } from "./types";

export type Preset = {
  id: string;
  title: string;
  sample: SampleId | null;
  questions: { instructions: string; options: string[] }[];
};

export const PRESETS: Preset[] = [
  {
    id: "voicemail",
    title: "Is this voicemail urgent?",
    sample: "voicemail",
    questions: [
      {
        instructions: "Is this voicemail urgent?",
        options: ["Urgent", "Can wait", "Not a voicemail"],
      },
    ],
  },
  {
    id: "machine",
    title: "Does the machine sound healthy?",
    sample: "machine",
    questions: [
      {
        instructions: "Does the machine sound healthy?",
        options: ["Healthy", "Strained", "Failing", "Not a machine"],
      },
    ],
  },
  {
    id: "gallery",
    title: "Is this image safe for a public gallery?",
    sample: "gallery",
    questions: [
      {
        instructions: "Is this image safe for a public gallery?",
        options: ["Safe to show", "Needs review", "Not safe"],
      },
    ],
  },
  {
    id: "package",
    title: "Is this a photo of a damaged package?",
    sample: "package",
    questions: [
      {
        instructions: "Is this a photo of a damaged package?",
        options: ["Damaged", "Intact", "Not a package"],
      },
    ],
  },
];

export const SAMPLES: Record<SampleId, { file: string; label: string; note: string }> = {
  voicemail: {
    file: "voicemail.wav",
    label: "Voicemail tone",
    note: "Self-made beeps, not a recorded message.",
  },
  machine: {
    file: "machine.wav",
    label: "Machine tone",
    note: "Self-made hum, not a real machine.",
  },
  gallery: {
    file: "gallery.png",
    label: "Gallery still",
    note: "Self-made geometric image.",
  },
  package: {
    file: "package.png",
    label: "Package still",
    note: "Self-made drawing of a torn box.",
  },
  clip: {
    file: "clip.webm",
    label: "Short clip",
    note: "Self-made one-second clip with a tone.",
  },
};

const OPTION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

function clean(value: string, max: number): string {
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
