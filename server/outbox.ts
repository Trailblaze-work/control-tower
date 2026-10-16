import { createHash } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { silent, type Reporter } from './telemetry.ts';

const messageSchema = z.object({
  id: z.string(), owner: z.string(), agentId: z.string(), prompt: z.string(), createdAt: z.number(),
  status: z.enum(['queued', 'submitting', 'accepted', 'waiting', 'completed', 'permission', 'error', 'timeout', 'unknown', 'cancelled', 'expired']),
  reply: z.string().optional(), error: z.string().optional(), note: z.string().optional(),
  submittedAt: z.number().optional(),
});
type Message = z.infer<typeof messageSchema>;
export class Outbox {
  private paseo: PaseoApi;
  private path?: string;
  private messages = new Map<string, Message>();
  private active = new Set<string>();
  private ticking = false;
  private writes = Promise.resolve();
  private report: Reporter;
  constructor(paseo: PaseoApi, path?: string, report: Reporter = silent) { this.paseo = paseo; this.path = path; this.report = report; }
  private transition(message: Message, status: Message['status']) {
    if (message.status === status) return;
    message.status = status;
    this.report({ event: 'outbox_transition', jobId: message.id, outcome: status, durationMs: Date.now() - message.createdAt });
  }
  async flush() { await this.writes; }

  async load() {
    if (!this.path) return;
    const raw = await readPrivateJson(this.path);
    if (raw === undefined) return;
    for (const entry of z.array(messageSchema).max(1000).parse(raw)) {
      if (Date.now() - entry.createdAt > 24 * 60 * 60_000) continue;
      // An interrupted submission may already have reached Paseo. Never replay it.
      if (entry.status === 'submitting') {
        entry.status = 'unknown'; entry.error = 'Service restarted after submission. Check agent activity before sending again.';
      }
      // A reply deadline is not an execution deadline. Resume observation, never delivery.
      if (['accepted', 'waiting', 'timeout'].includes(entry.status)) {
        this.transition(entry, 'waiting'); delete entry.error;
        entry.note = 'Reply not yet confirmed. Work may still be running or already complete; do not resend.';
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
    this.transition(message, 'cancelled'); await this.save(); return this.visible(message);
  }
  private async observe(message: Message) {
    const agent = this.paseo.agents.ref(message.agentId);
    try {
      if (!await agent.refresh()) return;
      const page = await agent.timeline.refetch({ direction: 'before', limit: 200, projection: 'projected' });
      const request = page.entries.find(entry => {
        const item = entry.item as { type: string; clientMessageId?: string; messageId?: string };
        return item.type === 'user_message' && (item.clientMessageId === message.id || item.messageId === message.id);
      });
      // Never attribute an unrelated later reply to this request, including after restart.
      if (request?.turnId) {
        const turn = page.entries.filter(entry => entry.turnId === request.turnId && entry.seqStart > request.seqStart);
        const last = turn.at(-1);
        const laterTurn = page.entries.some(entry => entry.seqStart > request.seqStart && entry.turnId && entry.turnId !== request.turnId);
        const ended = laterTurn || (agent.status === 'idle' && page.entries.at(-1)?.turnId === request.turnId);
        if (ended) {
          const item = last?.item as { type?: string; text?: string } | undefined;
          if (item?.type === 'assistant_message' && item.text) {
            message.reply = item.text.slice(-12000); delete message.note;
            this.transition(message, 'completed');
          } else {
            message.note = 'The agent turn ended without a confirmed final reply. Check activity before resending.';
            this.transition(message, 'unknown');
          }
          return;
        }
      }
      if (Date.now() - (message.submittedAt ?? message.createdAt) >= 120_000) {
        if (message.status !== 'waiting') this.report({ event: 'outbox_reply_wait', jobId: message.id, outcome: 'still_pending', code: 'timeout' });
        this.transition(message, 'waiting');
        message.note = 'Reply not yet confirmed. The reply wait is not an execution timeout; work may still be running or already complete. Do not resend.';
      }
    } catch {
      // Observation failure says nothing about execution. Keep the delivery receipt.
      this.report({ event: 'outbox_observation', jobId: message.id, outcome: 'unavailable' });
      this.transition(message, 'waiting');
      message.note = 'Reply observation is unavailable; delivery was accepted. Do not resend automatically.';
    }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const message of this.messages.values()) {
        if (['accepted', 'waiting'].includes(message.status)) {
          const before = JSON.stringify([message.status, message.note, message.reply]);
          await this.observe(message);
          if (before !== JSON.stringify([message.status, message.note, message.reply])) await this.save();
        }
      }
      const pendingAgents = new Set([...this.messages.values()].filter(message => ['accepted', 'waiting'].includes(message.status)).map(message => message.agentId));
      for (const message of this.messages.values()) {
        if (message.status !== 'queued') continue;
        if (Date.now() - message.createdAt > 30 * 60_000) { this.transition(message, 'expired'); await this.save(); continue; }
        if (this.active.has(message.agentId) || pendingAgents.has(message.agentId)) continue;
        const agent = this.paseo.agents.ref(message.agentId);
        try { if (!await agent.refresh() || agent.archivedAt) { this.transition(message, 'error'); message.error = 'Agent is unavailable or archived.'; await this.save(); continue; } }
        catch { continue; } // Connection loss leaves the durable message queued.
        if (message.status !== 'queued' || agent.status !== 'idle' || agent.pendingPermissions?.length) continue;
        this.active.add(message.agentId);
        this.transition(message, 'submitting');
        try {
          await this.save(); // Persist intent before any external side effect.
          // No idle-only SDK operation exists. Explicit steer prevents cancellation
          // if another client starts work between the snapshot and this send.
          await agent.send(message.prompt, { messageId: message.id, activeTurnBehavior: 'steer' });
          message.submittedAt = Date.now(); this.transition(message, 'accepted'); pendingAgents.add(message.agentId);
          await this.save();
        } catch {
          this.transition(message, 'unknown'); message.error = 'Submission outcome uncertain. Check activity before resending.';
          await this.save();
        } finally { this.active.delete(message.agentId); }
      }
    } finally { this.ticking = false; }
  }
}
