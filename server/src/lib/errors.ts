/** Errors that are safe to render to a client, with an HTTP status attached. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Authentication required') =>
  new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have access to this resource') =>
  new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const payloadTooLarge = (msg: string) => new HttpError(413, 'payload_too_large', msg);
export const quotaExceeded = (msg: string) => new HttpError(507, 'quota_exceeded', msg);
