/**
 * Query parameters that carry a credential: `token` is a user's access token
 * on media URLs, `st` a share-link token.
 */
const SECRET_PARAMS = /([?&](?:token|st)=)[^&#]*/gi;

/** A URL safe to write to a log, with credentials replaced. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAMS, '$1[redacted]');
}
