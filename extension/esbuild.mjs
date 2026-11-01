import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Ship VS Code's codicon font to the webviews (local resource, allowed by our CSP).
const require = createRequire(import.meta.url);
const codicons = dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
mkdirSync('media/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf'])
  cpSync(join(codicons, f), join('media/codicons', f));

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
