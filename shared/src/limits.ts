/** Limits shared by client and server so they can never drift apart. */

/** Max size of the JSON request body accepted by POST /api/secrets. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Max plaintext size the client will encrypt. Base64 inflates by ~4/3 and we pad to
 * 1 KiB buckets, so 44 KiB of plaintext stays comfortably under MAX_BODY_BYTES.
 */
export const MAX_PLAINTEXT_BYTES = 44 * 1024;

export const PAD_BLOCK_BYTES = 1024;

export const EXPIRY_OPTIONS = {
  '10m': 600,
  '1h': 3600,
  '24h': 86400,
} as const;
export type ExpiryOption = keyof typeof EXPIRY_OPTIONS;
export const ALLOWED_TTL_SECONDS: readonly number[] = Object.values(EXPIRY_OPTIONS);

export const MIN_VIEWS = 1;
export const MAX_VIEWS = 10;

/** Length (bytes) of ids, link keys and revoke tokens. */
export const ID_BYTES = 16;
export const KEY_BYTES = 32;
export const REVOKE_TOKEN_BYTES = 32;
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

/** scrypt defaults (~128 MiB, ~1s) and the bounds a decrypting client will accept. */
export const SCRYPT_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 } as const;
export const SCRYPT_BOUNDS = { minLogN: 14, maxLogN: 20, maxR: 16, maxP: 4 } as const;
