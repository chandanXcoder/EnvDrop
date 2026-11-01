// Bundles the CLI (and its workspace deps) into a single dependency-free file.
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/envdrop.mjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __ENVDROP_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'info',
});
chmodSync('dist/envdrop.mjs', 0o755);
