/**
 * Self-hosted Node.js adapter (used by the Docker image). Runs the same fetch handler
 * as the Worker, backed by the in-memory store: secrets live only in RAM and vanish on
 * restart, which suits short-lived, burn-after-read data. Run a single instance.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createApp, type WebAssets } from './app';
import { MemoryStore } from './memoryStore';
import { MemoryRateLimiter } from './rateLimit';

export interface NodeServerOptions {
  port?: number;
  host?: string;
  /** Trust X-Forwarded-For from a reverse proxy (only enable behind one). */
  trustProxy?: boolean;
  /** Public origin (e.g. https://envdrop.example.com) used to build request URLs. */
  publicUrl?: string;
  assets?: WebAssets;
  maxEntries?: number;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function startNodeServer(opts: NodeServerOptions = {}): Promise<Server> {
  const store = new MemoryStore(opts.maxEntries);
  const app = createApp({ store, rateLimiter: new MemoryRateLimiter(), assets: opts.assets });
  const sweeper = setInterval(() => store.sweep(), 30_000);
  sweeper.unref();
  const base = opts.publicUrl ? new URL(opts.publicUrl).origin : undefined;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        // Clients must not be able to choose their own rate-limit identity.
        if (k === 'cf-connecting-ip' || k === 'x-real-ip') continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      headers.set('x-real-ip', clientIp(req, Boolean(opts.trustProxy)));
      const origin = base ?? `http://${req.headers.host ?? 'localhost'}`;
      const method = req.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const request = new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        // @ts-expect-error: Node's fetch requires duplex for streaming bodies
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await app(request);
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      if (response.body && method !== 'HEAD') {
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Internal error"}');
    }
  });
  server.on('close', () => clearInterval(sweeper));
  return new Promise((resolve) =>
    server.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => resolve(server)),
  );
}
