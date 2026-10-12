import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { simplePdf, stripedPng } from "../shared/files";
import { LIMITS, type StepName } from "../shared/limits";
import type { CaptureParams } from "../shared/types";
import { browserEndpoint, capturePage, type PageProfile } from "./browse";
import { getCapture, markComplete, markError, markStep, objectKey } from "./db";
import { PermanentError } from "./errors";
import { authorizeNavigation, cloudflareDoh } from "./ssrf";
import { summarize } from "./summary";

const PAGE_STEPS: { name: StepName; profile: PageProfile }[] = [
  { name: "Desktop, PDF, and markdown", profile: "desktop" },
  { name: "Phone screenshot", profile: "phone" },
];

function short(err: unknown, fallback: string): string {
  if (err instanceof PermanentError) return err.message.slice(0, 180);
  return fallback;
}

export class CaptureWorkflow extends WorkflowEntrypoint<Env, CaptureParams> {
  async run(event: WorkflowEvent<CaptureParams>, step: WorkflowStep): Promise<{ status: string }> {
    const { captureId, visitorId } = event.payload;

    await step.do("check url", { timeout: "20 seconds", retries: { limit: 0, delay: "1 second" } }, async () => {
      await markStep(this.env, captureId, "Check the URL", "running", { captureStatus: "running" });
      const row = await getCapture(this.env, captureId);
      if (!row || row.visitor_id !== visitorId) {
        const message = "The capture does not exist.";
        await markError(this.env, captureId, "Check the URL", message);
        throw new NonRetryableError(message);
      }
      let decision;
      try {
        decision = await authorizeNavigation(row.url, cloudflareDoh);
      } catch (err) {
        console.error(JSON.stringify({ event: "url_check_failed", error: String(err).slice(0, 200) }));
        const message = short(err, "The URL could not be checked.");
        await markError(this.env, captureId, "Check the URL", message);
        throw new NonRetryableError(message);
      }
      if (!decision.ok) {
        await markError(this.env, captureId, "Check the URL", decision.message);
        throw new NonRetryableError(decision.message);
      }
      await markStep(this.env, captureId, "Check the URL", "done", { finalUrl: decision.url });
      return { ok: true };
    });

    for (const item of PAGE_STEPS) {
      await step.do(
        item.name,
        { timeout: "120 seconds", retries: { limit: 1, delay: "2 seconds", backoff: "constant" } },
        async () => {
          await markStep(this.env, captureId, item.name, "running");
          const row = await getCapture(this.env, captureId);
          if (!row || row.visitor_id !== visitorId) throw new NonRetryableError("The capture does not exist.");
          const rate = await this.env.SESSION_LIMIT.limit({ key: visitorId || "anon" });
          if (!rate.success) {
            const message = "Too many browser steps from this browser. Wait a minute.";
            await markError(this.env, captureId, item.name, message);
            throw new NonRetryableError(message);
          }
          const environment: string = this.env.ENVIRONMENT;
          const stub = environment === "local";
          if (!stub && !browserEndpoint(this.env.BROWSER)) {
            const message = "Browser Rendering is not bound to this Worker.";
            await markError(this.env, captureId, item.name, message);
            throw new NonRetryableError(message);
          }
          try {
            const produced = stub
              ? await writeStub(this.env, captureId, row.url, item.profile, "Local stand-in. Browser Rendering needs a Cloudflare login, so this capture did not launch Chrome.")
              : await capturePage(this.env, captureId, row.url, item.profile);
            await markStep(this.env, captureId, item.name, "done", {
              finalUrl: produced.finalUrl,
              title: produced.title,
              browserMode: produced.mode,
              sessionId: produced.sessionId,
              sessionNote: produced.note,
              hasDesktop: item.profile === "desktop",
              hasPhone: item.profile === "phone",
              hasPdf: item.profile === "desktop",
              hasMarkdown: item.profile === "desktop",
            });
            return { mode: produced.mode };
          } catch (err) {
            if (err instanceof NonRetryableError) throw err;
            const message = short(err, "The browser step failed.");
            console.error(JSON.stringify({ event: "browser_step_failed", step: item.name, error: String(err).slice(0, 200) }));
            if (err instanceof PermanentError) {
              await markError(this.env, captureId, item.name, message);
              throw new NonRetryableError(message);
            }
            throw new Error(message);
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

async function writeStub(env: Env, captureId: string, url: string, profile: PageProfile, note: string): Promise<{ mode: "stub"; sessionId: string; note: string; finalUrl: string; title: string }> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  let title = "page";
  try {
    title = new URL(url).hostname;
  } catch {
    title = "page";
  }
  if (profile === "phone") {
    await env.BUCKET.put(objectKey(captureId, "phone.png"), await stripedPng(390, 1400), {
      httpMetadata: { contentType: "image/png" },
    });
  } else {
    await env.BUCKET.put(objectKey(captureId, "desktop.png"), await stripedPng(640, 1400), {
      httpMetadata: { contentType: "image/png" },
    });
    await env.BUCKET.put(objectKey(captureId, "page.pdf"), simplePdf(`Edge browser local stand-in for ${title}`), {
      httpMetadata: { contentType: "application/pdf" },
    });
    const markdown = [
      `# ${title}`,
      "",
      "Local stand-in. Browser Rendering needs a Cloudflare login, so Chrome did not open this URL.",
      "",
      `Requested: ${url}`,
      "",
      "The live Worker uses `@cloudflare/puppeteer` with the Browser Rendering binding. It connects to the newest session under the context cap, and otherwise launches a browser and disconnects it.",
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
