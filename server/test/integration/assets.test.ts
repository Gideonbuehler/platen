import { strict as assert } from 'node:assert';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bearer, multipartBody, registerFirstUser, setup, uniqueBytes, upload, type Harness } from '../helpers.js';

let h: Harness;
let token: string;
let userId: string;

before(async () => {
  h = await setup();
  const admin = await registerFirstUser(h.app);
  token = admin.accessToken;
  userId = admin.user.id;
});

after(async () => {
  await h.close();
});

/** Every file under a directory, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id).sort();

describe('boolean query parameters', () => {
  it('read "false" as false', async () => {
    const live = (await upload(h.app, token, uniqueBytes())).asset.id;
    const binned = (await upload(h.app, token, uniqueBytes())).asset.id;
    await h.app.inject({
      method: 'POST',
      url: '/api/assets/delete',
      headers: bearer(token),
      payload: { ids: [binned] },
    });

    const notTrashed = await h.app.inject({ method: 'GET', url: '/api/assets?trashed=false', headers: bearer(token) });
    assert.equal(notTrashed.statusCode, 200, notTrashed.body);
    assert.ok(ids(notTrashed.json()).includes(live));
    assert.ok(!ids(notTrashed.json()).includes(binned));

    const trashed = await h.app.inject({ method: 'GET', url: '/api/assets?trashed=true', headers: bearer(token) });
    assert.deepEqual(ids(trashed.json()), [binned]);
  });

  it('do not turn ?download=false into a download', async () => {
    const id = (await upload(h.app, token, uniqueBytes(), 'keep.jpg')).asset.id;
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/assets/${id}/original?download=false`,
      headers: bearer(token),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-disposition'], undefined);
  });

  it('reject values that are not booleans', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/assets?favorite=maybe', headers: bearer(token) });
    assert.equal(response.statusCode, 400);
  });
});

describe('an upload whose row cannot be written', () => {
  const send = (filename: string) => {
    const body = multipartBody({ filename, contentType: 'image/jpeg', data: uniqueBytes() });
    return h.app.inject({
      method: 'POST',
      url: '/api/assets/upload',
      headers: { ...bearer(token), ...body.headers },
      payload: body.payload,
    });
  };

  before(async () => {
    // Deterministic stand-ins for what timing makes rare: an identical upload
    // landing between the duplicate check and the insert, and an insert that
    // simply fails.
    await h.sql.unsafe(`
      CREATE FUNCTION test_upload_trouble() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.original_filename = 'race.jpg' THEN
          INSERT INTO assets (owner_id, checksum, type, original_filename, storage_path,
                              mime_type, file_size, taken_at)
          VALUES (NEW.owner_id, NEW.checksum, NEW.type, 'winner.jpg', 'elsewhere/winner.jpg',
                  NEW.mime_type, NEW.file_size, NEW.taken_at);
        ELSIF NEW.original_filename = 'broken.jpg' THEN
          RAISE EXCEPTION 'simulated failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_upload_trouble BEFORE INSERT ON assets
        FOR EACH ROW EXECUTE FUNCTION test_upload_trouble();
    `);
  });

  after(async () => {
    await h.sql.unsafe('DROP TRIGGER test_upload_trouble ON assets; DROP FUNCTION test_upload_trouble();');
  });

  it('answers "duplicate" when an identical upload won the race', async () => {
    const before = await filesUnder(join(h.libraryPath, userId));
    const response = await send('race.jpg');
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.duplicate, true);
    assert.equal(result.asset.originalFilename, 'winner.jpg');
    assert.deepEqual(await filesUnder(join(h.libraryPath, userId)), before, 'the losing copy stayed on disk');
  });

  it('leaves no original behind when the insert fails', async () => {
    const before = await filesUnder(join(h.libraryPath, userId));
    const response = await send('broken.jpg');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(await filesUnder(join(h.libraryPath, userId)), before, 'an original was left with no row');
  });
});
