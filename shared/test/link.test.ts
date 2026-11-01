import { describe, expect, it } from 'vitest';
import { buildShareLink, parseShareLink } from '../src';

const id = 'AAAAAAAAAAAAAAAAAAAAAA';
const key = 'B'.repeat(43);

describe('share links', () => {
  it('builds and parses', () => {
    const link = buildShareLink('https://envdrop.example.com/some/path', id, key);
    expect(link).toBe(`https://envdrop.example.com/s/${id}#${key}`);
    expect(parseShareLink(`  ${link}  `)).toEqual({
      origin: 'https://envdrop.example.com',
      id,
      key,
    });
  });
  it('rejects non-https (except localhost), bad ids and missing keys', () => {
    expect(parseShareLink(`http://evil.com/s/${id}#${key}`)).toBeUndefined();
    expect(parseShareLink(`http://localhost:8787/s/${id}#${key}`)?.id).toBe(id);
    expect(parseShareLink(`https://x.com/s/${id}`)).toBeUndefined();
    expect(parseShareLink(`https://x.com/s/abc#${key}`)).toBeUndefined();
    expect(parseShareLink('not a url')).toBeUndefined();
  });
});
