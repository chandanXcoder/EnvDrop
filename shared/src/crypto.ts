/**
 * EnvDrop end-to-end encryption.
 *
 *   linkKey     = 32 random bytes, lives only in the URL fragment
 *   pass        = scrypt(NFKC(passphrase), salt, N, r, p)      (optional)
 *   contentKey  = HKDF-SHA256(ikm = linkKey || pass, salt, "envdrop/v1/content")
 *   ct          = AES-256-GCM(contentKey, iv, pad(JSON(payload)), aad = header)
 *
 * With a passphrase, decrypting needs the link and the passphrase. The server, which
 * holds neither, can't brute-force the passphrase offline because the linkKey is
 * also unknown to it.
 *
 * Primitives come from WebCrypto, plus scrypt from @noble/hashes. There is no custom crypto.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';
import {
  type Bytes,
  concatBytes,
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding';
import { envelopeAad, validateEnvelope } from './envelope';
import {
  IV_BYTES,
  KEY_BYTES,
  MAX_PLAINTEXT_BYTES,
  PAD_BLOCK_BYTES,
  SALT_BYTES,
  SCRYPT_DEFAULTS,
} from './limits';
import type { Envelope, ScryptParams, SharePayload } from './types';

const subtle = () => crypto.subtle;
const HKDF_INFO = utf8Encode('envdrop/v1/content');

/** Thrown for every decrypt failure. The message is deliberately generic. */
export class DecryptionError extends Error {
  constructor(
    message = 'Could not decrypt: wrong link, wrong passphrase, or the data was tampered with.',
  ) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class PayloadTooLargeError extends Error {
  constructor(size: number) {
    super(`File is too large to share (${size} bytes, max ${MAX_PLAINTEXT_BYTES}).`);
    this.name = 'PayloadTooLargeError';
  }
}

export interface EncryptOptions {
  passphrase?: string;
  /** Override scrypt cost (tests only; bounds are enforced on decrypt). */
  scrypt?: { N: number; r: number; p: number };
}

export interface EncryptResult {
  envelope: Envelope;
  /** base64url link key, to be placed in the URL fragment only. */
  linkKey: string;
}

/** Length-prefixed and zero-padded to PAD_BLOCK_BYTES to blur the exact file size. */
export function pad(data: Uint8Array): Bytes {
  const len = data.length + 4;
  const total = Math.ceil(len / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, 4);
  return out;
}

export function unpad(padded: Uint8Array): Bytes {
  if (padded.length < 4) throw new DecryptionError();
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (len > padded.length - 4) throw new DecryptionError();
  return padded.slice(4, 4 + len);
}

async function passphraseBytes(passphrase: string, k: ScryptParams): Promise<Bytes> {
  const pw = utf8Encode(passphrase.normalize('NFKC'));
  const out = await scryptAsync(pw, fromBase64Url(k.salt), { N: k.N, r: k.r, p: k.p, dkLen: 32 });
  return new Uint8Array(out);
}

async function deriveContentKey(
  linkKey: Uint8Array,
  kdf: ScryptParams | undefined,
  passphrase: string | undefined,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  let ikm: Bytes = concatBytes(linkKey);
  let salt: Bytes = new Uint8Array(0);
  if (kdf) {
    if (!passphrase) throw new DecryptionError('This link also needs a passphrase.');
    ikm = concatBytes(linkKey, await passphraseBytes(passphrase, kdf));
    salt = fromBase64Url(kdf.salt);
  }
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptPayload(
  payload: SharePayload,
  opts: EncryptOptions = {},
): Promise<EncryptResult> {
  const plain = utf8Encode(JSON.stringify({ name: payload.name, content: payload.content }));
  if (plain.length > MAX_PLAINTEXT_BYTES) throw new PayloadTooLargeError(plain.length);

  const linkKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  let kdf: ScryptParams | undefined;
  if (opts.passphrase) {
    const c = opts.scrypt ?? SCRYPT_DEFAULTS;
    kdf = { alg: 'scrypt', N: c.N, r: c.r, p: c.p, salt: toBase64Url(randomBytes(SALT_BYTES)) };
  }
  const header = { v: 1 as const, ...(kdf ? { kdf } : {}) };
  const key = await deriveContentKey(linkKey, kdf, opts.passphrase, 'encrypt');
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(envelopeAad(header)), tagLength: 128 },
    key,
    pad(plain),
  );
  return {
    envelope: {
      v: 1,
      iv: toBase64Url(iv),
      ct: toBase64Url(new Uint8Array(ct)),
      ...(kdf ? { kdf } : {}),
    },
    linkKey: toBase64Url(linkKey),
  };
}

export function needsPassphrase(envelope: Envelope): boolean {
  return envelope.kdf !== undefined;
}

export async function decryptPayload(
  envelope: unknown,
  linkKeyB64: string,
  passphrase?: string,
): Promise<SharePayload> {
  if (!validateEnvelope(envelope)) throw new DecryptionError('Malformed encrypted data.');
  let linkKey: Bytes;
  try {
    linkKey = fromBase64Url(linkKeyB64);
  } catch {
    throw new DecryptionError('The link key is malformed.');
  }
  if (linkKey.length !== KEY_BYTES) throw new DecryptionError('The link key is malformed.');

  const key = await deriveContentKey(linkKey, envelope.kdf, passphrase, 'decrypt');
  let plainPadded: Bytes;
  try {
    const pt = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: utf8Encode(envelopeAad(envelope)),
        tagLength: 128,
      },
      key,
      fromBase64Url(envelope.ct),
    );
    plainPadded = new Uint8Array(pt);
  } catch {
    throw new DecryptionError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(unpad(plainPadded)));
  } catch {
    throw new DecryptionError();
  }
  const o = parsed as Partial<SharePayload>;
  if (typeof o?.name !== 'string' || typeof o.content !== 'string') throw new DecryptionError();
  return { name: o.name, content: o.content };
}

/** SHA-256 of a revoke token; the server stores only this. */
export async function sha256B64Url(input: string): Promise<string> {
  const h = await subtle().digest('SHA-256', utf8Encode(input));
  return toBase64Url(new Uint8Array(h));
}
