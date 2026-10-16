import { z } from 'zod';
import { conversation, type Conversation } from './coordinator.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

const record = z.object({ id: z.string().uuid(), owner: z.string().min(1), createdAt: z.number(), lastSeen: z.number(), model: z.string().optional() });
type SavedCall = z.infer<typeof record>;
const fresh = (call: Pick<SavedCall, 'createdAt' | 'lastSeen'>) => Date.now() - call.createdAt < 60 * 60_000 && Date.now() - call.lastSeen < 120_000;

// Preserve ownership/model only. Restored history must never become fresh speech
// authorization, cached discovery, or a promise to replay a tool invocation.
export class Calls {
  readonly entries = new Map<string, Conversation>();
  private path: string;
  private writes = Promise.resolve();
  constructor(path: string) { this.path = path; }
  async load() {
    const raw = await readPrivateJson(this.path);
    if (raw === undefined) return;
    for (const saved of z.array(record).max(3).parse(raw).filter(fresh)) {
      this.entries.set(saved.id, { ...conversation(saved.owner), createdAt: saved.createdAt, lastSeen: saved.lastSeen, model: saved.model });
    }
    await this.save();
  }
  save() {
    const snapshot = [...this.entries].filter(([, call]) => fresh(call)).map(([id, call]) => ({ id, owner: call.owner, createdAt: call.createdAt, lastSeen: call.lastSeen, model: call.model }));
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(this.path, snapshot));
    return this.writes;
  }
}
