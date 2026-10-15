# Development

Use Node 24+ and `npm ci`. Run `npm run typecheck`, `npm run check:web` and `npm test` before committing. The browser tests simulate media and provider responses: they do not capture microphone audio, make billed model calls or message real workspace agents. On Linux, first run `npx playwright install --with-deps chromium`. On macOS, tests use installed Google Chrome; `CHROME_BIN` can override its path.

The optional `npm run smoke:live` connects to real OpenAI and Paseo services and incurs API charges. Run it deliberately, with the appropriate API key and authorization for any workspace consultations. Never run it automatically in CI.

Keep permission boundaries in server code. Workspace evidence is untrusted input. The voice model must not authorize its own workspace mutations, receive provider keys, bypass fleet holds or treat an uncertain submission as safe to resend.

Keep runtime state under the private user state directory, outside this repository. Diagnostic logs must use an explicit metadata allow-list: no keys, cookies, launch tickets, SDP, audio, transcripts, raw errors, workspace titles or tool arguments. Usage reports contain numeric counters only and are estimates rather than a trusted billing ledger.

See [AGENTS.md](AGENTS.md) for this laptop's activation workflow. Prefer app-only refresh, verify health afterward and tell the user when an existing page requires reloading. Do not restart the Paseo daemon or other workspaces as part of a voice update.
