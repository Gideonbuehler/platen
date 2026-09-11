/**
 * Converts an EXIF capture time to a real UTC instant.
 *
 * EXIF `DateTimeOriginal` is bare wall-clock text with no zone — "2026:07:14
 * 18:32:11" means "the camera's clock read 18:32". exifr revives that using the
 * *server's* timezone, so an identical photo imported on a UTC NAS and on a
 * laptop in New York would land four hours apart, and an evening shot could
 * slide into the next day's timeline section.
 *
 * So we take the wall-clock components back out and re-anchor them:
 *  - with a known offset (OffsetTimeOriginal, newer phones): subtract it to get
 *    the true instant, and keep the offset so clients can show local time;
 *  - without one: store the wall clock as UTC and record no offset. Clients
 *    render offset-less assets in UTC, which shows exactly what the camera said.
 *
 * Either way the time on screen matches the time on the camera.
 */
export function exifDateToUtc(value: unknown, offset: string | null): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;

  const wallClockMs = Date.UTC(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds(),
  );

  if (!offset) return new Date(wallClockMs);

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!match) return new Date(wallClockMs);

  const sign = match[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(wallClockMs - offsetMinutes * 60_000);
}
