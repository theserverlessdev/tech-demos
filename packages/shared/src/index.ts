export type DemoMeta = {
  slug: string;
  title: string;
  description: string;
  tags: string[];
};

export function demoPath(slug: string): string {
  return `/demos/${slug}`;
}
