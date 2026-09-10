export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      demo: "template",
      path: url.pathname,
      tip: "Replace this template with your demo.",
    });
  },
};
