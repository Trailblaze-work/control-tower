import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const stateDir = join(homedir(), '.paseo', 'voice');
export const stateFile = join(stateDir, 'state.json');
export const port = Number(process.env.PASEO_VOICE_PORT ?? 6768);
export const publicUrl = process.env.PASEO_VOICE_URL ?? `http://localhost:${port}`;

export async function loadApiKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    return (await readFile(process.env.PASEO_VOICE_KEY_FILE ?? join(homedir(), '.codex/secrets/openai_api_key'), 'utf8')).trim() || null;
  } catch { return null; }
}

export async function initializeState() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const state = { port, publicUrl, supervisorPid: Number(process.env.PASEO_VOICE_SUPERVISOR_PID) || undefined, controlToken: randomBytes(32).toString('base64url') };
  return state;
}

export async function persistState(state: { port: number; publicUrl: string; controlToken: string }) {
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await chmod(stateFile, 0o600);
}
