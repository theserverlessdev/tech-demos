export type LitmusSuite = {
  name: string;
  passed: number;
  failed: number;
  /** Unedited litmus output for this suite. Required when the run is real. */
  raw: string;
};

/**
 * Only fill this in from a real `litmus` invocation.
 * `ran: false` with an empty suite list means we did not run it.
 */
export const LITMUS_RESULTS: {
  ran: boolean;
  at: string | null;
  command: string | null;
  note: string;
  suites: LitmusSuite[];
} = {
  ran: false,
  at: null,
  command: null,
  note: "Litmus was not run in this environment. These are not results.",
  suites: [],
};
