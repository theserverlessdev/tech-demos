const base = process.env.BASE ?? "http://127.0.0.1:8787";

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
check(healthRes.status === 200 && health.ok === true && health.ai === "stub", "health is a local stub", health);

const denied = await fetch(`${base}/api/judge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ questions: [{ instructions: "Is this a photo of a damaged package?", options: ["Damaged", "Intact", "Not a package"] }] }),
});
const deniedBody = (await denied.json()) as { error?: { code?: string } };
check(denied.status === 400 && deniedBody.error?.code === "turnstile_required", "judge without Turnstile is rejected", deniedBody);

const judged = await fetch(`${base}/api/judge`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "__Host-oj_vid=" + "ab".repeat(16) },
  body: JSON.stringify({
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    sampleId: "package",
    compare: true,
    questions: [{ instructions: "Is this a photo of a damaged package?", options: ["Damaged", "Intact", "Not a package"] }],
  }),
});
const judgedBody = (await judged.json()) as {
  judgment?: { source?: string; result?: { source?: string; answers?: { topLabel?: string }[] }; label?: string };
  comparison?: { result?: { source?: string; untrustedText?: string } };
};
check(judged.status === 201 && judgedBody.judgment?.result?.source === "local-stub", "sample judgment uses the labelled stub", judgedBody);
check((judgedBody.judgment?.result?.answers?.length ?? 0) === 1, "one answer came back", judgedBody.judgment?.result?.answers);
check(judgedBody.comparison?.result?.source === "chain-stub", "comparison is the labelled chain stub", judgedBody.comparison);

const setCookie = judged.headers.get("set-cookie") ?? "";
const media = await fetch(`${base}/api/judgments`, { headers: { cookie: setCookie.split(";")[0] || "__Host-oj_vid=" + "ab".repeat(16) } });
const list = (await media.json()) as { judgments?: unknown[] };
check(media.status === 200 && (list.judgments?.length ?? 0) >= 1, "history lists the judgment", list);

if (process.exitCode) process.exit(process.exitCode);
console.log("smoke passed");
