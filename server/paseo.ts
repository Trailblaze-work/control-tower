import { createPaseoClient, type PaseoApi, type PaseoWorkspace } from '@getpaseo/client';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { errorCode, silent, type Reporter } from './telemetry.ts';

async function observedRead<T>(report: Reporter, operation: string, read: () => Promise<T>) {
  const started = Date.now();
  try { const value = await read(); report({ event: 'paseo_read', operation, outcome: 'ok', durationMs: Date.now()-started }); return value; }
  catch (error) { report({ event: 'paseo_read', operation, outcome: 'error', code: errorCode(error), durationMs: Date.now()-started }); throw error; }
}

export function workspaceSummary(w: PaseoWorkspace) {
  const pr = w.githubRuntime?.pullRequest;
  const parsedNumber = pr?.url.match(/\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/)?.[1];
  const number = pr?.number ?? (parsedNumber ? Number(parsedNumber) : null);
  const directory = w.workspaceDirectory ?? w.projectRootPath ?? null;
  const worktreeName = w.worktreeSlug ?? (w.workspaceKind === 'worktree' && directory ? basename(directory) : null);
  return {
    id: w.id, name: w.name, title: w.title ?? null, projectId: w.projectId,
    project: w.projectDisplayName, projectRootPath: w.projectRootPath ?? null,
    directory, workspaceKind: w.workspaceKind, projectKind: w.projectKind,
    worktreeName, worktreeNameSource: w.worktreeSlug ? 'daemon' : worktreeName ? 'directory_basename' : null,
    branch: w.gitRuntime?.currentBranch ?? null,
    pullRequest: pr ? { number, url: pr.url, title: pr.title, state: pr.state, headBranch: pr.headRefName, baseBranch: pr.baseRefName } : null,
    mappingSource: 'paseo_directory', mappingRefreshedAt: w.githubRuntime?.refreshedAt ?? null,
    mappingError: w.githubRuntime?.error?.message ?? null,
    status: w.status, activityAt: w.activityAt, diff: w.diffStat,
  };
}

function agentSummary(agent: Awaited<ReturnType<PaseoApi['agents']['list']>>['entries'][number]['agent']) {
  return {
    id: agent.id, workspaceId: agent.workspaceId, title: agent.title, status: agent.status,
    updatedAt: agent.updatedAt, attention: agent.requiresAttention, attentionReason: agent.attentionReason,
    pendingPermissions: agent.pendingPermissions.length, lastError: agent.lastError,
  };
}

export function localPaseo() {
  // The published client forwards this daemon authentication callback unchanged.
  // Keep local auth here; neither the credential nor the daemon is exposed to the browser.
  const config = {
    url: process.env.PASEO_VOICE_DAEMON_URL ?? 'ws://127.0.0.1:6767/ws',
    clientId: 'paseo-voice-coordinator',
    localCredential: async () => (await readFile(join(homedir(), '.paseo/local-credential'), 'utf8')).trim(),
    connectTimeoutMs: 8000,
  };
  return createPaseoClient(config);
}

export async function directory(paseo: PaseoApi, report: Reporter = silent) {
  const agents: ReturnType<typeof agentSummary>[] = []; const workspaces: ReturnType<typeof workspaceSummary>[] = [];
  let cursor: string | undefined;
  do {
    const page = await observedRead(report, 'agents_list', () => paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    agents.push(...page.entries.map(({ agent }) => agentSummary(agent)));
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  do {
    const page = await observedRead(report, 'workspaces_list', () => paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    workspaces.push(...page.entries.map(workspaceSummary));
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
  } while (cursor);
  return { observedAt: new Date().toISOString(), agents, workspaces: workspaces.map(workspace => ({ ...workspace, agents: agents.filter(agent => agent.workspaceId === workspace.id) })),
    prMappings: workspaces.filter(w => w.pullRequest).map(w => ({
      workspaceId: w.id, workspaceName: w.name, worktreeName: w.worktreeName, project: w.project,
      pullRequest: w.pullRequest, agentIds: agents.filter(a => a.workspaceId === w.id).map(a => a.id),
      refreshedAt: w.mappingRefreshedAt,
    })),
    mappingNote: 'Attached PR metadata is cached daemon evidence, not a fresh forge lookup. Missing means unknown; PR numbers alone are not globally unique. Preserve multiple candidate workspaces and qualify stale or conflicting mappings.' };
}

export async function recentActivity(paseo: PaseoApi, agentId: string, report: Reporter = silent) {
  const agent = paseo.agents.ref(agentId);
  if (!await observedRead(report, 'agent_refresh', () => agent.refresh()) || agent.archivedAt) throw new Error('Agent is unavailable. Refresh the workspace list.');
  const page = await observedRead(report, 'timeline_read', () => agent.timeline.refetch({ direction: 'before', limit: 35, projection: 'projected' }));
  // Pass prose, not command output or permission payloads, to the voice model.
  const messages = page.entries.flatMap(entry => {
    const item = entry.item as { type: string; text?: string };
    return ['assistant_message', 'user_message'].includes(item.type) && typeof item.text === 'string'
      ? [{ role: item.type, text: item.text.slice(-5000), sequence: entry.seqEnd }] : [];
  });
  report({ event: 'activity_projection', outcome: messages.length ? 'ok' : 'no_prose_in_page', count: messages.length });
  return { agentId, title: agent.current()?.title, status: agent.status, observedAt: new Date().toISOString(), messages, hasOlder: page.hasOlder };
}
