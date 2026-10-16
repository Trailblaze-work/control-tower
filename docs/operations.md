# Control Tower

<p align="center"><img src="assets/tower.svg" width="176" height="176" alt="Tower logo"></p>

<p align="center"><strong>Your agents, on frequency.</strong></p>

A laptop-hosted, interruptible voice coordinator for [Paseo](https://paseo.sh). Talk through progress, blockers and decisions across your workspaces, consult the owning agents, and relay routine instructions without opening each conversation.

The Paseo sidebar opens a companion call page. Desktop calls use localhost; phone calls use an anonymous Cloudflare tunnel running on the laptop. OpenAI Realtime handles live audio over WebRTC. The plugin embeds the call page in supported web clients, with microphone delegation and an external-browser fallback. It does **not** replace Paseo’s built-in microphone/voice controls.

## Features

| Capability | Behavior |
| --- | --- |
| Live conversation | Continuous speech, interruption, microphone mute, End call and resume/reconnect. |
| Workspace-first answers | Discover relevant workspaces, read recent evidence and consult owning agents through one messaging path before relying on general knowledge. |
| Concise delivery | Outcome-first answers; silent tool use; brief attribution and uncertainty. |
| Queued coordination | Durable FIFO updates wait for idle agents, survive service restarts and can be cancelled before submission. |
| PR lookup | Attached PR numbers/URLs, workspace/worktree names, branches, paths and associated agents, with cache qualifiers. |
| Workspace changes | Voice display-title renames when enabled by the owner; reviewable creation proposals completed in Paseo. |
| Prompt refresh | Apply instructions between turns; preserve bounded text context and pending jobs when reconnecting. |
| Key configuration | Laptop-only settings form; write-only OpenAI key storage; changes apply to new calls without restart. |
| Spending | Live estimates from provider token usage, plus optional provider-reported month-to-date costs using an Admin key. |
| Diagnostics | Structured, content-free error/timing logs and request references; inspect them from settings or the CLI. |

## Requirements

- Node.js 24+ and npm.
- Paseo 0.11.2, running locally with plugins enabled. The current manifest supports `>=0.11.2 <0.12.0`.
- An OpenAI API key with access to the configured Realtime model and available API credit.
- `cloudflared` for remote phone access. No Cloudflare account, token or hosted server is required for the temporary tunnel.
- The laptop must remain awake and online. Test iPhone backgrounding, screen lock and car audio routing on your device; CarPlay/phone-call behavior is not guaranteed.

## Quick start

```sh
gh repo clone Trailblaze-work/control-tower
cd control-tower
npm ci
npm run serve
```

The service binds to `127.0.0.1:6768` and starts an anonymous HTTPS tunnel. In another terminal, generate a private call link:

```sh
npm run link
```

Open the link on your phone in Safari, allow microphone access and tap **Start conversation**. On the laptop, use the local link in the Paseo sidebar. You can interrupt the coordinator while it speaks. **Mute** disables microphone capture; **End call** stops the conversation. Closing the page disconnects its WebRTC transport, although already-submitted workspace work and queued updates may continue.

Install this checkout as a local directory plugin through [Paseo’s plugin settings](https://paseo.sh/docs/plugins), then open **Control Tower** in the sidebar. Enabling the global plugin switch is an explicit user action; automated setup must obtain authorization first. The sidebar refreshes used links within about three seconds and unused links every 45 seconds. Links are single-use, expire after one minute and establish 12-hour browser pairing.

### Configure your API key

Choose **API key, spending and diagnostics (on laptop)** in the sidebar, or run:

```sh
npm run settings
```

Open the printed private settings URL **on the laptop**. Enter your OpenAI key and save it. Saved keys are never returned by the API or passed to the voice model. The field stays blank after saving. A key entered here takes precedence over environment/key-file configuration and applies to the next call without restarting the service. Reopen a settings link after reloading that page or restarting the backend.

Alternatively, set `OPENAI_API_KEY` or point `PASEO_VOICE_KEY_FILE` at a private key file before starting the service. The legacy fallback is `~/.codex/secrets/openai_api_key`. You do not need to create that file when using the settings form.

### Background service on macOS

```sh
npm run service:install
```

This installs `~/Library/LaunchAgents/dev.paseo.voice.plist`, starts the service at login and restarts it after failure. The Node executable and checkout path are captured at installation time; reinstall the service if either moves. Other operating systems can run `npm run serve` under their own process supervisor; the included installer is macOS-only.

## Spending

The settings page displays **tracked estimated USD** for today, this month and all recorded usage, with the tracking start date and unpriced-event count. The call’s Connection details also show the latest total. Realtime `response.done` usage includes audio/text input, cached input and output tokens; the plugin applies published model prices and deduplicates event IDs. Transcription usage is recorded separately when reported by the provider.

This is a live estimate from browser-forwarded provider events, **not an invoice**. It cannot reconstruct earlier untracked calls, can miss events when a page closes or loses connectivity, and excludes workspace-agent costs, discounts and taxes. Unsupported models or inconsistent token breakdowns remain unpriced rather than using an invented rate. Current rates are pinned in `server/usage.ts` and were checked against [official OpenAI pricing](https://developers.openai.com/api/docs/pricing) on 2026-10-15.

For provider-reported costs, enter an optional **OpenAI Admin API key** and project ID in settings. The [organization Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) returns month-to-date amounts in daily buckets; the plugin caches results for five minutes. Without a project filter, totals include the whole organization. These can include other apps, may lag, and must not be added to the local estimate. The regular voice key is not an Admin key. The settings page also links to the OpenAI usage dashboard.

## How coordination works

The coordinator discovers workspaces and agents on demand through the authenticated local Paseo SDK. It treats workspace names, messages and agent reports as untrusted evidence, not instructions or authorization. Reports receive brief source/freshness qualifiers. All interactions with agents use **send_message**: questions, coordination, implementation requests and specifically authorized commands. The separate read-only consultation channel and its forced “do not change files” wrapper have been removed. Busy agents wait in the same durable queue; unavailable or permission-blocked agents are not interrupted.

`send_message` uses delegated judgment without repeated confirmation for routine work. Explicit commands carry the requested action, target repository/workspace, commit/branch where relevant, and the authorization already given by the user. The receiving agent interprets the request within its existing context and permissions; there is no question/command intent field that silently creates a second permission mode. Questions alone do not authorize unrelated changes. They enter a private durable outbox, checked every five seconds. Delivery waits for idle with no pending permission; messages for an agent are serialized. Unsent messages can be cancelled, expire after 30 minutes and retained records expire after 24 hours. Queued, accepted, waiting, completed, expired and unknown are distinct outcomes. A two-minute reply wait is not an execution timeout or failure: accepted work remains pending and the service checks its projected timeline every five seconds. Replies must match the submitted client message ID and turn; an unrelated latest reply is never substituted. After a restart, accepted messages and legacy reply timeouts resume observation without delivery replay. An interrupted submission still becomes unknown: inspect target history before retrying. Observation reads the latest 200 projected entries; if the original request is outside that window or the provider omits turn identifiers, its outcome remains unconfirmed rather than guessed. Completion means a correlated agent reply, not independent verification that the requested change succeeded.

For example, “Is the fix ready?” and “Push commit abc123 to main in the private Example/voice repository; I authorize it” both use send_message. The second request authorizes only that stated push; it does not authorize deployments or unrelated changes. A relayed explicit authorization should not be rejected solely because it arrived through the voice coordinator or require the user to leave voice mode. There is no added owner-verification ceremony beyond the workspace’s established process.

The SDK exposes `interrupt` and `steer`, but no atomic idle-only delivery operation. The plugin never knowingly sends to a busy agent and specifies `steer`; another client can still start a turn between the last idle check and send. Strict zero-impact delivery requires a daemon change or coordinated exclusive ownership. Voice interruption does not cancel already-submitted workspace work. Consequential operations retain existing permission gates and project/fleet coordination rules.

### PR mapping and workspace changes

The overview includes cached attached-PR metadata and a PR-to-workspace/agent index. Match repository/URL as well as number: multiple workspaces can own the same PR, and numbers collide across repositories. Missing metadata is unknown, not evidence that no PR exists. Worktree-name fallback to a directory basename is explicitly labelled. The current descriptor exposes one attached PR per workspace; additional PRs mentioned only in conversation require consultation.

`request_workspace_rename` requires a discovered workspace, requested title and reason. Enable **Allow voice requests to rename workspace display titles** in laptop settings to apply explicit voice rename requests directly. This defaults off on new installations, applies to all paired callers (including shared links), and can be revoked without a restart. A recent user turn is required; a startup briefing or restored history alone cannot rename anything. The server rechecks workspace identity/current name before writing, recognizes an already-applied title, and deduplicates repeated invocation IDs. An uncertain acknowledgement requires reading fresh state before retrying. When disabled, it returns a manual proposal. `request_workspace_creation` requires a discovered source workspace, title, purpose and directory/worktree choice; worktrees also require an explicit base ref and new branch name. Proposals and successful renames appear in **Workspace changes and requests**. Proposals include concrete settings and risks and are session-local drafts. Creation proposals do not mutate anything, start agents or submit fleet jobs.

Complete creation proposals and disabled-rename proposals manually in Paseo. An enabled voice title change does not rename the branch or worktree directory. Directory workspaces share existing files; worktree creation can run configured setup hooks. Direct workspace creation would need a separate owner-authentication/approval surface bound to exact arguments, fresh workspace validation, project-hook review, idempotency and uncertain-outcome reconciliation. Shared call links do not identify the owner. Never use an agent relay or an LLM-supplied approval claim to bypass this gate.

## Updates and recovery

Edit `server/voice-policy.json` to configure instructions, model, voice and output budget. Updated call pages poll every ten seconds, apply instruction/tool/budget changes between turns using `session.update`, and wait for acknowledgement. `PASEO_VOICE_MODEL` overrides the JSON model.

A model/voice change, failed update or disconnect uses **Refresh conversation** / **Resume conversation**. Handoff retains the last 40 transcript messages, up to 4,000 characters each, interrupted-speech qualifiers and pending job IDs. It does not replay old tool calls. The same tab can resume after reloading; **End call** clears saved context, while queued updates remain. All new question and command jobs use the durable outbox across backend restarts. Older already-loaded pages may still attempt the removed tool and must be refreshed; retired tool calls are rejected rather than silently converted into work. Previously queued messages retain their original text and safeguards.

```sh
# Restart the voice app while keeping the tunnel hostname.
npm run refresh

# Restart the whole supervisor and tunnel (macOS; hostname changes).
launchctl kickstart -k gui/$(id -u)/dev.paseo.voice

# Stop/unregister the service (macOS).
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/dev.paseo.voice.plist"
```

Prompt updates need no app restart. Backend code updates require app-only refresh; supervisor/startup changes require a full restart. Older call pages need reloading to acquire new browser code. A full anonymous tunnel replacement needs a fresh sidebar link, because cookies/storage cannot migrate between hostnames. A stable named tunnel is the fallback for a persistent origin. Reconnection restores text context, not exact audio/internal model state; iOS may require another microphone/playback tap.

## Troubleshooting and diagnostics

Local hosting still involves several boundaries: browser → localhost or Cloudflare → voice backend → Paseo WebSocket daemon, plus browser → OpenAI for audio. A generic loading failure does not establish which boundary failed.

```sh
npm run diagnostics
```

Or open **Diagnostics** in laptop settings. Private structured logs live at `~/.paseo/voice/diagnostics.jsonl`, with one rotated file after approximately 2 MB. They include timestamps, boot IDs, safe request references, API/tool names, RPC stages, duration, status, connection transitions and classified errors. No credentials, conversation content, raw error messages or audio are logged. Browser events buffer briefly in memory if the server is unreachable; failures before pairing or during a complete disconnect may not reach server logs.

- **Call session lost:** often follows a backend restart while direct audio remains connected. Tap Refresh conversation. This is distinct from a laptop/network failure.
- **401 / expired pairing:** open a fresh sidebar link. A settings page additionally needs a fresh owner settings link.
- **Paseo disconnected:** confirm the daemon is running. The voice service reconnects independently; do not restart unrelated agents to diagnose it.
- **RPC timeout / unavailable agent:** inspect the request reference and `paseo_read` stage in diagnostics. Do not blindly retry messages whose delivery is uncertain.
- **Unreadable HTTP response:** the temporary tunnel may be down or returning an edge error; use the current sidebar link or localhost.
- **Provider rejection:** check key/model access, credit and rate limits. Audio generation is an external API even when the coordinator is local.
- **Empty recent activity:** the current bounded page may contain tools rather than prose; diagnostics distinguish this from a read error.

The intermittent failure that motivated these diagnostics was not reproduced during local investigation; workspace overview/history reads succeeded. A confirmed misleading-error path was corrected, and diagnostics now make future occurrences attributable instead of reporting every failure as an unreachable laptop.

## Mobile reception and CarPlay

Brief WebRTC disconnects now get an eight-second grace period so the existing connection can recover. A failed/closed voice connection then reconnects automatically with bounded backoff (2, 4, 8, then up to 15 seconds between attempts). Network-online and page-visible events can accelerate recovery. There are at most eight attempts and a two-minute recovery window; after that capture is released and **Resume conversation** is available. **End call** and closing the page cancel recovery immediately.

During recovery the plugin retains the live microphone track, mute state, and current audio element rather than deliberately ending the iPhone audio session. This is intended to reduce avoidable CarPlay hangups. A replacement WebRTC connection gets bounded transcript/job context, including interrupted speech, without replaying workspace commands. Audio spoken while disconnected is not buffered for later delivery. A new provider session can incur additional context-processing costs.

This repairs the app's confirmed hangup path: a logged disconnect on 2026-10-15 transitioned to failed about ten seconds later, and the old handler stopped all microphone tracks instead of recovering. Browser tests simulate transient disconnects, offline/online transitions, a failed reconnect attempt, mute preservation, recovery expiry and explicit End cancellation. Physical iPhone/CarPlay behavior still needs a real-device retest.

When the browser supports the Media Session `hangup` action, the page registers it and `stop`, routing both through End call. It publishes generic call metadata/microphone state and clears its handlers on exit. When `hangup` is rejected, the page leaves native browser command handling, metadata and microphone state alone instead of registering only `stop`. WebKit's [Media Session implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.cpp) gates `hangup` separately; successful registration of `stop` is insufficient evidence of CarPlay call-button support.

A real-device regression test loaded the current page and logged `hangup: unsupported`, `stop: registered`, no delivered system action, and successful microphone cleanup after the page's End button. A report that native hangup worked before recovery hardening suggests a regression, but the logs do not identify its exact native event. The fallback now avoids custom control takeover on that browser. It also respects capture ending: an `ended` microphone track ends the call with saved context and requires an explicit **Resume conversation** tap. Recovery never automatically reopens ended capture. Temporary track mute, playback pause and audio interruption remain nonterminal, and network-only drops still recover with a live microphone. Native CarPlay behavior requires another device test; these changes do not establish a confirmed physical-button fix.

Check **Connection details → Car controls** for the selected mode and **Page revision** to verify a reload. Diagnostics record action support/receipt, ephemeral page ID and script revision, audio state, page exit, End cleanup, microphone mute/unmute/end, and changed capture-state flags (live=1, muted=2, enabled=4, speaker paused=8). They contain no audio, device names or transcript. Up to 30 events buffer in page memory offline, with original event times; delivery is not guaranteed if the page is closed. Submissions are capped at 120 per minute per paired browser. Reload the page after a browser-code update; prompt refresh cannot replace JavaScript already loaded. Use the page's End control when safe if native hangup still fails. Guaranteed native call-control integration may require platform support beyond this companion page.

Safari/iOS may suspend the page, end capture or require a playback/microphone gesture. The app detects ended capture and audio-session interruption where supported, but cannot guarantee native CarPlay call continuity or background scheduling. If permissions/playback require a gesture, use the displayed Resume control when safe. The fallback opens a new provider connection with saved text, rather than calling `restartIce()` without the required peer renegotiation. See [WebRTC disconnect states](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState), [ICE restart requirements](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce), and [OpenAI WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc).

## Configuration and architecture

| Setting | Default |
| --- | --- |
| `PASEO_VOICE_PORT` | `6768` (loopback only) |
| `PASEO_VOICE_DAEMON_URL` | `ws://127.0.0.1:6767/ws` |
| `PASEO_VOICE_MODEL` | JSON policy model: `gpt-realtime-2.1` |
| `OPENAI_API_KEY` | Environment fallback when no key is saved in settings |
| `PASEO_VOICE_KEY_FILE` | `~/.codex/secrets/openai_api_key` |
| `CLOUDFLARED_BIN` | `/opt/homebrew/bin/cloudflared`; override on other installations |
| `CHROME_BIN` | Test browser executable override |

`npm start` serves localhost only; `npm run serve` supervises the app and tunnel. Voice defaults to `marin`, with `gpt-4o-mini-transcribe` for input transcripts. All model calls go directly to OpenAI, not OpenRouter. The process inherits environment settings when started; LaunchAgent environments may differ from your shell.

- `client/`, `index.*`, `shared/`: Paseo sidebar, plugin entry points and typed RPCs.
- `server/http.ts`: authenticated call/API boundary and local settings controls.
- `server/coordinator.ts`, `paseo.ts`, `outbox.ts`: workspace tools, directory/evidence and queued delivery.
- `server/web/`: call/settings pages, WebRTC, prompt updates and bounded handoff.
- `server/settings.ts`, `usage.ts`, `telemetry.ts`: private keys, measured-usage estimates and diagnostics.
- `scripts/`: links, service installation, refresh, diagnostics and optional live smoke test.

Runtime files live outside the checkout in `~/.paseo/voice/` (directory 0700, files 0600): service state/logs, browser pairing, outbox, settings, token-usage records and sanitized diagnostics. No raw audio is recorded locally. See [SECURITY.md](../SECURITY.md) for shared-link permissions and retention details.

## Development

```sh
npm run typecheck
npm run check:web
npm test
```

Tests cover authentication/ownership, origin restrictions, discovery, queue ordering/recovery, PR mappings, gated title renames and non-executing creation proposals, error classification, key privacy, cost arithmetic and browser refresh/settings flows. They use simulated media/provider responses and do not incur model charges or message real workspace agents. Hosted GitHub Actions runs these checks with Node 24 and Chromium.

See [CONTRIBUTING.md](../CONTRIBUTING.md). `npm run smoke:live` is an explicit, billable integration check against real services; it is not part of CI. This repository is public. No open-source license has been selected; public visibility alone does not grant redistribution or other license rights.

## Branding and upgrades

Control Tower was previously called Tower / Paseo Voice. The plugin ID is now `control-tower`; remove the old plugin entry and install this checkout again if upgrading. Existing installations retain `~/.paseo/voice/`, `PASEO_VOICE_*`, the `paseo_voice` cookie and the browser checkpoint key so keys, spending records and resumable calls are preserved. The existing macOS service label also remains `dev.paseo.voice`; these compatibility identifiers are intentional. No daemon restart is needed to reload the plugin.

The [vector logo](../assets/tower.svg) was generated using Recraft V4.1 Pro Vector through OpenRouter. Its [branding notes](../assets/BRAND.md) record the model and prompt. The PNG sidebar icon is rendered from that same SVG for native image compatibility. OpenRouter is used only to create the branding; running Control Tower still requires an OpenAI key for live calls.

## Automatic setup and embedding

After installing dependencies, `npm run setup` detects Paseo, checks that the user has enabled plugins, installs this directory plugin, starts the macOS background service if needed and opens local key settings. It reuses a healthy service. `--check` is read-only; `--no-open` skips opening the browser. Missing cloudflared can be downloaded from Cloudflare's official GitHub release after a separate terminal confirmation; its SHA-256 digest is checked before installation. Linux users can continue using `npm run serve`.

Web clients render a stable iframe in the plugin panel. The frame URL is captured once so periodic link refreshes do not restart an ongoing call. Only parent origins registered through the authenticated local control API are allowed to frame `/embed`; the ordinary call page and settings still deny framing. Calls in the iframe use a 12-hour call-scoped bearer stored in its origin's sessionStorage because Safari can block third-party cookies. This bearer cannot access owner settings or billing. Native clients and restricted browsers use the external link. Embedded microphone/CarPlay operation still needs device verification.
