# Contributing to EnvDrop

Thanks for helping! EnvDrop is small on purpose. Please keep it that way: minimal dependencies, readable code, and an honest threat model.

## Setup

```bash
git clone <your fork>
cd envdrop
npm install
npm test
```

| Command                           | What it does                                        |
| --------------------------------- | --------------------------------------------------- |
| `npm test`                        | All unit + integration tests (vitest)               |
| `npm run lint` / `npm run format` | ESLint / Prettier                                   |
| `npm run typecheck`               | `tsc` for every workspace                           |
| `npm run build`                   | Bundles the extension and dry-runs the Worker build |
| `npm run dev -w server`           | Local server on :8787 (wrangler dev)                |
| F5 in VS Code                     | Extension Development Host (see README)             |

## Where things go

- `shared/`: anything used by more than one of extension, server, web page and (future) CLI. Pure TypeScript, runs in Node, Workers and browsers. **No Node-only APIs.**
- `server/`: the HTTP handler (`app.ts`) is runtime-agnostic. Cloudflare-specific code lives in `index.ts` and `secretObject.ts` only.
- `core/`: Node-side logic shared by the extension and the CLI (no `vscode` imports), so it can be unit-tested.
- `extension/src/vscode/`: VS Code glue. Webview UI lives in `extension/media/`: `base.css` is the design system and `ui.js` holds the helpers.
- `cli/`: the `envdrop` CLI. Keep it dependency-free at runtime, because esbuild bundles it.
- `server/src/node.ts`: the self-host adapter. Keep behaviour identical to the Worker by going through `app.ts`.

UI work: keep animations subtle, respect `prefers-reduced-motion`, and use theme variables in webviews. To check a change visually, render the webview with mock data in headless Chrome. Every screenshot in `docs/screenshots` was made this way.

## Rules for security-sensitive code

1. **Never log, display or persist secret values.** That includes error messages, notifications, telemetry and test snapshots. Use `maskValue` / `maskSecret`.
2. **No new crypto.** Use WebCrypto or `@noble/*`. Any change to `shared/src/crypto.ts` or `envelope.ts` needs tests covering tampering and wrong-key cases, plus a note in the PR about compatibility with existing links.
3. **Webviews:** strict CSP with a nonce, no remote resources, `textContent` only (never `innerHTML`).
4. **New dependencies** need a justification in the PR. Prefer zero-dependency, audited packages.
5. **Fake secrets in tests** must be assembled at runtime (see `shared/test/scanner.test.ts`) so that GitHub push protection and other scanners don't flag this repo.

## Adding a secret pattern

Add a rule to `CONTENT_RULES` in [`shared/src/secretPatterns.ts`](shared/src/secretPatterns.ts) with:

- a stable `id`,
- a human-readable `name`,
- a regex without the `g`/`y` flags,
- and, if it captures a group, the group index.

Add positive and negative cases to `shared/test/scanner.test.ts`. Favour low false-positive patterns with well-known prefixes.

## Pull requests

- Keep PRs focused, with commit-sized changes and a clear message.
- CI must pass: format, lint, typecheck, tests, build, package.
- Update the README (and the threat model if anything about guarantees changes).

By contributing you agree that your contributions are licensed under the MIT License.
