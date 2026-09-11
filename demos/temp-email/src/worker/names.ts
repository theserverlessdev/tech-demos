const ADJECTIVES = [
  "amber", "ashen", "bold", "brisk", "calm", "cinder", "clear", "coal", "copper", "crisp",
  "dusky", "early", "ember", "faint", "fern", "flint", "frosty", "gentle", "glow", "granite",
  "hazel", "hollow", "iron", "jade", "keen", "late", "lucid", "lunar", "maple", "mellow",
  "misty", "molten", "nimble", "north", "ochre", "opal", "pale", "plain", "quiet", "rapid",
  "rustic", "sable", "sage", "silent", "slate", "smoky", "solar", "spare", "steady", "stone",
  "swift", "tawny", "tidy", "umber", "vivid", "warm", "west", "wild", "windy", "young",
];

const NOUNS = [
  "anvil", "badger", "beacon", "birch", "bramble", "brook", "canyon", "cedar", "comet", "cove",
  "crane", "delta", "dune", "falcon", "ferry", "field", "finch", "fjord", "forge", "fox",
  "glade", "grove", "harbor", "heron", "hill", "kiln", "lagoon", "lark", "ledge", "lynx",
  "marsh", "meadow", "mesa", "moth", "otter", "owl", "pebble", "pine", "plover", "quarry",
  "raven", "reef", "ridge", "river", "robin", "shoal", "spark", "spruce", "stoat", "summit",
  "tern", "thicket", "tide", "valley", "vole", "willow", "wren", "yarrow", "yew", "zephyr",
];

function pick<T>(list: T[]): T {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return list[n % list.length];
}

/** Example: "ember-otter-4821". About 32 million names. */
export function randomLocalPart(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${1000 + (n % 9000)}`;
}

const RESERVED = new Set([
  "abuse", "admin", "administrator", "hostmaster", "info", "mailer-daemon", "no-reply", "noreply",
  "postmaster", "root", "security", "support", "webmaster",
]);

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

/** Returns an error message, or null when the name is valid. */
export function checkLocalPart(local: string): string | null {
  if (!LOCAL_PART.test(local) || local.includes("..")) {
    return "Use 3 to 32 characters: a to z, 0 to 9, dot, dash, or underscore. Start and end with a letter or a digit.";
  }
  if (RESERVED.has(local)) return `The name "${local}" is reserved.`;
  return null;
}
