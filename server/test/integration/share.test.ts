import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bearer, createUser, registerFirstUser, setup, uniqueBytes, upload, type Harness } from '../helpers.js';

let h: Harness;
let ownerToken: string;
let ownerId: string;
let editorToken: string;
let editorId: string;

/** The worker does not run in tests, so derivatives are written by hand. */
async function fakeThumb(userId: string, assetId: string): Promise<void> {
  const dir = join(h.thumbsPath, userId, assetId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'thumb.webp'), `thumb of ${assetId}`);
  await writeFile(join(dir, 'preview.webp'), `preview of ${assetId}`);
}

async function albumWith(assetIds: string[]): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/albums',
    headers: bearer(ownerToken),
    payload: { name: 'Holiday', assetIds },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}

async function shareLink(body: Record<string, unknown>): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/shares',
    headers: bearer(ownerToken),
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().key;
}

before(async () => {
  h = await setup();
  const owner = await registerFirstUser(h.app);
  ownerToken = owner.accessToken;
  ownerId = owner.user.id;
  const editor = await createUser(h.app, ownerToken, 'editor@example.com');
  editorToken = editor.accessToken;
  editorId = editor.user.id;
});

after(async () => {
  await h.close();
});

describe('password-protected share links', () => {
  let key: string;
  let assetId: string;

  before(async () => {
    assetId = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    await fakeThumb(ownerId, assetId);
    key = await shareLink({ albumId: await albumWith([assetId]), password: 'open sesame' });
  });

  it('hands out a share token once the password is right', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/public/${key}`,
      headers: { 'x-share-password': 'open sesame' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.assets.length, 1);
    assert.equal(typeof body.token, 'string');
  });

  it('serves images to an <img> that carries the token in its URL', async () => {
    const { token } = (
      await h.app.inject({
        method: 'GET',
        url: `/api/public/${key}`,
        headers: { 'x-share-password': 'open sesame' },
      })
    ).json();

    for (const kind of ['thumbnail', 'preview', 'original']) {
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/public/${key}/asset/${assetId}/${kind}?st=${token}`,
      });
      assert.equal(response.statusCode, 200, `${kind}: ${response.body}`);
      // A password-protected photo must not sit in a shared proxy cache.
      assert.match(String(response.headers['cache-control']), /private/, kind);
    }
  });

  it('refuses images without a token', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/public/${key}/asset/${assetId}/thumbnail`,
    });
    assert.equal(response.statusCode, 401);
  });

  it('rejects a forged or foreign token', async () => {
    const otherAsset = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    const otherKey = await shareLink({ assetId: otherAsset, password: 'another one' });
    const { token: otherToken } = (
      await h.app.inject({
        method: 'GET',
        url: `/api/public/${otherKey}`,
        headers: { 'x-share-password': 'another one' },
      })
    ).json();

    for (const st of ['not-a-token', otherToken]) {
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/public/${key}/asset/${assetId}/thumbnail?st=${st}`,
      });
      assert.equal(response.statusCode, 401, `st=${st}`);
    }
  });

  it('does not accept a share token as a login', async () => {
    const { token } = (
      await h.app.inject({
        method: 'GET',
        url: `/api/public/${key}`,
        headers: { 'x-share-password': 'open sesame' },
      })
    ).json();
    const response = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
    assert.equal(response.statusCode, 401);
  });

  it('stops answering password guesses after a handful', async () => {
    const guessKey = await shareLink({ assetId, password: 'unguessable' });
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/public/${guessKey}`,
        headers: { 'x-share-password': `guess ${i}`, 'x-forwarded-for': `198.51.100.${i}` },
        // A client that rotates X-Forwarded-For must not get a fresh budget.
        remoteAddress: '203.0.113.7',
      });
      statuses.push(response.statusCode);
    }
    assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}`);
  });
});

describe('open share links', () => {
  it('serve images with no token and allow public caching', async () => {
    const assetId = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    await fakeThumb(ownerId, assetId);
    const key = await shareLink({ assetId });

    const contents = await h.app.inject({ method: 'GET', url: `/api/public/${key}` });
    assert.equal(contents.statusCode, 200);
    assert.equal(contents.json().token, null);

    const response = await h.app.inject({ method: 'GET', url: `/api/public/${key}/asset/${assetId}/thumbnail` });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['cache-control']), /public/);
  });

  it('answer only for photos that are actually in the share', async () => {
    const shared = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    const notShared = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    await fakeThumb(ownerId, notShared);
    const key = await shareLink({ albumId: await albumWith([shared]) });

    const response = await h.app.inject({ method: 'GET', url: `/api/public/${key}/asset/${notShared}/thumbnail` });
    assert.equal(response.statusCode, 404);
  });
});

describe('public album links', () => {
  it('expose only the album owner’s photos, not those a collaborator added', async () => {
    const ownerAsset = (await upload(h.app, ownerToken, uniqueBytes())).asset.id;
    const albumId = await albumWith([ownerAsset]);

    const invite = await h.app.inject({
      method: 'POST',
      url: `/api/albums/${albumId}/share`,
      headers: bearer(ownerToken),
      payload: { email: 'editor@example.com', canEdit: true },
    });
    assert.equal(invite.statusCode, 200, invite.body);

    const editorAsset = (await upload(h.app, editorToken, uniqueBytes())).asset.id;
    await fakeThumb(editorId, editorAsset);
    const added = await h.app.inject({
      method: 'POST',
      url: `/api/albums/${albumId}/assets`,
      headers: bearer(editorToken),
      payload: { assetIds: [editorAsset] },
    });
    assert.equal(added.json().added, 1);

    const key = await shareLink({ albumId });
    const contents = (await h.app.inject({ method: 'GET', url: `/api/public/${key}` })).json();
    assert.deepEqual(
      contents.assets.map((a: { id: string }) => a.id),
      [ownerAsset],
    );

    const direct = await h.app.inject({
      method: 'GET',
      url: `/api/public/${key}/asset/${editorAsset}/thumbnail`,
    });
    assert.equal(direct.statusCode, 404);
  });
});
