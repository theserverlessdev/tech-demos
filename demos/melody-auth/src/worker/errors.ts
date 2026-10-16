export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class OauthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

export class BodyTooLargeError extends Error {
  readonly status = 413;
  readonly code = "too_large";
  constructor() {
    super("The request body is too large.");
  }
}
