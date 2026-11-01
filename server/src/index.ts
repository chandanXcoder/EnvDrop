import { createApp, type Handler } from './app';
import { CloudflareRateLimiter } from './rateLimit';
import { DurableObjectStore, SecretObject } from './secretObject';
import { webAssets } from './web/generated/assets';

export { SecretObject };

export interface Env {
  SECRETS: DurableObjectNamespace<SecretObject>;
  RATE_LIMIT_CREATE?: RateLimit;
  RATE_LIMIT_READ?: RateLimit;
  RATE_LIMIT_REVOKE?: RateLimit;
}

let app: Handler | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    app ??= createApp({
      store: new DurableObjectStore(env.SECRETS),
      rateLimiter: new CloudflareRateLimiter({
        create: env.RATE_LIMIT_CREATE,
        read: env.RATE_LIMIT_READ,
        revoke: env.RATE_LIMIT_REVOKE,
      }),
      assets: webAssets,
    });
    return app(request);
  },
} satisfies ExportedHandler<Env>;
