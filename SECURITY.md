# Security Policy

EnvDrop handles developers' secrets, so we take reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Use GitHub's **Private vulnerability reporting** ("Security" tab → "Report a vulnerability") on this repository, or
- email the maintainers at the address listed in the repository profile.

Please include:

- affected component (`shared`, `server`, `extension`, web page),
- version / commit,
- reproduction steps,
- the impact you believe it has.

Never include real secrets. Use obviously fake values.

What to expect:

- acknowledgement within **72 hours**,
- an initial assessment within **7 days**,
- a fix or mitigation plan for confirmed issues as quickly as severity warrants.

We will credit reporters who want to be credited.

## Scope

In scope:

- Anything that lets the server, a network attacker or a third party read plaintext or key material.
- Bypassing burn-after-read, TTL or revoke.
- Tampering that isn't detected on decrypt.
- XSS or CSP bypasses in the web page or the review webview.
- Ways the extension could leak secret values (logs, notifications, telemetry, temp files).
- Rate-limit bypasses with real impact.

Out of scope (documented limitations, see the README threat model):

- A compromised client machine or a malicious VS Code extension.
- A malicious server operator serving altered JavaScript on the browser fallback page.
- A link that is intercepted and opened before the intended recipient.
- False negatives or positives of the heuristic secret scanner (please open a normal issue or PR with a better pattern).

## Supported versions

Only the latest release of the extension and the `main` branch of the server receive security fixes.

## Design notes for reviewers

- Crypto lives in [`shared/src/crypto.ts`](shared/src/crypto.ts) (WebCrypto AES-256-GCM, scrypt from `@noble/hashes`, HKDF). There are no custom primitives.
- The server never receives the key: it lives only in the URL fragment. See [`server/src/app.ts`](server/src/app.ts).
- Atomic view counting: one Durable Object per secret, in [`server/src/secretObject.ts`](server/src/secretObject.ts).
- Secret values are never logged. ESLint forbids `console.log`, and the server logs only error class names.
