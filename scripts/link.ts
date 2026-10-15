import { readFile } from 'node:fs/promises';
import { stateFile } from '../server/config.ts';
const state = JSON.parse(await readFile(stateFile, 'utf8')) as { port: number; controlToken: string };
const response = await fetch(`http://127.0.0.1:${state.port}/api/launch`, { method: 'POST', headers: { Authorization: `Bearer ${state.controlToken}` } });
if (!response.ok) throw new Error('Voice service unavailable. Run npm start first.');
console.log((await response.json() as { url: string }).url);
