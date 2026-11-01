/** Wire types shared by the extension, server and web page. */

export interface ScryptParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64url salt */
  salt: string;
}

/** Everything the server ever stores. Contains no plaintext and no key material. */
export interface Envelope {
  v: 1;
  /** base64url 12-byte IV */
  iv: string;
  /** base64url AES-256-GCM ciphertext with the 16-byte tag appended */
  ct: string;
  /** Present when a passphrase is also required. */
  kdf?: ScryptParams;
}

/** The decrypted content. Filename is inside the ciphertext so the server never sees it. */
export interface SharePayload {
  name: string;
  content: string;
}

export interface CreateSecretRequest {
  envelope: Envelope;
  ttlSeconds: number;
  maxViews: number;
}

export interface CreateSecretResponse {
  id: string;
  revokeToken: string;
  /** epoch milliseconds */
  expiresAt: number;
}

export interface GetSecretResponse {
  envelope: Envelope;
  viewsLeft: number;
  expiresAt: number;
}

export interface ApiError {
  error: string;
}
