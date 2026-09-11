import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exifDateToUtc } from './exif-time.js';

/**
 * EXIF `DateTimeOriginal` is bare wall-clock text — "2026:07:14 18:32:11" means
 * "the camera's clock read 18:32", with no zone attached. exifr revives that
 * using the *server's* timezone, so the same photo imported on a UTC NAS and on
 * a laptop in New York landed four hours apart, and an evening shot could slide
 * into the next day's timeline section.
 *
 * These construct the Date the same way exifr does — local-time components —
 * so they exercise the re-anchoring rather than a convenient UTC shortcut.
 */
function asExifr(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  return new Date(y, mo - 1, d, h, mi, s);
}

describe('exifDateToUtc', () => {
  it('keeps the wall clock when the file records no offset', () => {
    const result = exifDateToUtc(asExifr(2026, 7, 14, 18, 32, 11), null);
    assert.ok(result);
    assert.equal(result.toISOString(), '2026-07-14T18:32:11.000Z');
  });

  it('subtracts a positive offset to reach the true instant', () => {
    // 18:32 in +02:00 is 16:32 UTC.
    const result = exifDateToUtc(asExifr(2026, 7, 14, 18, 32, 11), '+02:00');
    assert.ok(result);
    assert.equal(result.toISOString(), '2026-07-14T16:32:11.000Z');
  });

  it('adds a negative offset to reach the true instant', () => {
    // 18:32 in -05:00 is 23:32 UTC.
    const result = exifDateToUtc(asExifr(2026, 7, 14, 18, 32, 11), '-05:00');
    assert.ok(result);
    assert.equal(result.toISOString(), '2026-07-14T23:32:11.000Z');
  });

  it('accepts an offset written without a colon', () => {
    const result = exifDateToUtc(asExifr(2026, 7, 14, 18, 32, 11), '+0530');
    assert.ok(result);
    assert.equal(result.toISOString(), '2026-07-14T13:02:11.000Z');
  });

  it('does not let an evening shot slide into the next day', () => {
    // The original symptom: a 23:50 photo read back as the following morning.
    const result = exifDateToUtc(asExifr(2026, 7, 14, 23, 50, 0), null);
    assert.ok(result);
    assert.equal(result.getUTCDate(), 14);
    assert.equal(result.getUTCHours(), 23);
  });

  it('treats an unparseable offset as no offset rather than throwing', () => {
    const result = exifDateToUtc(asExifr(2026, 7, 14, 18, 32, 11), 'Z');
    assert.ok(result);
    assert.equal(result.toISOString(), '2026-07-14T18:32:11.000Z');
  });

  it('returns null for anything that is not a usable date', () => {
    assert.equal(exifDateToUtc(undefined, null), null);
    assert.equal(exifDateToUtc('2026:07:14 18:32:11', null), null);
    assert.equal(exifDateToUtc(new Date('nonsense'), null), null);
  });
});
