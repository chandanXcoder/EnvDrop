import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isEnvExampleFile } from '@envdrop/shared';

/** Common env file names, in the order offered when sharing. */
export const ENV_CANDIDATES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.staging',
  '.env.production',
  '.env.test',
];

export function isShareableEnvFile(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (base.endsWith('.backup')) return false;
  return (
    (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) &&
    !isEnvExampleFile(base)
  );
}

/** Finds env files directly inside `dir`. */
export async function findEnvFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found = names.filter((n) => isShareableEnvFile(n));
  const rank = (n: string) => {
    const i = ENV_CANDIDATES.indexOf(n);
    return i === -1 ? ENV_CANDIDATES.length : i;
  };
  return found
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((n) => path.join(dir, n));
}

/** Writes `<file>.backup` (overwriting a previous backup). Returns the backup path. */
export async function backupFile(file: string): Promise<string> {
  const backup = `${file}.backup`;
  await fs.copyFile(file, backup);
  return backup;
}

/** Safe target name for an incoming file: basename only, must look like an env file. */
export function safeIncomingName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  return isShareableEnvFile(base) ? base : '.env';
}
