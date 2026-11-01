import { fromBase64Url } from './encoding';
import { IV_BYTES, SALT_BYTES, SCRYPT_BOUNDS } from './limits';
import type { Envelope, ScryptParams } from './types';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function b64urlLen(s: unknown, expected?: number): s is string {
  if (typeof s !== 'string') return false;
  try {
    const b = fromBase64Url(s);
    return expected === undefined ? b.length > 0 : b.length === expected;
  } catch {
    return false;
  }
}

function isPow2(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

export function validateScryptParams(k: unknown): k is ScryptParams {
  if (!k || typeof k !== 'object') return false;
  const o = k as Record<string, unknown>;
  if (o.alg !== 'scrypt') return false;
  const { N, r, p } = o;
  if (typeof N !== 'number' || !isPow2(N)) return false;
  const logN = Math.log2(N);
  if (logN < SCRYPT_BOUNDS.minLogN || logN > SCRYPT_BOUNDS.maxLogN) return false;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > SCRYPT_BOUNDS.maxR)
    return false;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > SCRYPT_BOUNDS.maxP)
    return false;
  return b64urlLen(o.salt, SALT_BYTES);
}

/**
 * Structural validation only (the server uses this too). It says nothing about whether
 * the ciphertext is authentic; that is checked by AES-GCM on decrypt.
 */
export function validateEnvelope(e: unknown): e is Envelope {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  const allowed = new Set(['v', 'iv', 'ct', 'kdf']);
  if (Object.keys(o).some((k) => !allowed.has(k))) return false;
  if (o.v !== 1) return false;
  if (!b64urlLen(o.iv, IV_BYTES)) return false;
  if (!b64urlLen(o.ct)) return false;
  if (o.kdf !== undefined && !validateScryptParams(o.kdf)) return false;
  return true;
}

/**
 * Additional authenticated data: binds the version and KDF parameters to the ciphertext,
 * so an attacker can't strip or alter the passphrase requirement without breaking GCM.
 */
export function envelopeAad(e: Pick<Envelope, 'v' | 'kdf'>): string {
  const k = e.kdf;
  return k ? `envdrop:v${e.v}:scrypt:${k.N}:${k.r}:${k.p}:${k.salt}` : `envdrop:v${e.v}:none`;
}
