import { describe, expect, it } from 'vitest';
import { addEmptyKeys, checkKeys, generateExample } from '../src';

const ENV = `# Database
DATABASE_URL="postgres://user:hunter2@db/app"
export API_KEY=sk_live_secret

# Multiline
PEM="-----BEGIN-----
abc
-----END-----"
PORT=8080
PORT=9090
`;

describe('generateExample', () => {
  it('keeps structure and strips every value', () => {
    const out = generateExample(ENV);
    expect(out).toBe('# Database\nDATABASE_URL=\nexport API_KEY=\n\n# Multiline\nPEM=\nPORT=\n');
    for (const secret of ['hunter2', 'sk_live', 'BEGIN', '8080', '9090'])
      expect(out).not.toContain(secret);
  });

  it('keeps placeholders from an existing example for keys that still exist', () => {
    const out = generateExample(ENV, 'PORT=3000\nOLD_KEY=gone\n');
    expect(out).toContain('PORT=3000');
    expect(out).not.toContain('OLD_KEY');
  });

  it('handles empty input', () => {
    expect(generateExample('')).toBe('');
  });
});

describe('checkKeys', () => {
  it('reports missing, extra and empty keys', () => {
    const r = checkKeys('A=1\nB=\nEXTRA=x\n', 'A=\nB=\nC=\n');
    expect(r).toEqual({ missing: ['C'], extra: ['EXTRA'], empty: ['B'], ok: 1 });
  });
});

describe('addEmptyKeys', () => {
  it('appends only absent keys', () => {
    expect(addEmptyKeys('A=1\n', ['A', 'B', 'C'])).toBe('A=1\n\nB=\nC=\n');
    expect(addEmptyKeys('A=1\n', ['A'])).toBe('A=1\n');
  });
});
