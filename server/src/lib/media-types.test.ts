import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, extensionOf } from './media-types.js';

describe('extensionOf', () => {
  it('reads the extension', () => {
    assert.equal(extensionOf('IMG_1234.HEIC'), 'heic');
    assert.equal(extensionOf('holiday.JPG'), 'jpg');
  });

  it('ignores a query or fragment on a content:// URI', () => {
    assert.equal(extensionOf('IMG_1234.HEIC?width=100&height=100'), 'heic');
    assert.equal(extensionOf('file:///DCIM/IMG_1.heic#frag'), 'heic');
  });

  it('uses the last dot, not the first', () => {
    assert.equal(extensionOf('my.holiday.photo.jpg'), 'jpg');
  });

  it('is empty when there is no extension', () => {
    assert.equal(extensionOf('upload'), '');
    assert.equal(extensionOf(''), '');
  });

  it('does not mistake a dot in a directory for an extension', () => {
    assert.equal(extensionOf('/var/my.photos/upload'), '');
    assert.equal(extensionOf('C:\\my.photos\\upload'), '');
  });

  it('does not treat a dotfile as an extension', () => {
    assert.equal(extensionOf('/tmp/.hidden'), '');
  });
});

describe('classify', () => {
  /**
   * The regression this whole module exists for. The backup app sent
   * `image/jpeg` for every photo; an iPhone HEIC was stored as a JPEG, and the
   * web viewer then handed the browser HEIC bytes it believed were a JPEG.
   */
  it('believes the extension over a client that claims everything is a JPEG', () => {
    assert.deepEqual(classify('image/jpeg', 'IMG_1234.HEIC'), {
      type: 'image',
      mime: 'image/heic',
    });
    assert.deepEqual(classify('image/jpeg', 'DSC00891.ARW'), {
      type: 'image',
      mime: 'image/x-sony-arw',
    });
  });

  it('believes the extension over a client that claims every video is mp4', () => {
    assert.deepEqual(classify('video/mp4', 'IMG_5678.MOV'), {
      type: 'video',
      mime: 'video/quicktime',
    });
  });

  it('falls back to the header when the extension means nothing', () => {
    assert.deepEqual(classify('image/png', 'upload'), { type: 'image', mime: 'image/png' });
    assert.deepEqual(classify('video/webm', 'clip'), { type: 'video', mime: 'video/webm' });
  });

  it('handles octet-stream from phones that send no useful type', () => {
    assert.deepEqual(classify('application/octet-stream', 'PXL_0001.jpg'), {
      type: 'image',
      mime: 'image/jpeg',
    });
  });

  it('is case-insensitive about the extension', () => {
    assert.deepEqual(classify('', 'a.JpEg'), { type: 'image', mime: 'image/jpeg' });
  });

  it('never invents a type for RAW', () => {
    // "image/arw" is not a registered type; browsers refuse to render it and a
    // downloaded original opens in the wrong application.
    for (const name of ['a.arw', 'a.cr3', 'a.nef', 'a.dng', 'a.rw2']) {
      const { mime } = classify('', name);
      assert.match(mime, /^image\/x-/, `${name} produced ${mime}`);
    }
  });

  it('rejects a file it can identify by neither route', () => {
    assert.throws(() => classify('application/pdf', 'contract.pdf'), /Unsupported file type/);
    assert.throws(() => classify('', 'upload'), /Unsupported file type/);
  });

  it('reports the type consistently with the mime', () => {
    // `type` drives which derivative pipeline runs; a video filed as an image
    // never gets a poster frame.
    for (const [name, expected] of [
      ['a.mp4', 'video'],
      ['a.mkv', 'video'],
      ['a.3gp', 'video'],
      ['a.heic', 'image'],
      ['a.tiff', 'image'],
    ] as const) {
      const { type, mime } = classify('', name);
      assert.equal(type, expected);
      assert.ok(mime.startsWith(`${expected}/`), `${name}: ${type} vs ${mime}`);
    }
  });
});
