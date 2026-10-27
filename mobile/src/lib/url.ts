// Kept free of React Native imports so it runs under plain Node in tests.

/** Normalises what people type: adds a scheme, strips a trailing slash. */
export function normaliseServerUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}
