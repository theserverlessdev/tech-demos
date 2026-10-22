const base = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");

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
check(healthRes.status === 200 && health.ok === true && health.ai === "mock", "health is the labelled mock", health);

const denied = await fetch(`${base}/api/extract`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ state: "Invoice INV-1", fields: { invoice_number: { type: "text" } } }),
});
const deniedBody = (await denied.json()) as { error?: { code?: string } };
check(denied.status === 400 && deniedBody.error?.code === "turnstile_required", "extract without Turnstile is rejected", deniedBody);

const extracted = await fetch(`${base}/api/extract`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    compare: true,
    state: "Invoice INV-2291 from Northwind Supply, issued 2026-09-02, net 30. 4 pallets at $250.00 each, shipping $80.00. Contact: Dana Ruiz, Priya Shah.",
    fields: {
      invoice_number: { type: "text" },
      total: { type: "number", decimals: 2, unit: "USD", instructions: "Amount due including shipping" },
      po_number: { type: "text", instructions: "Purchase order number" },
    },
  }),
});
const body = (await extracted.json()) as {
  source?: string;
  answers?: { invoice_number?: { value?: string }; po_number?: { value?: unknown } };
  comparison?: { schemaValid?: boolean; source?: string };
};
check(extracted.status === 200 && body.source === "mock", "mock extraction returned", body);
check(body.answers?.invoice_number?.value === "INV-2291", "invoice number extracted", body.answers);
check(body.answers?.po_number?.value === null, "missing PO is null", body.answers?.po_number);
check(body.comparison?.source === "mock" && body.comparison.schemaValid === false, "comparison is schema-invalid", body.comparison);

const remote = await fetch(`${base}/api/extract`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    state: "see attached",
    fields: { vendor: { type: "text" } },
    image: "https://example.com/receipt.png",
  }),
});
const remoteBody = (await remote.json()) as { error?: { code?: string } };
check(remote.status === 400 && remoteBody.error?.code === "bad_image", "remote image URL is rejected", remoteBody);

const page = await fetch(`${base}/`);
const html = await page.text();
check(page.status === 200 && html.includes("What this proves") && html.includes("honest nulls"), "page explains the demo");

const batched = await fetch(`${base}/api/batch`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: extracted.headers.get("set-cookie")?.split(";")[0] ?? "" },
  body: JSON.stringify({ turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }),
});
const batchBody = (await batched.json()) as { ids?: string[] };
check(batched.status === 202 && (batchBody.ids?.length ?? 0) === 12, "batch queued 12 docs", batchBody);

const cookie = batched.headers.get("set-cookie") ?? extracted.headers.get("set-cookie") ?? "";
const review = await fetch(`${base}/api/review`, { headers: { cookie: cookie.split(";")[0] } });
const reviewBody = (await review.json()) as { items?: { status?: string; id?: string }[] };
check(review.status === 200 && (reviewBody.items?.length ?? 0) === 12, "review queue lists 12", reviewBody.items?.length);
check(reviewBody.items?.every((item) => item.status === "review") === true, "rows are ready for review", reviewBody.items?.[0]);

const first = reviewBody.items?.[0];
if (first?.id) {
  const accepted = await fetch(`${base}/api/review/${first.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookie.split(";")[0] },
    body: JSON.stringify({ action: "accept" }),
  });
  const acceptedBody = (await accepted.json()) as { item?: { status?: string } };
  check(accepted.status === 200 && acceptedBody.item?.status === "accepted", "accept marks the row", acceptedBody);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("smoke passed");
