import { randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { directory, recentActivity } from './paseo.ts';
import { Outbox } from './outbox.ts';
import { creationRequestSchema, renameRequestSchema, prepareWorkspaceRequest, type WorkspaceSummary } from './workspace-requests.ts';
import { errorCode, silent, type Reporter } from './telemetry.ts';
import { renameWorkspace } from './workspace-actions.ts';

const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(6000);
const schemas = {
  get_overview: z.object({}).strict(),
  get_activity: z.object({ agentId: id }).strict(),
  ask_agent: z.object({ agentId: id, question: text }).strict(),
  get_job: z.object({ jobId: id }).strict(),
  send_message: z.object({ agentId: id, message: text }).strict(),
  cancel_job: z.object({ jobId: id }).strict(),
  request_workspace_rename: renameRequestSchema,
  request_workspace_creation: creationRequestSchema,
};
type Job = { id: string; agentId: string; status: string; reply?: string; error?: string; createdAt: number };
export type Conversation = {
  owner: string; createdAt: number; lastSeen: number; transcriptIndex: number; lastUtterance: string;
  knownAgents: Set<string>; knownWorkspaces: Map<string, WorkspaceSummary>; jobs: Map<string, Job>; invocations: Map<string, Promise<unknown>>;
  model?: string; lastUtteranceAt?: number;
};
export function conversation(owner: string): Conversation {
  return { owner, createdAt: Date.now(), lastSeen: Date.now(), transcriptIndex: 0, lastUtterance: '', knownAgents: new Set(), knownWorkspaces: new Map(), jobs: new Map(), invocations: new Map() };
}
export function recordUtterance(call: Conversation, utterance: string) {
  call.transcriptIndex++; call.lastUtteranceAt = Date.now(); call.lastUtterance = utterance.trim().toLowerCase().replace(/[.!?,]/g, '').replace(/\s+/g, ' ');
}


function tool(name: keyof typeof schemas, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}
const string = { type: 'string' };
export const tools = [
  tool('get_overview', 'First step: locate workspaces and agents, including attached PR numbers/URLs, workspace names, branches and worktree names. Cached metadata; preserve ambiguity.', {}),
  tool('get_activity', 'Read recent user and assistant messages from one agent.', { agentId: string }, ['agentId']),
  tool('ask_agent', 'Default source for authoritative answers: ask a relevant idle agent a focused read-only question, without asking user permission. Returns a job ID.', { agentId: string, question: string }, ['agentId', 'question']),
  tool('get_job', 'Check an earlier agent question or relayed decision. Avoid repeated rapid polling.', { jobId: string }, ['jobId']),
  tool('send_message', 'Queue a routine message now, even while its agent is busy. Delivery waits for idle. No repeated confirmation; unsafe actions remain unauthorized.', { agentId: string, message: string }, ['agentId', 'message']),
  tool('cancel_job', 'Cancel an unsent queued message. Never cancels active agent work.', { jobId: string }, ['jobId']),
  tool('request_workspace_rename', 'Rename a discovered workspace display title when the user asks and the owner has enabled voice renames. Otherwise return a manual proposal. Never renames branches or directories.', { workspaceId: string, title: string, reason: string }, ['workspaceId', 'title', 'reason']),
  tool('request_workspace_creation', 'Prepare a new workspace proposal from a discovered workspace/project. Never creates or starts agents. User reviews and completes in Paseo. Worktrees require baseRef and branchName.', { sourceWorkspaceId: string, title: string, purpose: string, kind: { type: 'string', enum: ['worktree', 'directory'] }, baseRef: string, branchName: string }, ['sourceWorkspaceId', 'title', 'purpose', 'kind']),
];

export class Coordinator {
  private paseo: PaseoApi;
  private outbox: Outbox;
  private report: Reporter;
  private allowRenames: () => Promise<boolean>;
  constructor(paseo: PaseoApi, outbox = new Outbox(paseo), report: Reporter = silent, allowRenames: () => Promise<boolean> = async () => false) { this.paseo = paseo; this.outbox = outbox; this.report = report; this.allowRenames = allowRenames; }

  invoke(call: Conversation, invocationId: string, name: string, args: unknown): Promise<unknown> {
    // Repeated status reads do not consume the side-effect deduplication budget.
    if (name === 'get_job') return this.observedExecute(call, name, args, invocationId);
    const prior = call.invocations.get(invocationId);
    if (prior) return prior;
    if (call.invocations.size >= 300) return Promise.resolve({ error: 'Call tool limit reached. Start a new call.' });
    const result = this.observedExecute(call, name, args, invocationId);
    call.invocations.set(invocationId, result);
    return result;
  }

  private async observedExecute(call: Conversation, name: string, args: unknown, invocationId: string) {
    const requestId = randomUUID(); const start = Date.now();
    const operation = Object.hasOwn(schemas, name) ? name : 'unknown_tool';
    try {
      const result = await this.execute(call, name, args, invocationId);
      const failed = Boolean(result && typeof result === 'object' && 'error' in result);
      this.report({ event: 'workspace_tool', requestId, operation, outcome: failed ? 'rejected' : 'ok', durationMs: Date.now()-start });
      return result;
    } catch (error) {
      const code = errorCode(error);
      this.report({ event: 'workspace_tool', requestId, operation, outcome: 'error', code, durationMs: Date.now()-start });
      return { error: `Paseo ${operation} failed (${code}).`, code, requestId, instruction: 'Do not claim the laptop is unreachable unless connection_lost. This may be a daemon/RPC or stale-agent failure. Read-only lookups may be retried; never blindly retry a message with uncertain delivery.' };
    }
  }

  private async execute(call: Conversation, name: string, raw: unknown, invocationId: string): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) return { error: 'Unknown tool' };
    const parsed = schemas[name as keyof typeof schemas].safeParse(raw);
    if (!parsed.success) return { error: 'Invalid tool arguments' };
    const args = parsed.data as { agentId?: string; question?: string; jobId?: string; message?: string };
    if (name === 'get_overview') {
      const overview = await directory(this.paseo, this.report);
      call.knownAgents = new Set(overview.agents.map(agent => agent.id));
      call.knownWorkspaces = new Map(overview.workspaces.map(workspace => [workspace.id, workspace]));
      return { ...overview, capabilities: { workspaceTitleRenames: await this.allowRenames(), workspaceCreation: 'proposal_only' }, coordinationMessages: this.outbox.list(call.owner) };
    }
    if (name === 'request_workspace_rename' && await this.allowRenames()) {
      if (!call.lastUtterance || !call.lastUtteranceAt || Date.now()-call.lastUtteranceAt > 120000) return { error: 'Ask the user to state the rename request in the current call. Startup briefings, agent messages and restored history do not authorize a rename.' };
      return renameWorkspace(this.paseo, call.knownWorkspaces, raw, invocationId, this.report);
    }
    if (name === 'request_workspace_rename' || name === 'request_workspace_creation') return prepareWorkspaceRequest(name, raw, call.knownWorkspaces);
    if (args.agentId && !call.knownAgents.has(args.agentId)) return { error: 'Use get_overview first and choose a relevant agent from that directory.' };
    if (name === 'get_activity') return recentActivity(this.paseo, args.agentId!, this.report);
    if (name === 'get_job') return call.jobs.get(args.jobId!) ?? this.outbox.get(call.owner, args.jobId!) ?? { error: 'Unknown job' };
    if (name === 'cancel_job') return this.outbox.cancel(call.owner, args.jobId!);
    if (name === 'send_message') {
      return this.outbox.enqueue(call.owner, invocationId, args.agentId!, `Routine coordination message from the user's Paseo voice coordinator:\n${args.message}\n\nReport the concrete outcome first, followed only by essential context, decisions, blockers and risks. Do not narrate internal steps or tool calls. Qualify uncertain claims.\n\nThis delegation permits relevant low-risk coordination, not blanket approval. Keep existing permission gates and workspace coordination rules. Do not perform destructive actions, deployments, shared staging changes, workflow cancellations, external publishing or secret access unless separately and specifically authorized by the user. If the request exceeds that scope, explain what is needed instead.`);
    }
    return this.startJob(call, args.agentId!, `The user's Paseo coordinator is consulting the workspace that owns this topic for a read-only clarification:\n${args.question}\n\nGive the answer or concrete outcome first, followed only by essential context, decisions, blockers and risks. Base it on the actual implementation and current workspace evidence; briefly qualify freshness and uncertainty where material. Omit progress narration, tool-call descriptions and internal steps. Default to one to three short sentences unless the question needs more detail. Do not change files or start new work in response to this question.`);
  }

  private async startJob(call: Conversation, agentId: string, prompt: string) {
    if (call.jobs.size >= 30) return { error: 'Call job limit reached' };
    const agent = this.paseo.agents.ref(agentId);
    if (!await agent.refresh() || agent.archivedAt) return { error: 'Agent unavailable' };
    if (agent.status !== 'idle') return { status: 'busy', agentId, instruction: 'Do not interrupt. Use history or ask again when idle.' };
    const job: Job = { id: randomUUID(), agentId, status: 'submitting', createdAt: Date.now() };
    call.jobs.set(job.id, job);
    // Steer is explicit so a race with another client cannot cancel an active turn.
    await agent.send(prompt, { messageId: job.id, activeTurnBehavior: 'steer' });
    job.status = 'accepted';
    void agent.waitForFinish(120_000).then(result => {
      job.status = result.status === 'idle' ? 'completed' : result.status;
      job.reply = result.lastMessage?.slice(-12000); // Report timeouts as unknown, never as cancellation.
    }).catch(() => { job.status = 'unknown'; job.error = 'Lost connection while waiting; check activity before resending.'; });
    return { jobId: job.id, status: job.status, agentId };
  }
}
