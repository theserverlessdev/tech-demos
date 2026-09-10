import type { DemoEntry } from "./registry";
import { demoPath, demoSubdomain, HUB_HOST } from "@tech-demos/shared";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * LogoMark — the current TheServerless.Dev icon: cloud outline, lightning
 * bolt and speed streaks. Flat ember, no gradient. It uses `currentColor`,
 * so the wrapping link sets the accent.
 *
 * Kept in sync with `src/components/ui/LogoMark.astro` on the main site.
 */
function logoMark(size: number): string {
  return `<svg class="logo-mark-svg" width="${size}" height="${size}" viewBox="0 -3 128 128" role="img" aria-label="TheServerless.Dev" xmlns="http://www.w3.org/2000/svg">
  <g stroke="currentColor" stroke-width="6" stroke-linecap="round" opacity="0.45">
    <line x1="4" y1="58" x2="20" y2="58" />
    <line x1="1" y1="72" x2="19" y2="72" />
    <line x1="6" y1="86" x2="22" y2="86" />
  </g>
  <path d="M44 92 C31 92 20 82 20 69 C20 57 29 47 41 46 C45 33 57 24 70 24 C85 24 98 35 100 51 C110 53 118 62 118 72 C118 83 109 92 97 92 Z" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linejoin="round" />
  <path d="M69 36 L50 71 L63 71 L57 102 L88 60 L72 60 L80 36 Z" fill="currentColor" />
</svg>`;
}

const NAV_ITEMS = [
  { label: "Guides", href: "https://theserverless.dev/guides/page/1" },
  { label: "Calculators", href: "https://theserverless.dev/calculators" },
  { label: "Blog", href: "https://theserverless.dev/blog/page/1" },
  { label: "Portfolio", href: "https://theserverless.dev/portfolio" },
];

const ARROW =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>';

const EXTERNAL =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';

function renderCard(demo: DemoEntry, index: number): string {
  const path = demoPath(demo.slug);
  const tags = (demo.tags || [])
    .map((t) => `<li class="chip">${escapeHtml(t)}</li>`)
    .join("");

  return `<article class="demo-card">
        <div class="demo-card__head">
          <span class="demo-card__index">${String(index + 1).padStart(2, "0")}</span>
          <span class="demo-card__badge">Dynamic Worker</span>
        </div>
        <h2 class="demo-card__title">
          <a class="demo-card__link" href="${escapeHtml(path)}">${escapeHtml(demo.title)}</a>
        </h2>
        <p class="demo-card__desc">${escapeHtml(demo.description)}</p>
        <ul class="demo-card__tags">${tags}</ul>
        <div class="demo-card__foot">
          <span class="demo-card__cta">Open demo ${ARROW}</span>
          <a class="demo-card__alt" href="${escapeHtml(demoSubdomain(demo.slug))}" rel="noopener" title="${escapeHtml(demoSubdomain(demo.slug))}">subdomain ${EXTERNAL}</a>
        </div>
      </article>`;
}

