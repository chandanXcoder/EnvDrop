import { describe, expect, it } from 'vitest';
import {
  isEnvExampleFile,
  maskSecret,
  scanText,
  scanUnifiedDiff,
  sensitiveFilenameReason,
  shannonEntropy,
} from '../src';

// Fake tokens are assembled at runtime so this file itself doesn't trip secret scanners.
const j = (...p: string[]) => p.join('');
const AWS_ID = j('AKIA', 'IOSFODNN7', 'EXAMPLQ');
const AWS_SECRET = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
const GH = j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
const STRIPE = j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc');
const SLACK = j('xoxb-', '123456789012-', 'abcdefABCDEF1234');
const PK = j('-----BEGIN ', 'RSA PRIVATE KEY-----');

describe('sensitiveFilenameReason', () => {
  it.each([
    ['.env', 'env-file'],
    ['apps/web/.env.local', 'env-file'],
    ['.env.production', 'env-file'],
    ['config\\.env.staging', 'env-file'],
    ['prod.env', 'env-file'],
    ['certs/server.pem', 'private-key-file'],
    ['~/.ssh/id_rsa', 'private-key-file'],
    ['gcp/credentials.json', 'credentials-file'],
  ])('%s -> %s', (p, reason) => expect(sensitiveFilenameReason(p)).toBe(reason));

  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    'id_rsa.pub',
    'README.md',
    'environment.ts',
  ])('%s is not sensitive', (p) => expect(sensitiveFilenameReason(p)).toBeUndefined());

  it('recognises example files', () => {
    expect(isEnvExampleFile('a/.env.example')).toBe(true);
    expect(isEnvExampleFile('.env')).toBe(false);
  });
});

describe('scanText', () => {
  it('detects well-known token formats with line numbers', () => {
    const text = [
      'const a = 1;',
      `AWS_ACCESS_KEY_ID=${AWS_ID}`,
      `aws_secret_access_key = "${AWS_SECRET}"`,
      `token: '${GH}'`,
      `stripe(${JSON.stringify(STRIPE)})`,
      `SLACK=${SLACK}`,
      PK,
    ].join('\n');
    const f = scanText(text);
    expect(f.map((x) => [x.ruleId, x.line])).toEqual([
      ['aws-access-key-id', 2],
      ['aws-secret-access-key', 3],
      ['github-token', 4],
      ['stripe-secret-key', 5],
      ['slack-token', 6],
      ['private-key', 7],
    ]);
  });

  it('never exposes the secret value', () => {
    const f = scanText(`X=${GH}\nY=${STRIPE}\nZ=${AWS_SECRET}\nAPI_KEY=${AWS_SECRET}`);
    const dump = JSON.stringify(f);
    for (const s of [GH, STRIPE, AWS_SECRET, GH.slice(0, 10), STRIPE.slice(0, 10)]) {
      expect(dump).not.toContain(s);
    }
    expect(f.every((x) => x.masked.endsWith('••••••••'))).toBe(true);
  });

  it('flags high-entropy generic assignments but not placeholders or low entropy', () => {
    expect(scanText('DB_PASSWORD=Zx8!qP2vL9@wR4$tY6kMn').map((f) => f.ruleId)).toEqual([
      'generic-secret-assignment',
    ]);
    expect(scanText('API_KEY=your_api_key_here_please')).toEqual([]);
    expect(scanText('SECRET=${SECRET_FROM_VAULT_123}')).toEqual([]);
    expect(scanText('TOKEN=aaaaaaaaaaaaaaaaaaaaaa')).toEqual([]);
    expect(scanText('const token = process.env.GITHUB_TOKEN_VALUE')).toEqual([]);
  });

  it('prefers specific rules over the generic one on the same line', () => {
    expect(scanText(`GITHUB_TOKEN=${GH}`).map((f) => f.ruleId)).toEqual(['github-token']);
  });

  it('honours the envdrop:allow pragma', () => {
    expect(scanText(`KEY=${STRIPE} # envdrop:allow`)).toEqual([]);
  });
});

describe('scanUnifiedDiff', () => {
  it('only scans added lines and reports new-file line numbers', () => {
    const diff = [
      'diff --git a/config.ts b/config.ts',
      '--- a/config.ts',
      '+++ b/config.ts',
      '@@ -1,3 +10,4 @@',
      ' context',
      `-const old = "${STRIPE}";`,
      '+const fine = 1;',
      `+const key = "${GH}";`,
      ' tail',
    ].join('\n');
    expect(scanUnifiedDiff(diff)).toEqual([
      { ruleId: 'github-token', type: 'GitHub token', line: 12, masked: maskSecret(GH) },
    ]);
  });
});

describe('helpers', () => {
  it('entropy and mask', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(maskSecret('abc')).toBe('••••••••');
    expect(maskSecret(AWS_ID)).toBe('AKIA••••••••');
  });
});
