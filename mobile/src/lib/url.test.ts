import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normaliseServerUrl } from './url';

describe('normaliseServerUrl', () => {
  it('adds http:// when people type a bare host', () => {
    assert.equal(normaliseServerUrl('tower.local:2283'), 'http://tower.local:2283');
  });

  it('keeps a scheme that was typed, in any case', () => {
    assert.equal(normaliseServerUrl('https://photos.example.com'), 'https://photos.example.com');
    assert.equal(normaliseServerUrl('HTTP://10.0.0.5:2283'), 'HTTP://10.0.0.5:2283');
  });

  it('trims whitespace and trailing slashes', () => {
    assert.equal(normaliseServerUrl('  tower.local:2283//  '), 'http://tower.local:2283');
  });

  it('leaves empty input empty rather than inventing a URL', () => {
    assert.equal(normaliseServerUrl('   '), '');
  });
});
