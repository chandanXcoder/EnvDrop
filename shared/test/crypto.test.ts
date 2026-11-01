import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  decryptPayload,
  encryptPayload,
  fromBase64Url,
  MAX_PLAINTEXT_BYTES,
  needsPassphrase,
  pad,
  PayloadTooLargeError,
  toBase64Url,
  unpad,
  validateEnvelope,
} from '../src';

const FAST = { N: 2 ** 14, r: 8, p: 1 };
const payload = { name: '.env', content: 'API_KEY=sk_live_abc\nDB_URL="postgres://u:p@h/db"\n' };

function flipByte(b64: string, idx = 0): string {
  const b = fromBase64Url(b64);
  b[idx] = b[idx]! ^ 0x01;
  return toBase64Url(b);
}

describe('encoding', () => {
  it('round-trips base64url', () => {
    const b = new Uint8Array([0, 1, 250, 255, 62, 63]);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(toBase64Url(b)).not.toMatch(/[+/=]/);
  });
  it('rejects invalid base64url', () => {
    expect(() => fromBase64Url('ab+/')).toThrow();
  });
});

describe('padding', () => {
  it('pads to 1 KiB buckets and unpads', () => {
    const d = new Uint8Array(10).fill(7);
    const p = pad(d);
    expect(p.length).toBe(1024);
    expect(unpad(p)).toEqual(d);
    expect(pad(new Uint8Array(1020)).length).toBe(1024);
    expect(pad(new Uint8Array(1021)).length).toBe(2048);
  });
});

describe('encrypt/decrypt', () => {
  it('round-trips without passphrase', async () => {
    const { envelope, linkKey } = await encryptPayload(payload);
    expect(validateEnvelope(envelope)).toBe(true);
    expect(needsPassphrase(envelope)).toBe(false);
    expect(fromBase64Url(linkKey)).toHaveLength(32);
    expect(JSON.stringify(envelope)).not.toContain('sk_live');
    expect(JSON.stringify(envelope)).not.toContain('.env');
    await expect(decryptPayload(envelope, linkKey)).resolves.toEqual(payload);
  });

  it('uses a fresh key and IV every time', async () => {
    const a = await encryptPayload(payload);
    const b = await encryptPayload(payload);
    expect(a.linkKey).not.toBe(b.linkKey);
    expect(a.envelope.iv).not.toBe(b.envelope.iv);
  });

  it('fails with the wrong key', async () => {
    const { envelope } = await encryptPayload(payload);
    const other = (await encryptPayload(payload)).linkKey;
    await expect(decryptPayload(envelope, other)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects ciphertext tampering', async () => {
    const { envelope, linkKey } = await encryptPayload(payload);
    await expect(
      decryptPayload({ ...envelope, ct: flipByte(envelope.ct, 5) }, linkKey),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      decryptPayload({ ...envelope, iv: flipByte(envelope.iv) }, linkKey),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects malformed envelopes and keys', async () => {
    const { envelope, linkKey } = await encryptPayload(payload);
    await expect(decryptPayload({ ...envelope, v: 2 }, linkKey)).rejects.toThrow(/Malformed/);
    await expect(decryptPayload({ ...envelope, extra: 1 }, linkKey)).rejects.toThrow(/Malformed/);
    await expect(decryptPayload(envelope, 'short')).rejects.toThrow(/malformed/);
  });

  it('enforces the plaintext size limit', async () => {
    const big = { name: '.env', content: 'A'.repeat(MAX_PLAINTEXT_BYTES) };
    await expect(encryptPayload(big)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('handles unicode content', async () => {
    const p = { name: '.env.production', content: 'GREETING="नमस्ते 👋"\n' };
    const { envelope, linkKey } = await encryptPayload(p);
    await expect(decryptPayload(envelope, linkKey)).resolves.toEqual(p);
  });
});

describe('passphrase mode', () => {
  it('requires both link key and passphrase', async () => {
    const { envelope, linkKey } = await encryptPayload(payload, {
      passphrase: 'correct horse',
      scrypt: FAST,
    });
    expect(needsPassphrase(envelope)).toBe(true);
    await expect(decryptPayload(envelope, linkKey, 'correct horse')).resolves.toEqual(payload);
    await expect(decryptPayload(envelope, linkKey)).rejects.toThrow(/passphrase/);
    await expect(decryptPayload(envelope, linkKey, 'wrong')).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const otherKey = (await encryptPayload(payload)).linkKey;
    await expect(decryptPayload(envelope, otherKey, 'correct horse')).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('binds KDF params as AAD (stripping or changing them fails)', async () => {
    const { envelope, linkKey } = await encryptPayload(payload, { passphrase: 'pw', scrypt: FAST });
    const { kdf: _kdf, ...stripped } = envelope;
    await expect(decryptPayload(stripped, linkKey)).rejects.toBeInstanceOf(DecryptionError);
    const changed = { ...envelope, kdf: { ...envelope.kdf!, r: 9 } };
    await expect(decryptPayload(changed, linkKey, 'pw')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('normalizes passphrase unicode (NFKC)', async () => {
    const { envelope, linkKey } = await encryptPayload(payload, {
      passphrase: 'café',
      scrypt: FAST,
    });
    await expect(decryptPayload(envelope, linkKey, 'café')).resolves.toEqual(payload);
  });

  it('rejects out-of-bounds scrypt params (DoS guard)', async () => {
    const { envelope, linkKey } = await encryptPayload(payload, { passphrase: 'pw', scrypt: FAST });
    const huge = { ...envelope, kdf: { ...envelope.kdf!, N: 2 ** 24 } };
    await expect(decryptPayload(huge, linkKey, 'pw')).rejects.toThrow(/Malformed/);
  });
});