export function renderGallery(demos: DemoEntry[]): string {
  const cards = demos.map(renderCard).join("\n");

  const empty = `<div class="empty">
        <p class="empty__title">No demos are live yet.</p>
        <p class="empty__body">Add one under <code>demos/&lt;slug&gt;</code>, then register it in <code>apps/hub/src/registry.ts</code>.</p>
      </div>`;

  const count = demos.length;
  const nav = NAV_ITEMS.map(
    (item) => `<li><a href="${item.href}">${item.label}</a></li>`,
  ).join("");

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="theme-color" content="#0e0e11" />
  <title>Tech Demos · theserverless.dev</title>
  <meta name="description" content="One new library or pattern at a time. Each demo runs as an isolated Dynamic Worker on Cloudflare Workers." />
  <link rel="canonical" href="https://${HUB_HOST}/" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <meta property="og:title" content="Tech Demos · theserverless.dev" />
  <meta property="og:description" content="One new library or pattern at a time, each in its own Dynamic Worker." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://${HUB_HOST}/" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Hanken+Grotesk:wght@400..700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script>
    // Apply the stored theme before paint so the page never flashes.
    (function () {
      try {
        var stored = localStorage.getItem("theme");
        var theme = stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
        document.documentElement.setAttribute("data-theme", theme);
      } catch (e) {}
    })();
  </script>
  <style>
    /* =================================================================
       Graphite & Ember — tokens mirrored from theserverless.dev
       Dark first. One flat ember accent. No gradients, no glow.
       ================================================================= */
    :root {
      --color-primary-start: #c2410c;
      --color-primary-end: #c2410c;
      --color-secondary: #e2622e;
      --color-background-rgb: 14, 14, 17;
      --color-primary-start-rgb: 194, 65, 12;

      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 1rem;
      --space-4: 1.5rem;
      --space-5: 2rem;
      --space-6: 3rem;
      --space-7: 4rem;
      --space-8: 6rem;

      --font-heading: "Bricolage Grotesque", "Space Grotesk", system-ui, sans-serif;
      --font-body: "Hanken Grotesk", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

      --text-xs: 0.75rem;
      --text-sm: 0.875rem;
      --text-base: 1rem;
      --text-lg: 1.125rem;
      --text-xl: 1.25rem;
      --text-2xl: 1.5rem;
      --text-4xl: 2.5rem;
      --text-5xl: 3.5rem;

      --leading-tight: 1.08;
      --leading-normal: 1.6;

      --radius-sm: 0.375rem;
      --radius-md: 0.5rem;
      --radius-lg: 0.875rem;
      --radius-full: 9999px;

      --transition-fast: 0.16s cubic-bezier(0.4, 0, 0.2, 1);
      --transition-normal: 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    }

    :root, [data-theme="dark"] {
      --color-background: #0e0e11;
      --color-card-bg: rgba(23, 23, 27, 0.6);
      --color-card-bg-hover: rgba(30, 30, 35, 0.85);
      --color-text: #c9c9c4;
      --color-text-light: #e8e8e4;
      --color-text-muted: #8a8a85;
      --color-border: rgba(255, 255, 255, 0.08);
      --color-shadow: rgba(0, 0, 0, 0.5);
      --color-accent-text: #e2622e;
      --mesh-line: rgba(255, 255, 255, 0.04);
    }

    [data-theme="light"] {
      --color-background: #faf9f6;
      --color-background-rgb: 250, 249, 246;
      --color-card-bg: rgba(255, 255, 255, 0.75);
      --color-card-bg-hover: rgba(255, 255, 255, 0.98);
      --color-text: #3d3a34;
      --color-text-light: #17171a;
      --color-text-muted: #6b675e;
      --color-border: rgba(23, 23, 26, 0.1);
      --color-shadow: rgba(23, 23, 26, 0.08);
      --color-accent-text: #b23a0a;
      --color-primary-start: #b23a0a;
      --color-primary-start-rgb: 178, 58, 10;
      --mesh-line: rgba(23, 23, 26, 0.045);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; scroll-behavior: smooth; }

    body {
      font-family: var(--font-body);
      background-color: var(--color-background);
      color: var(--color-text);
      line-height: var(--leading-normal);
      min-height: 100vh;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background-color var(--transition-normal), color var(--transition-normal);
    }

    h1, h2, h3 {
      font-family: var(--font-heading);
      font-weight: 700;
      line-height: var(--leading-tight);
      color: var(--color-text-light);
    }

    a { color: var(--color-text-light); text-decoration: none; transition: color var(--transition-fast); }
    a:hover { color: var(--color-secondary); }
    ul { list-style: none; }

    code {
      font-family: var(--font-mono);
      font-size: 0.9em;
      background: var(--color-card-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 0.15rem 0.4rem;
      color: var(--color-text);
    }

    .icon { width: 1em; height: 1em; flex-shrink: 0; }

    .container {
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 var(--space-4);
    }

    /* ---------------- Texture: hairline mesh + grain, no colour ------- */
    .edge-bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
    }
    .edge-bg__grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(var(--mesh-line) 1px, transparent 1px),
        linear-gradient(90deg, var(--mesh-line) 1px, transparent 1px);
      background-size: 64px 64px;
      mask-image: radial-gradient(120% 90% at 50% 0%, black, transparent 72%);
      -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, black, transparent 72%);
      opacity: 0.6;
    }
    .edge-bg__grain {
      position: absolute;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      opacity: 0.025;
      mix-blend-mode: overlay;
    }

    /* ------------------------------ Header --------------------------- */
    header {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 100;
      padding: var(--space-3) 0;
      background-color: rgba(var(--color-background-rgb), 0.72);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-bottom: 1px solid transparent;
      transition: padding var(--transition-normal), background-color var(--transition-normal), border-color var(--transition-normal);
    }
    header.scrolled {
      padding: var(--space-2) 0;
      background-color: rgba(var(--color-background-rgb), 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom-color: var(--color-border);
    }
    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
      height: 50px;
    }

    .logo { display: flex; align-items: center; gap: 0.55rem; }
    .logo-mark-svg {
      display: block;
      flex-shrink: 0;
      color: var(--color-accent-text);
      transform-origin: 62% 60%;
      transition: transform var(--transition-fast);
    }
    .logo:hover .logo-mark-svg { transform: rotate(-8deg) scale(1.04); }
    .logo-word {
      font-family: var(--font-heading);
      font-weight: 800;
      font-size: 1.12rem;
      letter-spacing: -0.03em;
      color: var(--color-text-light);
      line-height: 1;
    }
    .logo:hover .logo-word { color: var(--color-text-light); }
    .logo-tld { position: relative; color: var(--color-accent-text); }
    .logo-tld::after {
      content: "";
      position: absolute;
      left: 0; right: 0; bottom: -2px;
      height: 1px;
      background: var(--color-accent-text);
      transform: scaleX(0);
      transform-origin: left center;
      transition: transform var(--transition-fast);
    }
    .logo:hover .logo-tld::after { transform: scaleX(1); }
    .logo-scope {
      display: none;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      border-left: 1px solid var(--color-border);
      padding-left: 0.55rem;
      margin-left: 0.15rem;
    }

    .nav { display: none; }
    @media (min-width: 900px) {
      .nav { display: flex; align-items: center; gap: var(--space-5); height: 100%; }
      .nav ul { display: flex; align-items: center; gap: var(--space-5); height: 100%; }
      .logo-scope { display: inline; }
    }
    .nav a {
      font-weight: 500;
      font-size: var(--text-sm);
      position: relative;
      display: flex;
      align-items: center;
      color: var(--color-text);
    }
    .nav a::after {
      content: "";
      position: absolute;
      bottom: -6px; left: 0;
      width: 100%; height: 2px;
      background: var(--color-primary-start);
      transform: scaleX(0);
      transform-origin: left center;
      transition: transform var(--transition-normal);
    }
    .nav a:hover { color: var(--color-text-light); }
    .nav a:hover::after { transform: scaleX(1); }

    .header-actions { display: flex; align-items: center; gap: var(--space-3); }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4em;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-md);
      font-family: var(--font-body);
      font-weight: 600;
      font-size: var(--text-sm);
      background: var(--color-primary-start);
      color: #fff;
      border: none;
      cursor: pointer;
      box-shadow: none;
      transition: transform var(--transition-fast), background-color var(--transition-fast);
    }
    .button:hover {
      background: var(--color-secondary);
      color: #fff;
      transform: translateY(-2px);
    }
    .button-outline {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-light);
    }
    .button-outline:hover {
      background: transparent;
      color: var(--color-text-light);
      border-color: rgba(var(--color-primary-start-rgb), 0.5);
    }

    .theme-toggle {
      background: none;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      width: 38px; height: 38px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      transition: border-color var(--transition-fast), color var(--transition-fast);
    }
    .theme-toggle:hover { color: var(--color-accent-text); border-color: rgba(var(--color-primary-start-rgb), 0.5); }
    .theme-toggle .icon { width: 1.05rem; height: 1.05rem; }
    [data-theme="dark"] .theme-toggle .icon-sun { display: block; }
    [data-theme="dark"] .theme-toggle .icon-moon { display: none; }
    [data-theme="light"] .theme-toggle .icon-sun { display: none; }
    [data-theme="light"] .theme-toggle .icon-moon { display: block; }

    /* ------------------------------- Main ---------------------------- */
    main { position: relative; z-index: 1; padding-top: var(--space-8); }

    .hero { padding: var(--space-7) 0 var(--space-6); }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-accent-text);
      margin-bottom: var(--space-3);
    }
    .eyebrow::before {
      content: "";
      width: 1.75rem; height: 1px;
      background: var(--color-primary-start);
    }
    h1 {
      font-size: clamp(2.25rem, 6vw, var(--text-5xl));
      letter-spacing: -0.035em;
      margin-bottom: var(--space-4);
    }
    h1 .accent { color: var(--color-accent-text); }
    .lede {
      max-width: 46ch;
      font-size: var(--text-lg);
      color: var(--color-text-muted);
      margin-bottom: var(--space-5);
    }
    .hero-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }

    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      margin-top: var(--space-6);
    }
    .fact { padding: var(--space-4) var(--space-4) var(--space-4) 0; }
    .fact + .fact { border-left: 1px solid var(--color-border); padding-left: var(--space-4); }
    .fact__value {
      font-family: var(--font-heading);
      font-size: var(--text-2xl);
      font-weight: 700;
      color: var(--color-text-light);
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .fact__value--mono {
      font-family: var(--font-mono);
      font-size: var(--text-base);
      font-weight: 500;
      letter-spacing: -0.01em;
      padding-top: 0.35rem;
      overflow-wrap: anywhere;
    }
    .fact__label {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      margin-top: var(--space-1);
    }

    .section { padding: var(--space-6) 0 var(--space-8); }
    .section__head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-4);
      flex-wrap: wrap;
      margin-bottom: var(--space-5);
    }
    .section__title { font-size: var(--text-2xl); letter-spacing: -0.02em; }
    .section__note {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }

    /* ------------------------------ Cards ---------------------------- */
    .grid {
      display: grid;
      gap: var(--space-4);
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }

    .demo-card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
      background: var(--color-card-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      transition: transform var(--transition-normal), border-color var(--transition-normal), background-color var(--transition-normal), box-shadow var(--transition-normal);
    }
    .demo-card::after {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: var(--color-primary-start);
      transform: scaleX(0);
      transform-origin: left;
      transition: transform var(--transition-normal);
      pointer-events: none;
    }
    .demo-card:hover {
      transform: translateY(-4px);
      background: var(--color-card-bg-hover);
      border-color: rgba(var(--color-primary-start-rgb), 0.35);
      box-shadow: 0 10px 20px var(--color-shadow);
    }
    .demo-card:hover::after { transform: scaleX(1); }
    .demo-card:focus-within { border-color: rgba(var(--color-primary-start-rgb), 0.5); }

    .demo-card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .demo-card__index {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      letter-spacing: 0.08em;
    }
    .demo-card__badge {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0.3em 0.7em;
      border-radius: var(--radius-full);
      background: var(--color-primary-start);
      color: #fff;
    }
    .demo-card__title { font-size: var(--text-xl); letter-spacing: -0.02em; }
    .demo-card__link { color: var(--color-text-light); }
    .demo-card__link::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    .demo-card:hover .demo-card__link { color: var(--color-text-light); }
    .demo-card__desc {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
      flex: 1;
    }
    .demo-card__tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      padding: 0.2em 0.65em;
    }
    .demo-card__foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      flex-wrap: wrap;
      padding-top: var(--space-3);
      border-top: 1px solid var(--color-border);
    }
    .demo-card__cta {
      display: inline-flex;
      align-items: center;
      gap: 0.4em;
      font-weight: 600;
      font-size: var(--text-sm);
      color: var(--color-text-light);
      transition: color var(--transition-fast);
    }
    .demo-card__cta .icon { transition: transform var(--transition-fast); }
    .demo-card:hover .demo-card__cta { color: var(--color-accent-text); }
    .demo-card:hover .demo-card__cta .icon { transform: translateX(4px); }
    .demo-card__alt {
      position: relative;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      gap: 0.35em;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .demo-card__alt:hover { color: var(--color-accent-text); }

    .empty {
      grid-column: 1 / -1;
      padding: var(--space-6);
      text-align: center;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-lg);
    }
    .empty__title { font-family: var(--font-heading); font-weight: 700; color: var(--color-text-light); margin-bottom: var(--space-2); }
    .empty__body { color: var(--color-text-muted); font-size: var(--text-sm); }

    /* ------------------------------ Footer --------------------------- */
    footer {
      position: relative;
      z-index: 1;
      border-top: 1px solid var(--color-border);
      padding: var(--space-6) 0 var(--space-5);
    }
    .footer-content {
      display: grid;
      gap: var(--space-5);
      grid-template-columns: 1fr;
    }
    @media (min-width: 900px) {
      .footer-content { grid-template-columns: 1.4fr 1fr 1fr; }
    }
    .footer-logo { display: inline-flex; align-items: center; gap: 0.5rem; margin-bottom: var(--space-3); }
    .footer-word {
      font-family: var(--font-heading);
      font-weight: 800;
      font-size: 1rem;
      letter-spacing: -0.03em;
      color: var(--color-text-light);
    }
    .footer-tld { color: var(--color-accent-text); }
    .footer-logo:hover .logo-mark-svg { transform: rotate(-8deg) scale(1.04); }
    .tagline { color: var(--color-text-muted); font-size: var(--text-sm); max-width: 34ch; }
    .footer-section h3 {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      margin-bottom: var(--space-3);
    }
    .footer-section li { margin-bottom: var(--space-2); }
    .footer-section a { font-size: var(--text-sm); color: var(--color-text); }
    .footer-section a:hover { color: var(--color-accent-text); }
    .footer-bottom {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-border);
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      flex-wrap: wrap;
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }

    @media (max-width: 600px) {
      .header-content { gap: var(--space-2); }
      .logo-word { font-size: 1rem; }
      .button { padding: var(--space-2) var(--space-3); }
      .theme-toggle { width: 34px; height: 34px; }

      .facts { grid-template-columns: 1fr; }
      .fact { padding: var(--space-3) 0; }
      .fact + .fact {
        border-left: none;
        border-top: 1px solid var(--color-border);
        padding-left: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="edge-bg" aria-hidden="true">
    <div class="edge-bg__grid"></div>
    <div class="edge-bg__grain"></div>
  </div>

  <header id="main-header">
    <div class="container">
      <div class="header-content">
        <a href="https://theserverless.dev" class="logo" aria-label="theserverless.dev home">
          ${logoMark(36)}
          <span class="logo-word">theserverless<span class="logo-tld">.dev</span></span>
          <span class="logo-scope">demos</span>
        </a>

        <nav class="nav" aria-label="Primary">
          <ul>${nav}</ul>
        </nav>

        <div class="header-actions">
          <button class="theme-toggle" type="button" aria-label="Toggle dark and light mode">
            <svg class="icon icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
            <svg class="icon icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
          </button>
          <a class="button" href="https://theserverless.dev/contact" rel="noopener">Contact</a>
        </div>
      </div>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <p class="eyebrow">Weekday playground</p>
        <h1>Tech <span class="accent">Demos</span></h1>
        <p class="lede">
          One new library or pattern at a time. Each demo runs as an isolated
          Dynamic Worker on Cloudflare Workers, loaded by this hub at request time.
        </p>
        <div class="hero-actions">
          <a class="button" href="#demos">Browse demos ${ARROW}</a>
          <a class="button button-outline" href="/api/demos">JSON API ${EXTERNAL}</a>
        </div>

        <div class="facts">
          <div class="fact">
            <div class="fact__value">${count}</div>
            <div class="fact__label">Live demo${count === 1 ? "" : "s"}</div>
          </div>
          <div class="fact">
            <div class="fact__value">Dynamic Workers</div>
            <div class="fact__label">Runtime</div>
          </div>
          <div class="fact">
            <div class="fact__value fact__value--mono">${HUB_HOST}</div>
            <div class="fact__label">Host</div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="demos">
      <div class="container">
        <div class="section__head">
          <h2 class="section__title">The gallery</h2>
          <p class="section__note">Each card opens an isolated worker</p>
        </div>
        <div class="grid">
${cards || empty}
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <div class="footer-content">
        <div class="footer-brand">
          <a href="https://theserverless.dev" class="footer-logo" aria-label="theserverless.dev home">
            ${logoMark(30)}
            <span class="footer-word">theserverless<span class="footer-tld">.dev</span></span>
          </a>
          <p class="tagline">Serverless architecture, cost engineering and Cloudflare Workers, explained by the person who ships them.</p>
        </div>

        <div class="footer-section">
          <h3>Site</h3>
          <ul>
            <li><a href="https://theserverless.dev/guides/page/1">Guides</a></li>
            <li><a href="https://theserverless.dev/calculators">Calculators</a></li>
            <li><a href="https://theserverless.dev/blog/page/1">Blog</a></li>
            <li><a href="https://theserverless.dev/portfolio">Portfolio</a></li>
            <li><a href="https://theserverless.dev/consulting">Consulting</a></li>
            <li><a href="https://theserverless.dev/contact">Contact</a></li>
          </ul>
        </div>

        <div class="footer-section">
          <h3>This hub</h3>
          <ul>
            <li><a href="/">Gallery</a></li>
            <li><a href="/api/demos">JSON API</a></li>
            <li><a href="https://github.com/theserverlessdev" rel="noopener">GitHub</a></li>
          </ul>
        </div>
      </div>

      <div class="footer-bottom">
        <span>Part of theserverless.dev</span>
        <span>Running on Cloudflare Workers</span>
      </div>
    </div>
  </footer>

  <script>
    // Header hairline appears once the page scrolls. rAF-throttled.
    (function () {
      var header = document.getElementById("main-header");
      var ticking = false;
      function apply() {
        var y = window.pageYOffset || document.documentElement.scrollTop;
        if (header) header.classList.toggle("scrolled", y > 8);
        ticking = false;
      }
      window.addEventListener("scroll", function () {
        if (!ticking) { window.requestAnimationFrame(apply); ticking = true; }
      }, { passive: true });
      apply();
    })();

    // Theme toggle. CSS drives icon visibility from [data-theme].
    (function () {
      var toggle = document.querySelector(".theme-toggle");
      if (!toggle) return;
      toggle.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try { localStorage.setItem("theme", next); } catch (e) {}
      });
    })();
  </script>
</body>
</html>`;
}
