import { isValidId } from './envelope';

export interface ParsedLink {
  /** e.g. https://envdrop.example.workers.dev */
  origin: string;
  id: string;
  /** base64url link key from the fragment */
  key: string;
}

export function buildShareLink(serverUrl: string, id: string, key: string): string {
  const base = new URL(serverUrl);
  return `${base.origin}/s/${id}#${key}`;
}

/** Parses `https://host/s/<id>#<key>`. Returns undefined for anything else. */
export function parseShareLink(input: string): ParsedLink | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    return undefined;
  }
  const m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const key = url.hash.replace(/^#/, '');
  if (!m || !isValidId(m[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return undefined;
  return { origin: url.origin, id: m[1]!, key };
}

export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
