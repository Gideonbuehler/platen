import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDatabase, waitForDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startWorker } from './jobs/worker.js';
import { ensureStorageDirs } from './lib/storage.js';
import { hasFfmpeg } from './services/media.js';
import { warmUp } from './services/ml.js';
import { warmUpFaces } from './services/faces.js';
import { closeCache, initCache } from './services/cache.js';

async function start(): Promise<void> {
  const app = await buildApp();

  await ensureStorageDirs();
  await waitForDatabase();
  await migrate();

  if (!(await hasFfmpeg())) {
    app.log.warn(
      'ffmpeg/ffprobe not found on PATH. Video uploads will be stored but will not get ' +
        'thumbnails or duration metadata. The official Docker image bundles ffmpeg.',
    );
  }

  await initCache((msg) => app.log.info(msg));

  const stopWorker = startWorker(app.log);
  void warmUp((msg) => app.log.info(msg));
  void warmUpFaces((msg) => app.log.info(msg));

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Platen is ready at ${config.PUBLIC_URL}`);

  // -------------------------------------------------------------------------
  // Graceful shutdown: finish in-flight jobs so we never leave a half-written
  // derivative or an orphaned temp file behind.
  // -------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down...`);

    const force = setTimeout(() => {
      app.log.error('Shutdown timed out after 30s, exiting forcefully.');
      process.exit(1);
    }, 30_000);
    force.unref();

    try {
      await app.close();
      await stopWorker();
      await closeCache();
      await closeDatabase();
      app.log.info('Goodbye.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Platen failed to start', err);
  process.exit(1);
});
