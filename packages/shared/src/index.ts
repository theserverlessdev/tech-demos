export type DemoMeta = {
  slug: string;
  title: string;
  /** One-line tagline under the title. */
  description: string;
  /** The platform pattern this demo proves, in one or two sentences. */
  demonstrates: string;
  /** What a visitor can actually try in this demo. */
  capabilities: string[];
  /** Products you could build with the same pattern. */
  useCases: string[];
  tags: string[];
};

export const HUB_HOST = "tech-demos.theserverless.dev";

export function demoPath(slug: string): string {
  return `/demos/${slug}`;
}

export function demoSubdomain(slug: string, proto = "https"): string {
  return `${proto}://${slug}.${HUB_HOST}`;
}

export function demoUrl(slug: string, proto = "https"): string {
  return `${proto}://${HUB_HOST}${demoPath(slug)}`;
}
