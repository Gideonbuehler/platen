import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { bearer, registerFirstUser, setup, uniqueBytes, upload, type Harness } from '../helpers.js';

let h: Harness;
let accessToken: string;
let refreshToken: string;

before(async () => {
  h = await setup();
  const admin = await registerFirstUser(h.app);
  accessToken = admin.accessToken;
  refreshToken = admin.refreshToken;
});

after(async () => {
  await h.close();
});

const login = (password: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
  h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password },
    headers,
    remoteAddress,
  });

describe('login throttling', () => {
  it('stops a client guessing passwords, however it fills in X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const response = await login(`wrong-guess-${i}`, { 'x-forwarded-for': `198.51.100.${i}` }, '203.0.113.20');
      statuses.push(response.statusCode);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429, statuses.join(','));
  });

  it('believes X-Forwarded-For from a reverse proxy on the LAN', async () => {
    const proxy = '192.168.1.50';
    for (let i = 0; i < 12; i++) await login('wrong-guess', { 'x-forwarded-for': '198.51.100.200' }, proxy);
    // Someone else behind the same proxy has their own budget.
    const other = await login('correct-horse', { 'x-forwarded-for': '198.51.100.201' }, proxy);
    assert.equal(other.statusCode, 200, other.body);
  });
});

describe('refresh tokens', () => {
  it('can be redeemed only once, even by requests racing each other', async () => {
    const fresh = await login('correct-horse', {}, '203.0.113.30');
    const token = fresh.json().refreshToken;

    // Called directly rather than through inject, which serialises requests
    // too much for them to overlap, and with the pool's connections already
    // open: a cold pool spends the race window connecting.
    const { rotateRefreshToken } = await import('../../src/services/auth.js');
    await Promise.all(Array.from({ length: 8 }, () => h.sql`SELECT pg_sleep(0.05)`));
    const outcomes = await Promise.allSettled([0, 1, 2, 3].map(() => rotateRefreshToken(token)));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);

    const replay = await h.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: token } });
    assert.equal(replay.statusCode, 401);
  });

  it('still rotates normally', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
    assert.equal(response.statusCode, 200, response.body);
    assert.notEqual(response.json().refreshToken, refreshToken);
  });
});

describe('access tokens in the query string', () => {
  it('are accepted on media routes, which <img> loads', async () => {
    const id = (await upload(h.app, accessToken, uniqueBytes())).asset.id;
    const response = await h.app.inject({ method: 'GET', url: `/api/assets/${id}/original?token=${accessToken}` });
    assert.equal(response.statusCode, 200, response.body);
  });

  it('are refused everywhere else', async () => {
    for (const url of ['/api/auth/me', '/api/assets', '/api/auth/sessions', '/api/server/users']) {
      const response = await h.app.inject({ method: 'GET', url: `${url}?token=${accessToken}` });
      assert.equal(response.statusCode, 401, url);
    }
  });

  it('never reach the logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({ logger: { stream } });

    const id = (await upload(h.app, accessToken, uniqueBytes())).asset.id;
    await app.inject({ method: 'GET', url: `/api/assets/${id}/thumbnail?token=${accessToken}&v=1` });
    await app.close();

    const log = lines.join('');
    assert.ok(log.includes('[redacted]'), log);
    assert.ok(!log.includes(accessToken), 'access token written to the log');
  });
});

describe('security headers', () => {
  it('send a Content-Security-Policy that still works over plain HTTP', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/server/info' });
    const csp = String(response.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  });
});

describe('the bearer header', () => {
  it('still works on every route', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(accessToken) });
    assert.equal(response.statusCode, 200);
  });
});
