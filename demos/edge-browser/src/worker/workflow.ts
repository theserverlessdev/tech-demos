import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { simplePdf, stripedPng } from "../shared/files";
import { LIMITS, type StepName } from "../shared/limits";
import type { CaptureParams } from "../shared/types";
import { captureArtifact, type ArtifactKind } from "./browse";
import { markComplete, markError, markStep, objectKey } from "./db";
import { PermanentError } from "./errors";
import { authorizeNavigation, cloudflareDoh } from "./ssrf";
import { summarize } from "./summary";

const BROWSER_STEPS: { name: StepName; kind: ArtifactKind }[] = [
  { name: "Desktop screenshot", kind: "desktop" },
  { name: "Phone screenshot", kind: "phone" },
  { name: "PDF", kind: "pdf" },
  { name: "Markdown", kind: "markdown" },
];

function pool(env: Env) {
  return env.BROWSER_SESSION.get(env.BROWSER_SESSION.idFromName("pool"));
}

export class CaptureWorkflow extends WorkflowEntrypoint<Env, CaptureParams> {
  async run(event: WorkflowEvent<CaptureParams>, step: WorkflowStep): Promise<{ status: string }> {
    const { captureId, url, visitorId } = event.payload;

    const checked = await step.do("check url", { timeout: "20 seconds", retries: { limit: 0, delay: "1 second" } }, async () => {
      await markStep(this.env, captureId, "Check the URL", "running", { captureStatus: "running" });
      let decision;
      try {
        decision = await authorizeNavigation(url, cloudflareDoh);
      } catch (err) {
        const message = err instanceof Error ? err.message : "The URL could not be checked.";
        await markError(this.env, captureId, "Check the URL", message);
        throw new NonRetryableError(message);
      }
      if (!decision.ok) {
        await markError(this.env, captureId, "Check the URL", decision.message);
        throw new NonRetryableError(decision.message);
      }
      await markStep(this.env, captureId, "Check the URL", "done", { finalUrl: decision.url });
      return { url: decision.url };
    });

    for (const item of BROWSER_STEPS) {
      await step.do(
        item.name,
        { timeout: "50 seconds", retries: { limit: 1, delay: "2 seconds", backoff: "constant" } },
        async () => {
          await markStep(this.env, captureId, item.name, "running");
          const plan = await pool(this.env).acquire(visitorId);
          if (!plan.ok) {
            await markError(this.env, captureId, item.name, plan.message);
            throw new NonRetryableError(plan.message);
          }
          try {
            const produced = plan.action === "stub"
              ? await writeStub(this.env, captureId, checked.url, item.kind, plan.note)
              : await captureArtifact(this.env, plan, captureId, checked.url, item.kind);
            await markStep(this.env, captureId, item.name, "done", {
              finalUrl: produced.finalUrl,
              title: produced.title,
              browserMode: produced.mode,
              sessionId: produced.sessionId,
              sessionNote: produced.note,
            });
            return { mode: produced.mode };
          } catch (err) {
            if (err instanceof NonRetryableError) throw err;
            const message = err instanceof Error ? err.message : "The browser step failed.";
            if (err instanceof PermanentError) {
              await markError(this.env, captureId, item.name, message);
              throw new NonRetryableError(message);
            }
            throw err;
          }
        },
      );
    }

    await step.do("summary", { timeout: "30 seconds", retries: { limit: 1, delay: "2 seconds", backoff: "constant" } }, async () => {
      await markStep(this.env, captureId, "Summary", "running");
      const object = await this.env.BUCKET.get(objectKey(captureId, "page.md"));
      const markdown = object ? await object.text() : "";
      const result = await summarize(this.env, markdown);
      await this.env.BUCKET.put(objectKey(captureId, "summary.txt"), result.text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      await markStep(this.env, captureId, "Summary", "done", { summarySource: result.source });
      await markComplete(this.env, captureId);
      return { source: result.source };
    });

    return { status: "complete" };
  }
}

async function writeStub(env: Env, captureId: string, url: string, kind: ArtifactKind, note: string): Promise<{ mode: "stub"; sessionId: string; note: string; finalUrl: string; title: string }> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const title = new URL(url).hostname;
  if (kind === "desktop" || kind === "phone") {
    const width = kind === "phone" ? 390 : 640;
    const png = await stripedPng(width, 1400);
    await env.BUCKET.put(objectKey(captureId, kind === "phone" ? "phone.png" : "desktop.png"), png, {
      httpMetadata: { contentType: "image/png" },
    });
  } else if (kind === "pdf") {
    await env.BUCKET.put(objectKey(captureId, "page.pdf"), simplePdf(`Edge browser local stand-in for ${title}`), {
      httpMetadata: { contentType: "application/pdf" },
    });
  } else {
    const markdown = [
      `# ${title}`,
      "",
      "Local stand-in. Browser Rendering needs a Cloudflare login, so Chrome did not open this URL.",
      "",
      `Requested: ${url}`,
      "",
      "The live Worker uses `@cloudflare/puppeteer` with the Browser Rendering binding. A warm session is reused with `puppeteer.connect` until its limits, then `puppeteer.launch` starts another browser with `keep_alive`.",
      "",
      `- Desktop screenshot width: ${LIMITS.desktopWidth}px`,
      `- Phone screenshot width: ${LIMITS.phoneWidth}px`,
      "",
    ].join("\n");
    await env.BUCKET.put(objectKey(captureId, "page.md"), markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  }
  return { mode: "stub", sessionId: "", note, finalUrl: url, title };
}
