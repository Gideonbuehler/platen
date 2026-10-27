import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { redactUrl } from './redact.js';

describe('redactUrl', () => {
  it('hides an access token on a media URL', () => {
    assert.equal(
      redactUrl('/api/assets/abc/thumbnail?token=eyJhbGci.payload.sig&v=2026'),
      '/api/assets/abc/thumbnail?token=[redacted]&v=2026',
    );
  });

  it('hides a share token wherever it sits in the query', () => {
    assert.equal(
      redactUrl('/api/public/key/asset/id/preview?v=1&st=secret'),
      '/api/public/key/asset/id/preview?v=1&st=[redacted]',
    );
  });

  it('leaves parameters that merely end in the same letters alone', () => {
    assert.equal(redactUrl('/api/search/metadata?q=first&pagetoken=1'), '/api/search/metadata?q=first&pagetoken=1');
  });

  it('leaves URLs without a query untouched', () => {
    assert.equal(redactUrl('/api/server/health'), '/api/server/health');
  });
});
