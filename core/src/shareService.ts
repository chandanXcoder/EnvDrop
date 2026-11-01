import {
  buildShareLink,
  decryptPayload,
  encryptPayload,
  type EncryptOptions,
  type Envelope,
  parseShareLink,
  type SharePayload,
} from '@envdrop/shared';
import { ApiClient, ApiClientError, type FetchLike } from './apiClient';

export interface ShareOptions {
  serverUrl: string;
  name: string;
  content: string;
  ttlSeconds: number;
  maxViews: number;
  passphrase?: string;
  fetchImpl?: FetchLike;
  /** tests only */
  scrypt?: EncryptOptions['scrypt'];
}

export interface ShareResult {
  link: string;
  id: string;
  origin: string;
  revokeToken: string;
  expiresAt: number;
}

export async function share(opts: ShareOptions): Promise<ShareResult> {
  const client = new ApiClient(opts.serverUrl, opts.fetchImpl);
  const { envelope, linkKey } = await encryptPayload(
    { name: opts.name, content: opts.content },
    { passphrase: opts.passphrase || undefined, scrypt: opts.scrypt },
  );
  const res = await client.create({
    envelope,
    ttlSeconds: opts.ttlSeconds,
    maxViews: opts.maxViews,
  });
  return {
    link: buildShareLink(client.origin, res.id, linkKey),
    id: res.id,
    origin: client.origin,
    revokeToken: res.revokeToken,
    expiresAt: res.expiresAt,
  };
}

export interface FetchedShare {
  origin: string;
  envelope: Envelope;
  key: string;
  viewsLeft: number;
  expiresAt: number;
}

/** Downloads (and thereby consumes one view of) a shared secret. Does not decrypt. */
export async function fetchShare(link: string, fetchImpl?: FetchLike): Promise<FetchedShare> {
  const parsed = parseShareLink(link);
  if (!parsed) {
    throw new ApiClientError(
      'That does not look like a complete EnvDrop link (https://host/s/<id>#<key>). Make sure the part after # was copied.',
    );
  }
  const client = new ApiClient(parsed.origin, fetchImpl);
  const res = await client.get(parsed.id);
  return {
    origin: client.origin,
    envelope: res.envelope,
    key: parsed.key,
    viewsLeft: res.viewsLeft,
    expiresAt: res.expiresAt,
  };
}

export function decryptShare(fetched: FetchedShare, passphrase?: string): Promise<SharePayload> {
  return decryptPayload(fetched.envelope, fetched.key, passphrase);
}
