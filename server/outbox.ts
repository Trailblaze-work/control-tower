import { createHash } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const messageSchema = z.object({
  id: z.string(), owner: z.string(), agentId: z.string(), prompt: z.string(), createdAt: z.number(),
  status: z.enum(['queued', 'submitting', 'accepted', 'completed', 'permission', 'error', 'timeout', 'unknown', 'cancelled', 'expired']),
  reply: z.string().optional(), error: z.string().optional(),
});
type Message = z.infer<typeof messageSchema>;
export class Outbox {
  private paseo: PaseoApi;
  private path?: string;
  private messages = new Map<string, Message>();
  private active = new Set<string>();
  private ticking = false;
  private writes = Promise.resolve();
  constructor(paseo: PaseoApi, path?: string) { this.paseo = paseo; this.path = path; }
  async flush() { await this.writes; }

  async load() {
    if (!this.path) return;
    const raw = await readPrivateJson(this.path);
    if (raw === undefined) return;
    for (const entry of z.array(messageSchema).max(1000).parse(raw)) {
      if (Date.now() - entry.createdAt > 24 * 60 * 60_000) continue;
      // An interrupted submission may already have reached Paseo. Never replay it.
      if (['submitting', 'accepted'].includes(entry.status)) {
        entry.status = 'unknown'; entry.error = 'Service restarted after submission. Check agent activity before sending again.';
      }
      this.messages.set(entry.id, entry);
    }
    await this.save();
  }
  private save() {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const snapshot = [...this.messages.values()].map(message => ({ ...message }));
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(path, snapshot));
    return this.writes;
  }
  private visible(message: Message) {
    const { owner: _owner, prompt: _prompt, ...result } = message;
    return result;
  }
  get(owner: string, id: string) {
    const message = this.messages.get(id);
    return message?.owner === owner ? this.visible(message) : undefined;
  }
  list(owner: string) {
    return [...this.messages.values()].filter(message => message.owner === owner).slice(-30).map(message => this.visible(message));
  }
  async enqueue(owner: string, requestId: string, agentId: string, prompt: string) {
    const id = createHash('sha256').update(`${owner}\0${requestId}`).digest('hex');
    const existing = this.get(owner, id);
    if (existing) return { jobId: id, status: existing.status, agentId };
    for (const [key, message] of this.messages) if (Date.now() - message.createdAt > 24 * 60 * 60_000 && !this.active.has(message.agentId)) this.messages.delete(key);
    if (this.messages.size >= 500) return { error: 'Outbox capacity reached. Clear or finish pending messages first.' };
    const message: Message = { id, owner, agentId, prompt, status: 'queued', createdAt: Date.now() };
    this.messages.set(id, message);
    await this.save();
    await this.tick();
    return { jobId: id, status: message.status, agentId };
  }
  async cancel(owner: string, id: string) {
    const message = this.messages.get(id);
    if (!message || message.owner !== owner) return { error: 'Unknown job' };
    if (message.status !== 'queued') return { error: 'Message has already left the queue. Cancellation would risk disrupting work.' };
    message.status = 'cancelled'; await this.save(); return this.visible(message);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const message of this.messages.values()) {
        if (message.status !== 'queued' || this.active.has(message.agentId)) continue;
        if (Date.now() - message.createdAt > 30 * 60_000) { message.status = 'expired'; await this.save(); continue; }
        const agent = this.paseo.agents.ref(message.agentId);
        try { if (!await agent.refresh() || agent.archivedAt) { message.status = 'error'; message.error = 'Agent is unavailable or archived.'; await this.save(); continue; } }
        catch { continue; } // Connection loss leaves the durable message queued.
        if (message.status !== 'queued' || agent.status !== 'idle' || agent.pendingPermissions?.length) continue;
        this.active.add(message.agentId);
        message.status = 'submitting';
        try {
          await this.save(); // Persist intent before any external side effect.
          // No idle-only SDK operation exists. Explicit steer prevents cancellation
          // if another client starts work between the snapshot and this send.
          await agent.send(message.prompt, { messageId: message.id, activeTurnBehavior: 'steer' });
          message.status = 'accepted'; await this.save();
          void agent.waitForFinish(120_000).then(result => {
            message.status = result.status === 'idle' ? 'completed' : result.status;
            message.reply = result.lastMessage?.slice(-12000);
          }).catch(() => {
            message.status = 'unknown'; message.error = 'Lost connection while awaiting a reply. Check activity before resending.';
          }).finally(() => { this.active.delete(message.agentId); void this.save().catch(() => {}); });
        } catch {
          message.status = 'unknown'; message.error = 'Submission outcome uncertain. Check activity before resending.';
          this.active.delete(message.agentId); await this.save();
        }
      }
    } finally { this.ticking = false; }
  }
}
