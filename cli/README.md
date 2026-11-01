# envdrop (CLI)

Share `.env` files **end-to-end encrypted** with links that expire and burn after reading. This is the command-line companion to the [EnvDrop VS Code extension](https://github.com/chandanXcoder/EnvDrop).

```bash
npx envdrop share .env --expiry 1h --views 1 --qr
npx envdrop pull                 # paste the link when asked
npx envdrop revoke [id|--all]
npx envdrop scan --staged        # exit 1 on staged .env files / secrets
npx envdrop hook install         # git pre-commit hook
npx envdrop example              # .env → .env.example (values stripped)
npx envdrop check                # missing keys vs .env.example
```

How it works:

- The file is encrypted locally with AES-256-GCM.
- Only ciphertext reaches the server.
- The key travels in the link's `#fragment`.
- With `--passphrase`, the recipient needs both the link and the passphrase.

Configuration:

- **Server:** `--server <url>` or `ENVDROP_SERVER`.
- **Self-hosting:** see the main repository (Cloudflare Workers or Docker).

Read the [threat model](https://github.com/chandanXcoder/EnvDrop#threat-model) before relying on it. MIT licensed.
