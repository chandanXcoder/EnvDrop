import { parseArgs } from 'node:util';
import {
  CliError,
  checkCmd,
  type Ctx,
  DEFAULT_SERVER,
  exampleCmd,
  hookCmd,
  pullCmd,
  revokeCmd,
  scanCmd,
  shareCmd,
} from './commands';
import { LinkStore } from './linkStore';
import { banner, defaultIo, palette } from './ui';

declare const __ENVDROP_VERSION__: string;
const VERSION = typeof __ENVDROP_VERSION__ === 'string' ? __ENVDROP_VERSION__ : 'dev';

function help(c: ReturnType<typeof palette>): string {
  const cmd = (s: string) => c.violet(s);
  return `${banner(c)}

${c.bold('Usage')}
  ${cmd('envdrop share')} [file] [--expiry 10m|1h|24h] [--views 1-10] [--passphrase] [--qr] [--no-copy]
  ${cmd('envdrop pull')}  [--out .env] [--merge | --replace] [--yes]      ${c.dim('(paste the link when asked)')}
  ${cmd('envdrop revoke')} [id | --all]                                     ${c.dim('(no args: list your links)')}
  ${cmd('envdrop scan')}  [--staged | files...]                             ${c.dim('(exit 1 if secrets found)')}
  ${cmd('envdrop hook')}  install | uninstall                               ${c.dim('(git pre-commit hook)')}
  ${cmd('envdrop example')} [file]                                          ${c.dim('(write .env.example)')}
  ${cmd('envdrop check')} [file]                                            ${c.dim('(missing keys vs .env.example)')}

${c.bold('Options')}
  --server <url>   EnvDrop server (or ENVDROP_SERVER). Default: ${DEFAULT_SERVER}
  --force          share even if the file isn't gitignored (non-interactive use)
  -h, --help       show help        -v, --version   show version

${c.bold('Environment')}
  ENVDROP_SERVER, ENVDROP_PASSPHRASE (CI only), ENVDROP_IGNORE (comma-separated globs for scan), NO_COLOR

${c.dim('Keys stay in the #fragment and never reach the server. https://github.com/chandanXcoder/EnvDrop')}`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const io = defaultIo();
  const c = palette(io.color);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        expiry: { type: 'string', short: 'e' },
        views: { type: 'string', short: 'n' },
        passphrase: { type: 'boolean', short: 'p' },
        qr: { type: 'boolean' },
        'no-copy': { type: 'boolean' },
        force: { type: 'boolean', short: 'f' },
        out: { type: 'string', short: 'o' },
        merge: { type: 'boolean' },
        replace: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        all: { type: 'boolean' },
        staged: { type: 'boolean' },
        server: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    io.err(`${c.red('✖')} ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (v.version) {
    io.out(VERSION);
    return 0;
  }
  if (v.help || !command) {
    io.out(help(c));
    return command || v.help ? 0 : 1;
  }

  const ctx: Ctx = {
    io,
    c,
    cwd: process.cwd(),
    store: new LinkStore(),
    serverUrl: v.server ?? process.env.ENVDROP_SERVER ?? DEFAULT_SERVER,
  };
  try {
    switch (command) {
      case 'share':
        if (io.isTTY) io.out(banner(c) + '\n');
        return await shareCmd(ctx, {
          file: rest[0],
          expiry: v.expiry,
          views: v.views,
          passphrase: v.passphrase,
          qr: v.qr,
          copy: !v['no-copy'],
          force: v.force,
        });
      case 'pull':
        if (io.isTTY) io.out(banner(c) + '\n');
        return await pullCmd(ctx, {
          link: rest[0],
          out: v.out,
          merge: v.merge,
          replace: v.replace,
          yes: v.yes,
        });
      case 'revoke':
        return await revokeCmd(ctx, { id: rest[0], all: v.all });
      case 'scan':
        return await scanCmd(ctx, { staged: v.staged, files: rest });
      case 'hook':
        return await hookCmd(ctx, rest[0]);
      case 'example':
        return await exampleCmd(ctx, { file: rest[0] });
      case 'check':
        return await checkCmd(ctx, { file: rest[0] });
      default:
        io.err(`${c.red('✖')} Unknown command "${command}". Run envdrop --help.`);
        return 2;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    io.err(`${c.red('✖')} ${msg}`);
    return e instanceof CliError ? e.code : 1;
  }
}

const isEntry =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('envdrop.mjs') ||
  process.argv[1]?.endsWith('/envdrop');
if (isEntry) {
  main().then(
    (code) => (process.exitCode = code),
    () => (process.exitCode = 1),
  );
}
