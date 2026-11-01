/**
 * Detection rules for the staged-file warning. Kept data-only and separate from the
 * scanner so they are easy to review, extend and unit-test.
 *
 * Rules aim for low false positives on obvious, well-known token formats. They are a
 * safety net, not a replacement for a dedicated scanner such as gitleaks.
 */

export interface ContentRule {
  id: string;
  name: string;
  /** Must not use the `g` or `y` flags; the scanner adds them. */
  pattern: RegExp;
  /** Capture group holding the secret itself (default: whole match). */
  group?: number;
  /** Require Shannon entropy (bits/char) of the secret to be at least this. */
  minEntropy?: number;
}

export const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: 'private-key',
    name: 'Private key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'aws-access-key-id',
    name: 'AWS access key ID',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/,
    group: 1,
  },
  {
    id: 'aws-secret-access-key',
    name: 'AWS secret access key',
    pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
    group: 1,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/,
    group: 1,
  },
  {
    id: 'github-pat',
    name: 'GitHub fine-grained token',
    pattern: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/,
    group: 1,
  },
  {
    id: 'stripe-secret-key',
    name: 'Stripe secret key',
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/,
    group: 1,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/,
    group: 1,
  },
  {
    id: 'slack-webhook',
    name: 'Slack webhook URL',
    pattern: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/,
    group: 1,
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/,
    group: 1,
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic API key',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/,
    group: 1,
  },
  {
    id: 'openai-key',
    name: 'OpenAI API key',
    pattern: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})/,
    group: 1,
  },
  {
    id: 'generic-secret-assignment',
    name: 'High-entropy secret assignment',
    pattern:
      /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH|CREDENTIALS?)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([^\s"'#,;]{16,})/i,
    group: 1,
    minEntropy: 3.5,
  },
];

/** Values that look like secrets syntactically but are obviously placeholders. */
export const PLACEHOLDER_RE =
  /^(?:<.*>|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|\{\{.*\}\}|process\.env\..*|os\.environ.*|(?:x+|\*+|\.+|-+)|.*(?:changeme|change_me|your[_-]|example|placeholder|dummy|redacted|replace[_-]?me|xxxx|todo).*)$/i;

/** Lines containing this marker are skipped by the scanner. */
export const ALLOW_PRAGMA = 'envdrop:allow';

/** Basenames that are always sensitive. */
const SENSITIVE_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
]);

const SAFE_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];

export type SensitiveFileReason = 'env-file' | 'private-key-file' | 'credentials-file';

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

/** Returns why a path is sensitive by name alone, or undefined. */
export function sensitiveFilenameReason(path: string): SensitiveFileReason | undefined {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (lower === '.env' || lower === '.env.backup') return 'env-file';
  if (lower.startsWith('.env.')) {
    const suffix = lower.slice(5);
    return SAFE_ENV_SUFFIXES.has(suffix) ? undefined : 'env-file';
  }
  if (/\.env$/i.test(name) && name.length > 4 && !lower.endsWith('.example.env')) return 'env-file';
  if (SENSITIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'private-key-file';
  if (SENSITIVE_BASENAMES.has(lower)) {
    return lower.startsWith('id_') ? 'private-key-file' : 'credentials-file';
  }
  return undefined;
}

export function isEnvExampleFile(path: string): boolean {
  const lower = basename(path).toLowerCase();
  return lower.startsWith('.env.') && SAFE_ENV_SUFFIXES.has(lower.slice(5));
}
