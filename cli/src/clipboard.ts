import { spawn } from 'node:child_process';

const CANDIDATES: Record<string, [string, string[]][]> = {
  darwin: [['pbcopy', []]],
  win32: [['clip', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
};

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** Best-effort clipboard write. Returns false if no clipboard tool is available. */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const [cmd, args] of CANDIDATES[process.platform] ?? []) {
    if (await tryCopy(cmd, args, text)) return true;
  }
  return false;
}
