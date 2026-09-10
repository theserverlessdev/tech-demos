export type DemoMeta = {
  slug: string;
  title: string;
  description: string;
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
