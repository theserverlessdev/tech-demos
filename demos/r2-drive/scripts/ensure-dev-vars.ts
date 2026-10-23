// Local-only. Writes Cloudflare's published Turnstile test pair and obvious key placeholders.
const path = ".dev.vars";
const file = Bun.file(path);
if (await file.exists()) {
  console.log(".dev.vars already present");
} else {
  const example = await Bun.file(".dev.vars.example").text();
  await Bun.write(path, example.replace(/^#.*\n/gm, ""));
  console.log("Wrote .dev.vars for local checks.");
}
