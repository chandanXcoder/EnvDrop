/**
 * A dotenv-compatible parser that keeps source positions, so we can diff by key and
 * merge selected keys into an existing file without reformatting it.
 *
 * Supports: comments, blank lines, `export KEY=...`, unquoted values with inline
 * `  # comments`, 'single' (literal), "double" (with \n \r \t \" \\ escapes) and
 * `backtick` quotes, and multiline values inside any quote style.
 * Duplicate keys: the last one wins (same as dotenv).
 *
 * Error messages never contain values.
 */

export type EnvNode =
  | { type: 'blank'; line: number; raw: string }
  | { type: 'comment'; line: number; raw: string }
  | { type: 'invalid'; line: number; raw: string }
  | EnvEntry;

export interface EnvEntry {
  type: 'entry';
  key: string;
  value: string;
  exported: boolean;
  quote: '"' | "'" | '`' | null;
  /** 0-based first and last line index (inclusive) in the source. */
  line: number;
  endLine: number;
  /** Exact source text of the entry (may span several lines). */
  raw: string;
}

export interface ParseError {
  /** 1-based line number */
  line: number;
  message: string;
}

export interface ParsedEnv {
  nodes: EnvNode[];
  /** Last definition of each key, in first-appearance order. */
  entries: Map<string, EnvEntry>;
  errors: ParseError[];
  /** Line ending detected in the source. */
  eol: '\n' | '\r\n';
}

const ENTRY_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
  );
}

/** Index of the closing quote in s (from `from`), honouring backslash escapes for ". */
function findClose(s: string, q: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (q === '"' && ch === '\\') {
      i++;
      continue;
    }
    if (ch === q) return i;
  }
  return -1;
}

export function parseEnv(text: string): ParsedEnv {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // A trailing newline produces one empty phantom line; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const nodes: EnvNode[] = [];
  const entries = new Map<string, EnvEntry>();
  const errors: ParseError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '') {
      nodes.push({ type: 'blank', line: i, raw });
      continue;
    }
    if (trimmed.startsWith('#')) {
      nodes.push({ type: 'comment', line: i, raw });
      continue;
    }
    const m = ENTRY_RE.exec(raw);
    if (!m) {
      nodes.push({ type: 'invalid', line: i, raw });
      errors.push({ line: i + 1, message: 'Line is not a KEY=VALUE assignment' });
      continue;
    }
    const exported = Boolean(m[1]);
    const key = m[2]!;
    const rest = m[3]!.replace(/^\s+/, '');
    let value: string;
    let quote: EnvEntry['quote'] = null;
    let endLine = i;

    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      quote = q;
      // Accumulate lines until we find the closing quote.
      let buf = rest;
      let close = findClose(buf, q, 1);
      let j = i;
      while (close === -1 && j + 1 < lines.length) {
        j++;
        buf += '\n' + lines[j];
        close = findClose(buf, q, 1);
      }
      if (close === -1) {
        errors.push({ line: i + 1, message: `Unterminated ${q} quote` });
        value = rest.slice(1);
        quote = null;
      } else {
        endLine = j;
        const inner = buf.slice(1, close);
        value = q === '"' ? unescapeDouble(inner) : inner;
        const after = buf.slice(close + 1).trim();
        if (after !== '' && !after.startsWith('#')) {
          errors.push({ line: endLine + 1, message: 'Unexpected text after closing quote' });
        }
      }
    } else {
      const hash = rest.search(/\s#/);
      value = (hash === -1 ? rest : rest.slice(0, hash)).trim();
      if (rest.startsWith('#')) value = '';
    }

    const entry: EnvEntry = {
      type: 'entry',
      key,
      value,
      exported,
      quote,
      line: i,
      endLine,
      raw: lines.slice(i, endLine + 1).join('\n'),
    };
    nodes.push(entry);
    entries.delete(key); // re-insert so "last wins" but keep a stable order
    entries.set(key, entry);
    i = endLine;
  }
  return { nodes, entries, errors, eol };
}
