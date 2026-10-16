import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Access {
  private tickets = new Map<string, number>();
  private sessions = new Map<string, number>();
  private path?: string;
  private writes = Promise.resolve();
  constructor(path?: string) { this.path = path; }
  async load() {
    if (!this.path) return;
    const raw = await readPrivateJson(this.path);
    if (raw === undefined) return;
    const values = z.array(z.tuple([z.string(), z.number()])).max(10000).parse(raw);
    this.sessions = new Map(values.filter(([, expiry]) => expiry > Date.now()));
  }
  persist() {
    if (!this.path) return Promise.resolve();
    const path = this.path; const values = [...this.sessions.entries()];
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(path, values));
    return this.writes;
  }
  ticket(now = Date.now()) {
    this.prune(now);
    const token = randomBytes(24).toString('base64url');
    this.tickets.set(token, now + 60_000);
    return token;
  }
  pair(ticket: string, now = Date.now()) {
    const expiry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!expiry || expiry <= now) return null;
    this.prune(now);
    const session = randomBytes(32).toString('base64url');
    this.sessions.set(session, now + 12 * 60 * 60_000);
    return session;
  }
  available(ticket: string, now = Date.now()) {
    return (this.tickets.get(ticket) ?? 0) > now;
  }
  valid(cookie = '', now = Date.now()) {
    const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('paseo_voice='))?.slice(12);
    return token && (this.sessions.get(token) ?? 0) > now ? token : null;
  }
  validBearer(header = '', now = Date.now()) {
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return token && (this.sessions.get(token) ?? 0) > now ? token : null;
  }
  private prune(now: number) {
    for (const map of [this.tickets, this.sessions]) for (const [key, expiry] of map) if (expiry <= now) map.delete(key);
  }
}
