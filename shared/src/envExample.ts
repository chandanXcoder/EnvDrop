import { mergeEnv } from './envDiff';
import { parseEnv } from './envParser';

/**
 * Builds a .env.example from a real .env: keeps comments, blank lines, key order and
 * `export`, strips every value. If an existing example is given, its lines for keys that
 * still exist are kept (so hand-written placeholders such as `PORT=3000` survive).
 * Never copies a value from the real file.
 */
export function generateExample(envText: string, existingExample?: string): string {
  const env = parseEnv(envText);
  const prev = existingExample !== undefined ? parseEnv(existingExample) : undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of env.nodes) {
    if (node.type === 'blank' || node.type === 'comment') {
      out.push(node.raw);
      continue;
    }
    if (node.type === 'invalid') continue;
    if (seen.has(node.key)) continue; // duplicates collapse to one line
    seen.add(node.key);
    const kept = prev?.entries.get(node.key);
    out.push(kept ? kept.raw : `${node.exported ? 'export ' : ''}${node.key}=`);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out.length ? out.join('\n') + '\n' : '';
}

export interface KeyCheck {
  /** In .env.example but not in .env: the app will probably break. */
  missing: string[];
  /** In .env but not in .env.example: undocumented for teammates. */
  extra: string[];
  /** Present in both, but empty in .env. */
  empty: string[];
  /** Number of keys that are fine. */
  ok: number;
}

export function checkKeys(envText: string, exampleText: string): KeyCheck {
  const env = parseEnv(envText).entries;
  const ex = parseEnv(exampleText).entries;
  const res: KeyCheck = { missing: [], extra: [], empty: [], ok: 0 };
  for (const key of ex.keys()) {
    const e = env.get(key);
    if (!e) res.missing.push(key);
    else if (e.value === '') res.empty.push(key);
    else res.ok++;
  }
  for (const key of env.keys()) if (!ex.has(key)) res.extra.push(key);
  return res;
}

/** Appends `KEY=` lines for the given keys (only those not already present). */
export function addEmptyKeys(text: string, keys: string[]): string {
  const existing = parseEnv(text).entries;
  const add = keys.filter((k) => !existing.has(k));
  if (add.length === 0) return text;
  return mergeEnv(text, add.map((k) => `${k}=`).join('\n') + '\n', { apply: add });
}
