const base = process.env.BASE ?? "http://127.0.0.1:8787";
const allowAiMiss = process.argv.includes("--allow-ai-miss");

function check(ok: boolean, message: string, detail?: unknown): void {
  if (!ok) {
    console.error("FAIL", message, detail ?? "");
    process.exitCode = 1;
    return;
  }
  console.log("ok", message);
}

const healthRes = await fetch(`${base}/api/health`);
const health = (await healthRes.json()) as { ok?: boolean; ai?: string };
check(healthRes.status === 200 && health.ok === true && (health.ai === "stub" || health.ai === "binding"), "health answers", health);

const denied = await fetch(`${base}/api/judge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    questions: [{ instructions: "Can this expense receipt be read well enough to file?", options: ["Readable — merchant, date, and total are clear", "Too blurry to read", "Not a receipt"] }],
  }),
});
const deniedBody = (await denied.json()) as { error?: { code?: string } };
check(denied.status === 400 && deniedBody.error?.code === "turnstile_required", "judge without Turnstile is rejected", deniedBody);

const judged = await fetch(`${base}/api/judge`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "__Host-oj_vid=" + "ab".repeat(16) },
  body: JSON.stringify({
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    sampleId: "receipt-legible",
    compare: true,
    questions: [{ instructions: "Can this expense receipt be read well enough to file?", options: ["Readable — merchant, date, and total are clear", "Too blurry to read", "Not a receipt"] }],
  }),
});
const judgedBody = (await judged.json()) as {
  judgment?: { source?: string; result?: { source?: string; answers?: { topLabel?: string }[] }; label?: string };
  comparison?: { result?: { source?: string; untrustedText?: string } };
};
const judgedSource = judgedBody.judgment?.result?.source;
if (judged.status === 502) {
  if (!allowAiMiss) {
    check(false, "judge returned 502; Workers AI did not answer. Pass --allow-ai-miss only when that miss is expected.", judgedBody);
  } else {
    console.log("skip live judge; Workers AI did not answer");
  }
} else {
  const judgedOk = judged.status === 201 && (judgedSource === "clef-omni" || judgedSource === "local-stub");
  check(judgedOk, "sample judgment returned", judgedBody);
  check((judgedBody.judgment?.result?.answers?.length ?? 0) === 1, "one answer came back", judgedBody.judgment?.result?.answers);
  if (judgedSource === "local-stub") {
    check(judgedBody.comparison?.result?.source === "chain-stub", "comparison is the labelled chain stub", judgedBody.comparison);
  }
}

const setCookie = judged.headers.get("set-cookie") ?? "";
const media = await fetch(`${base}/api/judgments`, { headers: { cookie: setCookie.split(";")[0] || "__Host-oj_vid=" + "ab".repeat(16) } });
const list = (await media.json()) as { judgments?: unknown[] };
check(media.status === 200 && (list.judgments?.length ?? 0) >= 1, "history lists the judgment", list);

if (process.exitCode) process.exit(process.exitCode);

console.log("smoke passed");
