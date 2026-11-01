import { startNodeServer } from './node';
import { webAssets } from './web/generated/assets';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const server = await startNodeServer({
  port,
  host,
  trustProxy: process.env.TRUST_PROXY === 'true',
  publicUrl: process.env.PUBLIC_URL,
  maxEntries: process.env.MAX_SECRETS ? Number(process.env.MAX_SECRETS) : undefined,
  assets: webAssets,
});
console.warn(
  `EnvDrop self-hosted server listening on http://${host}:${port} (in-memory store, single instance)`,
);

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
