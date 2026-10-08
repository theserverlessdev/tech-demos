// Local-only. The values are Cloudflare's published always-pass Turnstile test pair
// and the documented loopback admin token. Do not copy this file to a deploy.
const path = ".dev.vars";
const file = Bun.file(path);
if (await file.exists()) {
  console.log(".dev.vars already present");
} else {
  await Bun.write(
    path,
    [
      "TURNSTILE_SECRET=1x0000000000000000000000000000000AA",
      "TURNSTILE_SITE_KEY=1x00000000000000000000AA",
      "ADMIN_TOKEN=dev-feedlog-admin",
      "",
    ].join("\n"),
  );
  console.log("Wrote .dev.vars for local Turnstile and admin checks.");
}
