import { ALLOW_PRAGMA, CONTENT_RULES, type ContentRule, PLACEHOLDER_RE } from './secretPatterns';

export interface SecretFinding {
  ruleId: string;
  type: string;
  /** 1-based line number (in the new file, for diffs) */
  line: number;
  /** Masked preview. Never the full value. */
  masked: string;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Shows at most 4 leading characters (often a well-known prefix such as AKIA), never more. */
export function maskSecret(secret: string): string {
  const visible = Math.min(4, Math.floor(secret.length / 4));
  return `${secret.slice(0, visible)}${'•'.repeat(8)}`;
}

function scanLine(
  text: string,
  lineNo: number,
  rules: readonly ContentRule[],
  out: SecretFinding[],
) {
  if (text.includes(ALLOW_PRAGMA)) return;
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, '') + 'g');
    for (const m of text.matchAll(re)) {
      const secret = m[rule.group ?? 0] ?? m[0];
      if (rule.minEntropy !== undefined) {
        if (PLACEHOLDER_RE.test(secret)) continue;
        if (shannonEntropy(secret) < rule.minEntropy) continue;
      }
      out.push({ ruleId: rule.id, type: rule.name, line: lineNo, masked: maskSecret(secret) });
      break; // one finding per rule per line is enough
    }
  }
}

/** Removes generic findings on lines that already have a specific finding. */
function dedupe(findings: SecretFinding[]): SecretFinding[] {
  const specific = new Set(
    findings.filter((f) => f.ruleId !== 'generic-secret-assignment').map((f) => f.line),
  );
  return findings.filter((f) => f.ruleId !== 'generic-secret-assignment' || !specific.has(f.line));
}

export function scanText(
  text: string,
  rules: readonly ContentRule[] = CONTENT_RULES,
): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => scanLine(line, i + 1, rules, out));
  return dedupe(out);
}

/**
 * Scans only the added lines (`+`) of a unified diff, reporting new-file line numbers.
 */
export function scanUnifiedDiff(
  diff: string,
  rules: readonly ContentRule[] = CONTENT_RULES,
): SecretFinding[] {
  const out: SecretFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      scanLine(line.slice(1), newLine, rules, out);
      newLine++;
    } else if (line.startsWith('-') || line.startsWith('\\')) {
      // removed line or "\ No newline at end of file": new-file counter unchanged
    } else if (line.startsWith('diff --git')) {
      inHunk = false;
    } else {
      newLine++;
    }
  }
  return dedupe(out);
}
