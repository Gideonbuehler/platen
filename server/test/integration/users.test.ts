import { strict as assert } from 'node:assert';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bearer, createUser, registerFirstUser, setup, uniqueBytes, upload, type Harness } from '../helpers.js';

let h: Harness;
let adminToken: string;

before(async () => {
  h = await setup();
  adminToken = (await registerFirstUser(h.app)).accessToken;
});

after(async () => {
  await h.close();
});

const exists = async (dir: string) => readdir(dir).then(() => true, () => false);

describe('deleting a user', () => {
  it('removes every file they owned, not just their rows', async () => {
    const leaving = await createUser(h.app, adminToken, 'leaving@example.com');
    const staying = await createUser(h.app, adminToken, 'staying@example.com');

    const theirs = await upload(h.app, leaving.accessToken, uniqueBytes());
    await upload(h.app, leaving.accessToken, uniqueBytes(), 'clip.jpg');
    const kept = await upload(h.app, staying.accessToken, uniqueBytes());

    // Derivatives and a face crop, as the worker would have left them.
    const thumbs = join(h.thumbsPath, leaving.user.id, theirs.asset.id);
    await mkdir(join(thumbs, 'faces'), { recursive: true });
    await writeFile(join(thumbs, 'thumb.webp'), 'thumb');
    await writeFile(join(thumbs, 'faces', 'crop.webp'), 'face');

    const response = await h.app.inject({
      method: 'DELETE',
      url: `/api/server/users/${leaving.user.id}`,
      headers: bearer(adminToken),
    });
    assert.equal(response.statusCode, 204, response.body);

    const { runJob } = await import('../../src/jobs/handlers.js');
    await runJob('file-purge', {});

    assert.equal(await exists(join(h.libraryPath, leaving.user.id)), false, 'originals left behind');
    assert.equal(await exists(join(h.thumbsPath, leaving.user.id)), false, 'derivatives left behind');

    const keptPath = (
      await h.sql<{ storage_path: string }[]>`SELECT storage_path FROM assets WHERE id = ${kept.asset.id}`
    )[0]!.storage_path;
    assert.ok(await stat(join(h.libraryPath, keptPath)), 'another user’s photo was touched');

    const pending = await h.sql`SELECT 1 FROM file_deletions`;
    assert.equal(pending.length, 0);
  });

  it('queues the purge itself, so the files go without anyone pressing a button', async () => {
    const leaving = await createUser(h.app, adminToken, 'queued@example.com');
    await upload(h.app, leaving.accessToken, uniqueBytes());

    await h.app.inject({
      method: 'DELETE',
      url: `/api/server/users/${leaving.user.id}`,
      headers: bearer(adminToken),
    });

    const jobs = await h.sql`SELECT 1 FROM jobs WHERE type = 'file-purge'`;
    assert.ok(jobs.length > 0);
  });

  it('hands a very large purge on to a follow-up job instead of running unbounded', async () => {
    await h.sql`DELETE FROM jobs WHERE type = 'file-purge'`;
    await h.sql`DELETE FROM file_deletions`;
    await h.sql`
      INSERT INTO file_deletions (owner_id, asset_id, storage_path, is_external)
      SELECT '00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'gone/' || n || '.jpg', false
      FROM generate_series(1, 5100) AS n
    `;

    const { runJob } = await import('../../src/jobs/handlers.js');
    await runJob('file-purge', {});

    const [left] = await h.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM file_deletions`;
    assert.equal(left?.count, 100);
    const followUps = await h.sql`SELECT 1 FROM jobs WHERE type = 'file-purge'`;
    assert.equal(followUps.length, 1);

    await runJob('file-purge', {});
    assert.equal((await h.sql`SELECT 1 FROM file_deletions`).length, 0);
  });
});
