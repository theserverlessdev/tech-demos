import type { DemoEntry } from "./registry";
import { demoPath, demoUrl, HUB_HOST } from "@tech-demos/shared";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderGallery(demos: DemoEntry[]): string {
  const cards = demos
    .map((d) => {
      const tags = (d.tags || [])
        .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
        .join("");
      return `
        <a class="card" href="${escapeHtml(demoPath(d.slug))}">
          <div class="card-top">
            <h2 class="card-title">${escapeHtml(d.title)}</h2>
            <span class="pill">Dynamic Worker</span>
          </div>
          <p class="card-desc">${escapeHtml(d.description)}</p>
          <div class="card-meta">
            <code>${escapeHtml(demoPath(d.slug))}</code>
          </div>
          <div class="tags">${tags}</div>
        </a>`;
    })
    .join("\n");

  const empty = `<div class="empty">No demos registered yet. Add one under <code>demos/&lt;slug&gt;</code>.</div>`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0a0a0a" />
  <title>Tech Demos · TheServerless.Dev</title>
  <meta name="description" content="Weekday tech demos on Cloudflare Workers — isolated Dynamic Workers from TheServerless.Dev." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Montserrat:wght@600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --color-primary-start: #8a2be2;
      --color-primary-end: #00e5ff;
      --color-secondary: #5856d6;
      --color-background: #0a0a0a;
      --color-header-bg: rgba(10, 10, 10, 0.92);
      --color-card-bg: rgba(20, 20, 20, 0.72);
      --color-card-bg-hover: rgba(30, 30, 30, 0.88);
      --color-text: #e5e5e5;
      --color-text-light: #ffffff;
      --color-text-muted: rgba(229, 229, 229, 0.7);
      --color-border: rgba(255, 255, 255, 0.1);
      --font-heading: "Montserrat", system-ui, sans-serif;
      --font-body: "Inter", system-ui, sans-serif;
      --font-mono: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
      --radius-md: 0.5rem;
      --radius-lg: 1rem;
      --space-2: 0.5rem;
      --space-3: 1rem;
      --space-4: 1.5rem;
      --space-5: 2rem;
      --space-6: 3rem;
      --button-gradient: linear-gradient(90deg, var(--color-primary-start), var(--color-primary-end));
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; }
    body {
      font-family: var(--font-body);
      background:
        radial-gradient(900px 480px at 12% -8%, rgba(138, 43, 226, 0.22), transparent 55%),
        radial-gradient(700px 420px at 88% 0%, rgba(0, 229, 255, 0.12), transparent 50%),
        var(--color-background);
      color: var(--color-text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
    }
    a { color: inherit; text-decoration: none; }
    code {
      font-family: var(--font-mono);
      font-size: 0.85em;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--color-border);
      border-radius: 0.25rem;
      padding: 0.15rem 0.4rem;
      color: var(--color-primary-end);
    }
    .site-header {
      position: sticky; top: 0; z-index: 20;
      backdrop-filter: blur(12px);
      background: var(--color-header-bg);
      border-bottom: 1px solid var(--color-border);
    }
    .header-inner {
      max-width: 1040px; margin: 0 auto;
      padding: 0.9rem 1.25rem;
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    }
    .brand {
      display: flex; align-items: center; gap: 0.65rem;
      font-family: var(--font-heading); font-weight: 700; letter-spacing: -0.02em;
      color: var(--color-text-light);
    }
    .brand-mark {
      width: 1.55rem; height: 1.55rem; border-radius: 0.4rem;
      background: var(--button-gradient);
      box-shadow: 0 0 18px rgba(0, 229, 255, 0.25);
    }
    .brand span.dim { color: var(--color-text-muted); font-weight: 600; }
    .nav { display: flex; gap: 0.85rem; align-items: center; flex-wrap: wrap; }
    .nav a {
      color: var(--color-text-muted); font-size: 0.92rem; font-weight: 500;
      transition: color 0.2s ease;
    }
    .nav a:hover { color: var(--color-primary-end); }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0.45rem 0.9rem; border-radius: var(--radius-md);
      background: var(--button-gradient); color: #fff !important; font-weight: 600;
      font-size: 0.88rem; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0, 229, 255, 0.28); }
    main { max-width: 1040px; margin: 0 auto; padding: var(--space-6) 1.25rem 4rem; }
    .hero { margin-bottom: var(--space-5); }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 0.4rem;
      font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--color-primary-end); margin-bottom: var(--space-2);
    }
    .eyebrow::before {
      content: ""; width: 0.45rem; height: 0.45rem; border-radius: 999px;
      background: var(--color-primary-end); box-shadow: 0 0 10px var(--color-primary-end);
    }
    h1 {
      font-family: var(--font-heading); font-size: clamp(1.8rem, 4vw, 2.5rem);
      color: var(--color-text-light); line-height: 1.15; margin-bottom: var(--space-3);
    }
    h1 .grad {
      background: var(--button-gradient); -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .lede { max-width: 42rem; color: var(--color-text-muted); font-size: 1.05rem; margin-bottom: var(--space-4); }
    .stats { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: var(--space-5); }
    .stat {
      border: 1px solid var(--color-border); background: rgba(255,255,255,0.03);
      border-radius: 999px; padding: 0.35rem 0.75rem; font-size: 0.82rem; color: var(--color-text-muted);
    }
    .stat strong { color: var(--color-text-light); font-weight: 600; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
    .card {
      display: flex; flex-direction: column; gap: 0.65rem;
      background: var(--color-card-bg); border: 1px solid var(--color-border);
      border-radius: var(--radius-lg); padding: 1.15rem 1.2rem;
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
      min-height: 11rem;
    }
    .card:hover {
      background: var(--color-card-bg-hover);
      border-color: rgba(0, 229, 255, 0.35);
      transform: translateY(-2px);
    }
    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
    .card-title {
      font-family: var(--font-heading); font-size: 1.15rem; color: var(--color-text-light);
      line-height: 1.25;
    }
    .pill {
      flex-shrink: 0; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.03em;
      text-transform: uppercase; color: var(--color-primary-end);
      border: 1px solid rgba(0, 229, 255, 0.35); border-radius: 999px;
      padding: 0.2rem 0.5rem;
    }
    .card-desc { color: var(--color-text-muted); font-size: 0.95rem; flex: 1; }
    .card-meta { font-size: 0.8rem; }
    .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: auto; }
    .tag {
      font-size: 0.72rem; color: rgba(229,229,229,0.85);
      background: rgba(138, 43, 226, 0.15); border: 1px solid rgba(138, 43, 226, 0.3);
      border-radius: 999px; padding: 0.15rem 0.55rem;
    }
    .empty {
      grid-column: 1 / -1; padding: 2rem; text-align: center;
      border: 1px dashed var(--color-border); border-radius: var(--radius-lg);
      color: var(--color-text-muted);
    }
    .site-footer {
      border-top: 1px solid var(--color-border);
      padding: 1.25rem; text-align: center; color: var(--color-text-muted); font-size: 0.85rem;
    }
    .site-footer a { color: var(--color-primary-end); }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="https://theserverless.dev" rel="noopener">
        <span class="brand-mark" aria-hidden="true"></span>
        TheServerless.Dev <span class="dim">/ demos</span>
      </a>
      <nav class="nav" aria-label="Primary">
        <a href="https://theserverless.dev">Home</a>
        <a href="https://theserverless.dev/guides">Guides</a>
        <a href="https://theserverless.dev/calculators">Calculators</a>
        <a class="btn" href="https://theserverless.dev/consulting">Consulting</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="hero">
      <div class="eyebrow">Weekday playground</div>
      <h1>Tech <span class="grad">Demos</span></h1>
      <p class="lede">
        One new library or pattern at a time, running as isolated Dynamic Workers on Cloudflare Workers Paid —
        scouted, approved, then shipped into this hub.
      </p>
      <div class="stats">
        <div class="stat"><strong>${demos.length}</strong> live demo${demos.length === 1 ? "" : "s"}</div>
        <div class="stat">Hosted on <strong>${HUB_HOST}</strong></div>
        <div class="stat">Runtime: <strong>Dynamic Workers</strong></div>
      </div>
    </section>
    <section class="grid" aria-label="Demos">
      ${cards || empty}
    </section>
  </main>
  <footer class="site-footer">
    Part of <a href="https://theserverless.dev">TheServerless.Dev</a> ·
    <a href="/api/demos">JSON API</a>
  </footer>
</body>
</html>`;
}
