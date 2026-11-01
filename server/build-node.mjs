// Bundles the self-hosted Node server (used by the Docker image) into one file.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/node-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/node/server.mjs',
  legalComments: 'none',
  logLevel: 'info',
});
