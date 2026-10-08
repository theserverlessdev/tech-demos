export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status, headers: { "cache-control": "no-store" } },
    );
  }
  console.error(JSON.stringify({ event: "api_error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return Response.json(
    { error: { code: "internal", message: "The server failed. Try again." } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}
