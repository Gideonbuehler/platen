import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseRange } from './send-file.js';

describe('parseRange', () => {
  it('serves the whole file when no range is asked for', () => {
    assert.equal(parseRange(undefined, 1000), null);
  });

  it('reads an explicit range', () => {
    assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  });

  it('reads an open-ended range to the end of the file', () => {
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  });

  it('reads a suffix range as the last N bytes', () => {
    // Safari asks for the tail of an MP4 this way to find the moov atom.
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  });

  it('clamps an end past the file', () => {
    assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 });
  });

  it('refuses a start past the file', () => {
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  });

  it('ignores a range that names no bytes', () => {
    assert.equal(parseRange('bytes=-', 1000), null);
  });

  it('falls back to the whole file for forms it does not serve', () => {
    assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
    assert.equal(parseRange('items=0-1', 1000), null);
  });
});
