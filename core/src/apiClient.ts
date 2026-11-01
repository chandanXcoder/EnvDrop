import type {
  ApiError,
  CreateSecretRequest,
  CreateSecretResponse,
  GetSecretResponse,
} from '@envdrop/shared';
import { isLocalHost, validateEnvelope } from '@envdrop/shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const TIMEOUT_MS = 15_000;

/** Validates and normalises a server URL to its origin. Only https (or http on localhost). */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiClientError(`Invalid EnvDrop server URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new ApiClientError(
      'EnvDrop server URL must use https:// (http is allowed only for localhost).',
    );
  }
  return url.origin;
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new ApiClientError(
      `Request to EnvDrop server ${reason}. Check envdrop.serverUrl and your connection.`,
    );
  }
}

async function errorFrom(res: Response): Promise<ApiClientError> {
  let msg = `Server responded ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (typeof body.error === 'string') msg = body.error.slice(0, 200);
  } catch {
    /* ignore */
  }
  if (res.status === 404) msg = 'This link has expired, was revoked, or was already viewed.';
  if (res.status === 429) msg = 'Rate limited by the EnvDrop server. Try again in a minute.';
  return new ApiClientError(msg, res.status);
}

export class ApiClient {
  readonly origin: string;
  constructor(
    serverUrl: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {
    this.origin = normalizeServerUrl(serverUrl);
  }

  async create(req: CreateSecretRequest): Promise<CreateSecretResponse> {
    const res = await call(this.fetchImpl, `${this.origin}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (res.status !== 201) throw await errorFrom(res);
    const body = (await res.json()) as CreateSecretResponse;
    if (typeof body.id !== 'string' || typeof body.revokeToken !== 'string') {
      throw new ApiClientError('Unexpected response from EnvDrop server.');
    }
    return body;
  }

  async get(id: string): Promise<GetSecretResponse> {
    const res = await call(this.fetchImpl, `${this.origin}/api/secrets/${encodeURIComponent(id)}`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) throw await errorFrom(res);
    const body = (await res.json()) as GetSecretResponse;
    if (!validateEnvelope(body.envelope))
      throw new ApiClientError('Server returned malformed data.');
    return body;
  }

  /** Returns false if the secret was already gone. */
  async revoke(id: string, revokeToken: string): Promise<boolean> {
    const res = await call(this.fetchImpl, `${this.origin}/api/secrets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${revokeToken}` },
    });
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    throw await errorFrom(res);
  }
}
