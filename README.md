# Control Tower

<p align="center"><img src="assets/tower.svg" width="160" alt="Control Tower logo"></p>

**Your agents, on frequency.** Talk through your Paseo workspaces, hear what matters, make decisions and send instructions—all in one interruptible voice conversation.

Runs on your laptop. Works on desktop and phone. No hosted server or Cloudflare account required.

## Get started

Requires Paseo 0.11.2, Node 24+, macOS for automatic setup, and an OpenAI API key.

```sh
git clone https://github.com/Trailblaze-work/control-tower.git
cd control-tower
npm ci
npm run setup
```

Setup installs the plugin, starts the background service and opens key settings. It offers to download the official Cloudflare helper if needed. Enter your key, then choose **Control Tower** in Paseo’s sidebar. On web clients the call opens in the panel; an external-browser link is available for restricted devices.

## What it does

- Summarizes relevant workspace activity and decisions with clear source qualifiers.
- Queues questions and authorized instructions until agents are idle.
- Supports interruption, mute, reconnect, and resumable conversations.
- Shows estimated spending; keys stay on your laptop.

Shared call links give access to your workspace coordinator and use your API account. Share carefully. The laptop must stay awake and online; iPhone backgrounding and CarPlay controls still need device testing.

[Setup, troubleshooting and architecture](docs/operations.md) · [Security](SECURITY.md) · [Development](CONTRIBUTING.md) · [Logo](assets/BRAND.md)

[MIT license](LICENSE)
