# EnvDrop

**Share `.env` files from VS Code, end-to-end encrypted, with expiring, burn-after-read links.** No more pasting secrets into WhatsApp, Slack or email.

EnvDrop also adds guardrails that stop accidental leaks:

- a `.gitignore` check before you share,
- a masked, key-by-key diff before anything is written on pull,
- a warning when an env file or a likely secret is staged for commit.

> EnvDrop is end-to-end encrypted with expiring links. It is not "100% secure". Read the [threat model](#threat-model) to see exactly what it does and doesn't protect against.

<!-- GIF placeholders: record these, save them under docs/gifs/, and uncomment.
![Share a .env in one click](docs/gifs/share.gif)
![Pull with a masked diff](docs/gifs/pull.gif)
![Staged secret warning](docs/gifs/precommit.gif)
-->

> 🎬 _Demo GIFs coming soon: share in one click · pull with a masked diff · staged-secret warning._

---

## How it works

```
 Sender (VS Code)                                  Receiver (VS Code or browser)
 ┌──────────────────────────┐                      ┌──────────────────────────────┐
 │ pick file → gitignore ✓  │                      │ paste link → GET blob        │
 │ AES-256-GCM(random key)  │   POST ciphertext    │ key from #fragment (+pass)   │
 │ link = /s/<id>#<key> ────┼──► ┌────────────┐ ◄──┤ decrypt → masked diff/merge  │
 │ SecretStorage: revoke tok│    │ Worker API │    │ backup → write .env          │
 └──────────────────────────┘    └─────┬──────┘    └──────────────────────────────┘
                                       │ one Durable Object per secret
                         { ciphertext, viewsLeft, expiresAt, sha256(revokeToken) } + TTL alarm
```

1. The extension generates a random 256-bit key and encrypts the file, including its filename, with **AES-256-GCM** (WebCrypto). The plaintext is padded to 1 KiB buckets to blur its size.
2. Only the ciphertext is uploaded. The key goes into the URL **fragment** (`https://host/s/<id>#<key>`). Browsers and HTTP clients never send fragments to servers.
3. The server stores the blob with a TTL (10 min / 1 h / 24 h) and a view count (default 1). Each `GET` atomically consumes a view, and the blob is deleted at 0 views or at expiry.
4. **Optional passphrase:**
   - `contentKey = HKDF-SHA256(linkKey ‖ scrypt(passphrase))`.
   - The recipient needs **both** the link and the passphrase.
   - The server can't brute-force the passphrase offline, because it never has the link key.
5. The sender can **revoke** a link at any time. The revoke token stays in VS Code SecretStorage (your OS keychain), and the server stores only its SHA-256 hash.

## Features (Phase 1)

|                           |                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EnvDrop: Share .env**   | Command Palette, right-click a `.env*` file, or the `$(lock) EnvDrop` status bar item. Pick file → expiry → max views → optional passphrase. The link is copied to your clipboard and a notice says so.                                                                                                                                                                |
| **EnvDrop: Pull .env**    | Paste the link (it's pre-filled if it's already on your clipboard). You get a warning if the link points at a server other than yours. Then the file is decrypted and a masked review opens.                                                                                                                                                                           |
| **Masked review**         | Shows added / changed / only-in-local / unchanged keys. Values are always `••••••••`. **Reveal** shows one value for 10 s. Apply the selected keys (merge) or replace the whole file. The old file is backed up as `.env.backup`, which is gitignored automatically.                                                                                                   |
| **.gitignore check**      | Runs on share and once on workspace open (dismissible). It uses `git check-ignore` and also detects env files that are already **tracked**. Without git, it falls back to a pure-JS parser of nested `.gitignore` files. One click adds the file to `.gitignore`.                                                                                                      |
| **Staged-secret warning** | Uses the built-in Git extension. It flags staged `.env*` (not `.env.example`/`.sample`/`.template`), `*.pem`/`*.key`, `id_rsa`, `credentials.json`… and scans staged diffs for AWS, GitHub, Stripe, Slack, Google, OpenAI and Anthropic keys, private-key headers, and high-entropy `SECRET=...` assignments. It shows only the file, line, type and a masked preview. |
| **EnvDrop: Revoke link**  | Lists links created on this machine. Revoke one or all.                                                                                                                                                                                                                                                                                                                |

### Settings

| Setting                            | Default                               |                                                              |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `envdrop.serverUrl`                | `https://envdrop.example.workers.dev` | Server used for sharing. **Change this to your deployment.** |
| `envdrop.defaultExpiry`            | `1h`                                  | `10m`, `1h` or `24h`                                         |
| `envdrop.defaultMaxViews`          | `1`                                   | 1–10                                                         |
| `envdrop.checkGitignoreOnOpen`     | `true`                                |                                                              |
| `envdrop.precommit.enabled`        | `true`                                |                                                              |
| `envdrop.precommit.scanContent`    | `true`                                | Scan staged diffs, not just filenames                        |
| `envdrop.precommit.ignorePatterns` | `[]`                                  | gitignore-style patterns to skip, e.g. `test/fixtures/**`    |

To silence one line, put `envdrop:allow` in a comment on that line.

---

## Repository layout

```
shared/     crypto, envelope format, .env parser + diff/merge, secret patterns + scanner (no deps except @noble/hashes)
server/     Cloudflare Worker: API, Durable Object store, rate limiting, /s/:id browser decrypt page
extension/  VS Code extension: core/ (vscode-free, unit-tested) + vscode/ (commands, webview, git watcher)
```

## Development

Requirements: Node 20+, npm 10+, git.

```bash
npm install            # npm 11 may ask you to approve install scripts for esbuild/workerd (already listed in package.json allowScripts)
npm test               # vitest: crypto, parser/diff, scanner, gitignore, API, share→pull integration
npm run lint && npm run typecheck && npm run build
```

### Run and debug the extension

1. Start a local server: `npm run dev -w server` (wrangler dev on `http://localhost:8787`).
2. Open this repo in VS Code and press **F5** ("Run EnvDrop extension"). The workspace setting `.vscode/settings.json` already points `envdrop.serverUrl` to `http://localhost:8787`.
3. In the Extension Development Host:
   - Open a folder that contains a `.env`.
   - Run **EnvDrop: Share .env** and choose your options.
   - Run **EnvDrop: Pull .env** in another folder.

Manual test checklist:

- Share a non-gitignored `.env` → warning with _Add to .gitignore / Share anyway / Cancel_.
- Pull into a folder with a different `.env` → masked review; Reveal hides after 10 s; the backup is created and gitignored.
- Pull the same 1-view link twice → the second time says _expired or already viewed_.
- `git add .env` → a staged-secret warning appears; _Unstage file_ unstages it.
- Stage a file containing a fake token, e.g. `ghp_` + 36 alphanumerics → the warning shows the line number and a masked value.

### Deploy the backend (Cloudflare Workers)

```bash
cd server
npx wrangler login
npm run deploy         # builds the web page, then `wrangler deploy`
```

This uses SQLite-backed Durable Objects (available on the Workers Free plan) and the Workers Rate Limiting binding. Both are configured in [`server/wrangler.toml`](server/wrangler.toml). After deploying:

- Set `envdrop.serverUrl` to your `https://envdrop.<you>.workers.dev` URL, or to a custom domain.
- Change the default in `extension/package.json` and `extension/src/vscode/config.ts` before publishing.

Logging: the server never logs request bodies, and `[observability]` is disabled in `wrangler.toml`. Cloudflare still processes request metadata (IP, URL path containing the id) as your infrastructure provider.

### API

| Method   | Path               |                                                                                                                                                  |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/secrets`     | `{ envelope, ttlSeconds ∈ {600, 3600, 86400}, maxViews 1–10 }`, ≤ 64 KB, `Content-Type: application/json` → `201 { id, revokeToken, expiresAt }` |
| `GET`    | `/api/secrets/:id` | Consumes one view → `200 { envelope, viewsLeft, expiresAt }`, or `404` (unknown, expired, burned and revoked all look identical)                 |
| `DELETE` | `/api/secrets/:id` | `Authorization: Bearer <revokeToken>` → `204` / `404`                                                                                            |
| `GET`    | `/s/:id`           | Static browser decrypt page. It fetches the blob only after you click **Decrypt**, so chat link previews can't burn the view.                    |

Responses carry `Cache-Control: no-store`, HSTS, a strict CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. There are no CORS headers, and `429` is returned when the per-IP rate limit is exceeded.

---

## Threat model

### What EnvDrop protects against

- **The server operator (or a breach of the server) reading your secrets.** The server only ever sees ciphertext, because the key lives in the URL fragment. The filename is encrypted too.
- **Network eavesdroppers.** TLS, plus end-to-end encryption on top.
- **Secrets lingering in chat history, email archives or backups.** Links expire (max 24 h) and burn after N views. A link pasted in Slack becomes useless once it has been opened or has expired.
- **Tampering with stored blobs.** AES-GCM authentication fails on any change, and the KDF parameters are bound as associated data, so a passphrase requirement can't be stripped.
- **Someone who only has the link,** when you set a passphrase. Send the passphrase over a different channel.
- **Link-preview bots burning your link.** The web page doesn't fetch the blob until a human clicks.
- **Accidentally committing `.env`.** The gitignore check runs on share and on open, and you're warned about staged env files or secrets.

### What EnvDrop does NOT protect against

- **A compromised sender or receiver machine.** Malware, a malicious VS Code extension, or someone with access to your disk or clipboard can read the `.env` before encryption or after decryption.
- **A malicious or compromised server on the web fallback page.** The `/s/:id` page's JavaScript is served by the same server that stores the ciphertext. A malicious operator could serve altered JS that sends the key home. **The VS Code extension doesn't have this problem**, because its decryption code ships with the extension rather than coming from the server. For sensitive material, ask recipients to use the extension.
- **A link leaked or intercepted before the intended recipient opens it.** Whoever opens it first gets the secret. Burn-after-read makes this _detectable_, because the real recipient gets "already viewed", but it can't prevent it. Use a passphrase sent over a separate channel, and revoke when in doubt.
- **Weak passphrases,** against someone who also holds the link. scrypt (N=2¹⁷) slows guessing; it can't make `password1` strong.
- **Clipboard managers, terminal or browser history, and screenshots** that capture the link.
- **Metadata.** The server (and Cloudflare) see IP addresses, timing, view counts and an approximate size (padded to 1 KiB).
- **What the recipient does next.** After decryption, the file is plaintext on their disk.
- **A malicious `.env` from a sender you shouldn't trust.** Env files can change program behaviour (e.g. `NODE_OPTIONS`). Pull shows every key before writing and warns about unfamiliar servers.
- **Commits made outside VS Code, or ignored warnings.** The staged-secret warning is a _warning_ inside VS Code, not a git hook, and its patterns are heuristics. Use a dedicated scanner (e.g. gitleaks) in CI as well.
- **Secrets already pushed.** If a secret was ever committed and pushed, rotate it. Removing the file doesn't remove it from history.

### Crypto summary

|                |                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Cipher         | AES-256-GCM (WebCrypto), 96-bit random IV, 128-bit tag                                                     |
| Link key       | 256 bits from `crypto.getRandomValues`, base64url in the URL fragment                                      |
| Passphrase KDF | scrypt (N=2¹⁷, r=8, p=1, 16-byte salt) via `@noble/hashes`, combined with the link key through HKDF-SHA256 |
| AAD            | version + KDF parameters                                                                                   |
| Padding        | length-prefixed, zero-padded to 1 KiB                                                                      |
| Revoke tokens  | 256-bit random; the server stores SHA-256 and compares in constant time                                    |
| IDs            | 128-bit random                                                                                             |

No custom cryptographic primitives are used.

---

## Packaging and publishing to the VS Code Marketplace

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and a Personal Access Token in Azure DevOps with the **Marketplace → Manage** scope.
2. In `extension/package.json`:
   - Set `publisher` (currently the placeholder `your-publisher`) and `repository.url`.
   - Add a 128×128 `icon`.
   - Change the default `envdrop.serverUrl` to your deployed server, and update `DEFAULT_SERVER_URL` in `extension/src/vscode/config.ts` to match.
3. Package and test locally:
   ```bash
   npm run package -w extension          # → extension/dist/envdrop.vsix
   code --install-extension extension/dist/envdrop.vsix
   ```
4. Publish:
   ```bash
   cd extension
   npx vsce login <publisher>
   npm run publish                       # = esbuild --production + vsce publish --no-dependencies
   ```
   `--no-dependencies` is correct here: esbuild bundles everything into `dist/extension.js`, and `.vscodeignore` keeps only the bundle, the webview `media/`, the README, the LICENSE and the CHANGELOG.
5. Optionally, also publish to Open VSX (`npx ovsx publish dist/envdrop.vsix -p <token>`) for VSCodium and Cursor users.

## Roadmap

- **Phase 2:** generate `.env.example`, check for missing keys against `.env.example`, a richer multi-environment picker.
- **Phase 3:** a CLI (`npx envdrop share / pull`, which could also install a real git pre-commit hook), QR codes for links, self-hosting via Docker (Node + the existing `MemoryStore`/Redis).

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
