import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { guessMimeType } from './mime';

describe('guessMimeType', () => {
  it('labels an iPhone HEIC as HEIC, not JPEG', () => {
    assert.equal(guessMimeType('IMG_1234.HEIC', false), 'image/heic');
  });

  it('ignores case in the extension', () => {
    assert.equal(guessMimeType('clip.MOV', true), 'video/quicktime');
    assert.equal(guessMimeType('photo.JpEg', false), 'image/jpeg');
  });

  it('reads the extension before any query or fragment on the URI', () => {
    assert.equal(guessMimeType('content://media/IMG_1.HEIC?width=100', false), 'image/heic');
    assert.equal(guessMimeType('file:///DCIM/VID_2.mp4#t=3', true), 'video/mp4');
  });

  it('knows camera RAW', () => {
    assert.equal(guessMimeType('DSC_0001.dng', false), 'image/x-adobe-dng');
  });

  it('falls back by media type when there is no usable extension', () => {
    assert.equal(guessMimeType('ph://ABCD-1234', false), 'image/jpeg');
    assert.equal(guessMimeType('ph://ABCD-1234', true), 'video/mp4');
    assert.equal(guessMimeType('weird.xyz', true), 'video/mp4');
  });
});
