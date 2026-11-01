import { type EnvEntry, type ParsedEnv, parseEnv } from './envParser';

/** Diff by KEY. Values are compared but never included in the result. */
export interface EnvDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export function diffEnv(local: ParsedEnv, incoming: ParsedEnv): EnvDiff {
  const out: EnvDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [key, inc] of incoming.entries) {
    const loc = local.entries.get(key);
    if (!loc) out.added.push(key);
    else if (loc.value !== inc.value) out.changed.push(key);
    else out.unchanged.push(key);
  }
  for (const key of local.entries.keys()) {
    if (!incoming.entries.has(key)) out.removed.push(key);
  }
  return out;
}

export interface MergeSelection {
  /** Keys whose incoming definition should be applied (added or changed). */
  apply: string[];
  /** Keys that exist only locally and should be deleted. */
  remove?: string[];
}

/**
 * Applies selected keys from `incomingText` onto `localText`, preserving every other line
 * of the local file. Applied entries are copied verbatim from the incoming source
 * (quotes, `export`, multiline). Nothing is re-serialised, so no escaping can go wrong.
 */
export function mergeEnv(localText: string, incomingText: string, sel: MergeSelection): string {
  const local = parseEnv(localText);
  const incoming = parseEnv(incomingText);
  const apply = new Set(sel.apply.filter((k) => incoming.entries.has(k)));
  const remove = new Set((sel.remove ?? []).filter((k) => !incoming.entries.has(k)));
  const eol = local.eol;

  const out: string[] = [];
  const written = new Set<string>();
  for (const node of local.nodes) {
    if (node.type !== 'entry') {
      out.push(node.raw);
      continue;
    }
    const isLast = local.entries.get(node.key) === node;
    if (remove.has(node.key)) continue;
    if (apply.has(node.key)) {
      // Replace the effective (last) definition; drop earlier duplicates.
      if (isLast) {
        out.push(incoming.entries.get(node.key)!.raw);
        written.add(node.key);
      }
      continue;
    }
    out.push(node.raw);
  }

  const additions: EnvEntry[] = [];
  for (const key of apply) if (!written.has(key)) additions.push(incoming.entries.get(key)!);
  if (additions.length > 0) {
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    if (out.length > 0) out.push('');
    out.push(...additions.map((e) => e.raw));
  }
  if (out.length === 0) return '';
  const text = out.join('\n') + '\n';
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** Mask a value for display. The length is not revealed. */
export function maskValue(_value?: string): string {
  return '••••••••';
}
