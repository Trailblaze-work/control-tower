import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
const stateSchema = z.object({ port: z.number().int().min(1024).max(65535), controlToken: z.string().min(32) });
async function controlRequest(path: 'launch' | 'launch-status', body?: unknown) {
  const state = stateSchema.parse(JSON.parse(await readFile(join(homedir(), '.paseo/voice/state.json'), 'utf8')));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${state.controlToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error('Paseo Voice is not running. Start its local service on your laptop.');
    return response.json();
  } finally { clearTimeout(timeout); }
}
export async function launchVoice() {
  return z.object({ url: z.string().url(), localUrl: z.string().url(), settingsUrl: z.string().url() }).parse(await controlRequest('launch'));
}
export async function launchStatus(input: { url: string; localUrl: string }) {
  return z.object({ refresh: z.boolean() }).parse(await controlRequest('launch-status', {
    ticket: new URL(input.url).hash.slice(1), localTicket: new URL(input.localUrl).hash.slice(1),
  }));
}
