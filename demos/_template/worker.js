export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      demo: "template",
      path: url.pathname,
      tip: "Replace this template with your demo (plain JS for Dynamic Worker LOADER).",
    });
  },
};
