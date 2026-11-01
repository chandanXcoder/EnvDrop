/** Tiny terminal UI kit: colors, spinner, prompts. No dependencies. */
import { stdin, stdout, stderr } from 'node:process';
import * as readline from 'node:readline';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  color: boolean;
  /** Visible prompt; resolves to the typed line. */
  ask: (question: string) => Promise<string>;
  /** Hidden prompt (passphrases, links). */
  askHidden: (question: string) => Promise<string>;
}

export function defaultIo(): Io {
  const isTTY = Boolean(stdout.isTTY && stdin.isTTY);
  const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  return {
    out: (s) => stdout.write(s + '\n'),
    err: (s) => stderr.write(s + '\n'),
    isTTY,
    color,
    ask: (q) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        rl.question(q, (a) => {
          rl.close();
          resolve(a);
        });
      }),
    askHidden: (q) => askHidden(q),
  };
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // Non-interactive: read one line from stdin (e.g. `echo $LINK | envdrop pull`).
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', (l) => {
        resolve(l); // resolve before close(): close fires synchronously
        rl.close();
      });
      rl.once('close', () => resolve(''));
      return;
    }
    stdout.write(question);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          done();
          stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          done();
          stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
          }
        } else {
          buf += c;
          stdout.write('•');
        }
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export function palette(enabled: boolean) {
  const wrap =
    (open: string, close = '\x1b[0m') =>
    (s: string) =>
      enabled ? `${open}${s}${close}` : s;
  const rgb = (r: number, g: number, b: number) => wrap(`\x1b[38;2;${r};${g};${b}m`);
  return {
    bold: wrap('\x1b[1m', '\x1b[22m'),
    dim: wrap('\x1b[2m', '\x1b[22m'),
    red: wrap('\x1b[31m'),
    green: wrap('\x1b[32m'),
    yellow: wrap('\x1b[33m'),
    cyan: wrap('\x1b[36m'),
    violet: rgb(139, 108, 255),
    gitOrange: rgb(240, 80, 50),
    /** Violet → cyan gradient across the string. */
    grad: (s: string) => {
      if (!enabled) return s;
      const a = [139, 108, 255];
      const b = [34, 211, 238];
      const chars = [...s];
      return (
        chars
          .map((ch, i) => {
            const t = chars.length > 1 ? i / (chars.length - 1) : 0;
            const c = a.map((v, k) => Math.round(v + (b[k]! - v) * t));
            return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${ch}`;
          })
          .join('') + '\x1b[0m'
      );
    },
  };
}
export type Palette = ReturnType<typeof palette>;

export function banner(c: Palette): string {
  return `${c.grad('  ◆ EnvDrop')} ${c.dim('· end-to-end encrypted .env sharing')}`;
}

export const sym = (c: Palette) => ({
  ok: c.green('✔'),
  warn: c.yellow('▲'),
  err: c.red('✖'),
  info: c.cyan('ℹ'),
  lock: '🔒',
  git: c.gitOrange('◆'),
  bullet: c.dim('›'),
});

/** Braille spinner on TTYs; silent otherwise. */
export async function spin<T>(
  io: Io,
  c: Palette,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!io.isTTY || !io.color) {
    return work();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(
    () => stdout.write(`\r${c.violet(frames[i++ % frames.length]!)} ${label}`),
    80,
  );
  try {
    const r = await work();
    clearInterval(t);
    stdout.write(`\r\x1b[2K${c.green('✔')} ${label}\n`);
    return r;
  } catch (e) {
    clearInterval(t);
    stdout.write(`\r\x1b[2K${c.red('✖')} ${label}\n`);
    throw e;
  }
}

export function box(c: Palette, lines: string[]): string {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const w = Math.max(...lines.map(visible));
  const top = c.violet(`╭${'─'.repeat(w + 2)}╮`);
  const bot = c.violet(`╰${'─'.repeat(w + 2)}╯`);
  const mid = lines.map(
    (l) => `${c.violet('│')} ${l}${' '.repeat(w - visible(l))} ${c.violet('│')}`,
  );
  return [top, ...mid, bot].join('\n');
}

export async function confirm(io: Io, question: string, def = true): Promise<boolean> {
  if (!io.isTTY) return def;
  const a = (await io.ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (a === '') return def;
  return a === 'y' || a === 'yes';
}

/** Lists choices and returns the chosen key. */
export async function choose<K extends string>(
  io: Io,
  c: Palette,
  question: string,
  options: [K, string][],
  def: K,
): Promise<K> {
  if (!io.isTTY) return def;
  io.out(question);
  options.forEach(([, label], i) => io.out(`  ${c.violet(String(i + 1))}) ${label}`));
  const a = (
    await io.ask(`Choose 1-${options.length} [${options.findIndex(([k]) => k === def) + 1}]: `)
  ).trim();
  const n = Number(a);
  return a === '' || !Number.isInteger(n) || n < 1 || n > options.length ? def : options[n - 1]![0];
}
