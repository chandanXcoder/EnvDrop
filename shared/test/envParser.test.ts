import { describe, expect, it } from 'vitest';
import { diffEnv, mergeEnv, parseEnv } from '../src';

const values = (text: string) =>
  Object.fromEntries([...parseEnv(text).entries].map(([k, e]) => [k, e.value]));

describe('parseEnv', () => {
  it('parses basic, export, comments, blanks', () => {
    const text = '# comment\n\nA=1\nexport B=two\n  C = spaced  \nD=\n';
    const p = parseEnv(text);
    expect(values(text)).toEqual({ A: '1', B: 'two', C: 'spaced', D: '' });
    expect(p.entries.get('B')!.exported).toBe(true);
    expect(p.nodes.map((n) => n.type)).toEqual([
      'comment',
      'blank',
      'entry',
      'entry',
      'entry',
      'entry',
    ]);
    expect(p.errors).toEqual([]);
  });

  it('strips inline comments only for unquoted values', () => {
    expect(values('A=foo # note\nB="foo # not a comment"\nC=foo#bar\nD=# just comment')).toEqual({
      A: 'foo',
      B: 'foo # not a comment',
      C: 'foo#bar',
      D: '',
    });
  });

  it('handles quote styles and escapes', () => {
    expect(values(`A='lit \\n'\nB="esc\\n\\t\\"q\\""\nC=\`tick\``)).toEqual({
      A: 'lit \\n',
      B: 'esc\n\t"q"',
      C: 'tick',
    });
  });

  it('handles multiline quoted values and tracks line spans', () => {
    const text = 'KEY="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nNEXT=1\n';
    const p = parseEnv(text);
    const e = p.entries.get('KEY')!;
    expect(e.value).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
    expect([e.line, e.endLine]).toEqual([0, 2]);
    expect(p.entries.get('NEXT')!.line).toBe(3);
  });

  it('reports unterminated quotes and invalid lines without values', () => {
    const p = parseEnv('A="secretvalue\nnot an assignment\n');
    expect(p.errors.map((e) => e.line)).toContain(1);
    expect(JSON.stringify(p.errors)).not.toContain('secretvalue');
  });

  it('last duplicate wins', () => {
    expect(values('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('handles CRLF', () => {
    const p = parseEnv('A=1\r\nB="x"\r\n');
    expect(p.eol).toBe('\r\n');
    expect(values('A=1\r\nB="x"\r\n')).toEqual({ A: '1', B: 'x' });
  });
});

describe('diffEnv', () => {
  it('classifies keys and never includes values', () => {
    const d = diffEnv(parseEnv('A=1\nB=2\nC=3\n'), parseEnv('A=1\nB=s3cr3tv4lue\nD=4\n'));
    expect(d).toEqual({ added: ['D'], removed: ['C'], changed: ['B'], unchanged: ['A'] });
    expect(JSON.stringify(d)).not.toContain('s3cr3tv4lue');
  });

  it('treats quoting differences of the same value as unchanged', () => {
    expect(diffEnv(parseEnv('A=x'), parseEnv('A="x"')).unchanged).toEqual(['A']);
  });
});

describe('mergeEnv', () => {
  const local = '# local header\nA=1\nB=old # keep comment?\nC=3\n';
  const incoming = 'A=1\nB="new"\nD="multi\nline"\n';

  it('applies selected keys in place and appends new ones verbatim', () => {
    const out = mergeEnv(local, incoming, { apply: ['B', 'D'] });
    expect(out).toBe('# local header\nA=1\nB="new"\nC=3\n\nD="multi\nline"\n');
    expect(values(out)).toEqual({ A: '1', B: 'new', C: '3', D: 'multi\nline' });
  });

  it('leaves unselected keys alone and can remove local-only keys', () => {
    const out = mergeEnv(local, incoming, { apply: ['D'], remove: ['C'] });
    expect(values(out)).toEqual({ A: '1', B: 'old', D: 'multi\nline' });
    expect(out).toContain('# local header');
  });

  it('preserves CRLF line endings', () => {
    const out = mergeEnv('A=1\r\nB=2\r\n', 'B=3\nC="x\ny"\n', { apply: ['B', 'C'] });
    expect(out).toBe('A=1\r\nB=3\r\n\r\nC="x\r\ny"\r\n');
  });

  it('replaces only the effective definition when duplicates exist', () => {
    const out = mergeEnv('A=1\nA=2\n', 'A=3\n', { apply: ['A'] });
    expect(out).toBe('A=3\n');
  });
});
