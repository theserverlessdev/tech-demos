export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class PermanentInboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentInboundError";
  }
}
