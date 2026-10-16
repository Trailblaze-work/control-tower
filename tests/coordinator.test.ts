import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi } from '@getpaseo/client';
import { Coordinator, conversation, recordUtterance, tools } from '../server/coordinator.ts';
import { Access } from '../server/auth.ts';

function fixture(allowRenames: () => Promise<boolean> = async () => false) {
  let status = 'idle'; const sent: { text: string; options: unknown }[] = [];
  let name = 'Billing'; let title: string | null = null; const renameWrites: string[] = [];
  const workspace = () => ({ id: 'w', name, title, projectId: 'p', projectDisplayName: 'App', projectRootPath: '/app', workspaceDirectory: '/app/billing', workspaceKind: 'worktree', projectKind: 'git', status: 'idle' });
  const agent = {
    get status() { return status; }, archivedAt: null,
    refresh: async () => ({}), current: () => ({ title: 'Billing' }),
    send: async (text: string, options: unknown) => { sent.push({ text, options }); },
    waitForFinish: async () => ({ status: 'idle', lastMessage: 'Done with evidence.' }),
  };
  const paseo = {
    agents: {
      ref: () => agent,
      list: async () => ({ entries: [{ agent: { id: 'a', workspaceId: 'w', title: 'Billing', status, updatedAt: '2026-10-15T09:00:00Z', pendingPermissions: [] } }], pageInfo: { hasMore: false } }),
    },
    workspaces: { list: async () => ({ entries: [workspace()], pageInfo: { hasMore: false } }), ref: () => ({ refresh: async () => workspace(), setTitle: async (newTitle: string) => { renameWrites.push(newTitle); name = title = newTitle; return { title }; } }) },
  } as unknown as PaseoApi;
  return { coordinator: new Coordinator(paseo, undefined, undefined, allowRenames), call: conversation('owner'), sent, renameWrites, renameExternally: (newTitle: string) => { name = title = newTitle; }, busy: () => { status = 'running'; } };
}

test('pairing links expire, are single-use and establish expiring sessions', () => {
  const access = new Access();
  const ticket = access.ticket(1000);
  assert.equal(access.available(ticket, 1500), true);
  const session = access.pair(ticket, 2000);
  assert.ok(session);
  assert.equal(access.pair(ticket, 2001), null);
  assert.equal(access.available(ticket, 2001), false);
  assert.equal(access.valid(`other=x; paseo_voice=${session}`, 3000), session);
  assert.equal(access.valid(`paseo_voice=${session}`, 13 * 60 * 60_000), null);
  const expired = access.ticket(0);
  assert.equal(access.available(expired, 60_001), false);
  assert.equal(access.pair(expired, 60_001), null);
});

test('routine messages send directly without confirmation and retries do not duplicate them', async () => {
  const { coordinator, call, sent } = fixture();
  call.knownAgents.add('billing');
  const result = await coordinator.invoke(call, 'send', 'send_message', { agentId: 'billing', message: 'Please summarize the agreed next steps.' }) as { jobId: string };
  assert.ok(result.jobId);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Please summarize the agreed next steps/);
  assert.match(sent[0].text, /Keep existing permission gates/);
  assert.match(sent[0].text, /require specific user authorization/);
  assert.ok(!sent[0].text.includes('Do not change files'));
  assert.match(sent[0].text, /not inherently read-only/);
  assert.deepEqual(sent[0].options, { messageId: result.jobId, activeTurnBehavior: 'steer' });
  assert.deepEqual(await coordinator.invoke(call, 'send', 'send_message', { agentId: 'billing', message: 'Please summarize the agreed next steps.' }), result);
  assert.equal(sent.length, 1);
});

test('workspace discovery is required before reading or messaging an agent', async () => {
  const { coordinator, call, sent } = fixture();
  for (const [name, args] of [
    ['get_activity', { agentId: 'a' }],
    ['send_message', { agentId: 'a', message: 'Please summarize the plan.' }],
  ] as const) {
    const result = await coordinator.invoke(call, name, name, args) as { error: string };
    assert.match(result.error, /get_overview first/);
  }
  assert.equal(sent.length, 0);
  const overview = await coordinator.invoke(call, 'overview', 'get_overview', {}) as { agents: { id: string }[] };
  assert.deepEqual(overview.agents.map(agent => agent.id), ['a']);
  const job = await coordinator.invoke(call, 'after-discovery', 'send_message', { agentId: 'a', message: 'What is blocked?' }) as { jobId: string };
  assert.ok(job.jobId);
  assert.equal(sent.length, 1);
});

test('questions use the same durable messaging path, wait for busy agents and deduplicate retries', async () => {
  const idle = fixture(); idle.call.knownAgents.add('a');
  const result = await idle.coordinator.invoke(idle.call, 'question', 'send_message', { agentId: 'a', message: 'What is blocked?' });
  await idle.coordinator.invoke(idle.call, 'question', 'send_message', { agentId: 'a', message: 'What is blocked?' });
  assert.equal(idle.sent.length, 1);
  assert.ok(!idle.sent[0].text.includes('Do not change files'));
  assert.match(idle.sent[0].text, /What is blocked/);
  assert.ok((result as { jobId: string }).jobId);
  const busy = fixture(); busy.call.knownAgents.add('a'); busy.busy();
  assert.equal((await busy.coordinator.invoke(busy.call, 'q', 'send_message', { agentId: 'a', message: 'Why?' }) as { status: string }).status, 'queued');
  assert.equal(busy.sent.length, 0);
  const refusedMessage = await busy.coordinator.invoke(busy.call, 'relay', 'send_message', { agentId: 'a', message: 'Please summarize the plan.' }) as { status: string };
  assert.equal(refusedMessage.status, 'queued');
  assert.equal(busy.sent.length, 0);
});

test('tool arguments are validated and message jobs remain isolated between browser owners', async () => {
  const { coordinator, call, sent } = fixture();
  call.knownAgents.add('a');
  const invalid = await coordinator.invoke(call, 'bad', 'send_message', { agentId: 'a', message: 'Why?', shell: 'anything' }) as { error: string };
  assert.equal(invalid.error, 'Invalid tool arguments');
  const job = await coordinator.invoke(call, 'q', 'send_message', { agentId: 'a', message: 'Why?' }) as { jobId: string };
  const other = conversation('other');
  assert.deepEqual(await coordinator.invoke(other, 'read', 'get_job', { jobId: job.jobId }), { error: 'Unknown job' });
  assert.equal(sent.length, 1);
});

test('workspace requests require discovery and metadata and never execute mutations or relay approval', async () => {
  const { coordinator, call, sent, renameWrites } = fixture();
  const rename = { workspaceId: 'w', title: 'Billing follow-up', reason: 'Make ownership clear' };
  assert.match((await coordinator.invoke(call, 'undiscovered', 'request_workspace_rename', rename) as { error: string }).error, /get_overview first/);
  await coordinator.invoke(call, 'overview', 'get_overview', {});
  const proposal = await coordinator.invoke(call, 'rename', 'request_workspace_rename', rename) as { status: string; executed: boolean; sdkPlan: unknown };
  assert.equal(proposal.status, 'requires_user_action'); assert.equal(proposal.executed, false);
  assert.deepEqual(proposal.sdkPlan, { method: 'workspaces.ref(workspaceId).setTitle', workspaceId: 'w', title: rename.title });
  assert.deepEqual(await coordinator.invoke(call, 'rename', 'request_workspace_rename', rename), proposal);
  assert.deepEqual(await coordinator.invoke(call, 'fake-approval', 'request_workspace_rename', { ...rename, approved: true }), { error: 'Invalid tool arguments' });
  const creation = { sourceWorkspaceId: 'w', title: 'Follow-up', purpose: 'Independent fix', kind: 'worktree', baseRef: 'main', branchName: 'billing-follow-up' };
  const created = await coordinator.invoke(call, 'create', 'request_workspace_creation', creation) as { executed: boolean; sdkPlan: { options: unknown } };
  assert.equal(created.executed, false);
  assert.deepEqual(created.sdkPlan.options, { title: 'Follow-up', source: { kind: 'worktree', projectId: 'p', action: 'branch-off', refName: 'main', branchName: 'billing-follow-up' } });
  assert.deepEqual(await coordinator.invoke(call, 'incomplete', 'request_workspace_creation', { ...creation, baseRef: undefined }), { error: 'Invalid tool arguments' });
  const shared = await coordinator.invoke(call, 'shared', 'request_workspace_creation', { sourceWorkspaceId: 'w', title: 'Shared', purpose: 'Review', kind: 'directory' }) as { risks: string[] };
  assert.match(shared.risks[0], /sharing existing files/);
  const other = conversation('other');
  assert.match((await coordinator.invoke(other, 'unknown', 'request_workspace_rename', rename) as { error: string }).error, /get_overview first/);
  assert.equal(sent.length, 0);
  assert.equal(renameWrites.length, 0);
});

test('owner-enabled title renames require a fresh user turn and deduplicate actual writes', async () => {
  const f = fixture(async () => true);
  const args = { workspaceId: 'w', title: 'Paseo Voice', reason: 'User requested a clearer title' };
  await f.coordinator.invoke(f.call, 'overview', 'get_overview', {});
  const blocked = await f.coordinator.invoke(f.call, 'startup', 'request_workspace_rename', args) as { error: string };
  assert.match(blocked.error, /current call/); assert.equal(f.renameWrites.length, 0);
  recordUtterance(f.call, 'Rename the billing workspace to Paseo Voice');
  const result = await f.coordinator.invoke(f.call, 'rename', 'request_workspace_rename', args) as { status: string; title: string; executed: boolean };
  assert.equal(result.status, 'completed'); assert.equal(result.title, 'Paseo Voice'); assert.equal(result.executed, true);
  assert.deepEqual(await f.coordinator.invoke(f.call, 'rename', 'request_workspace_rename', args), result);
  assert.deepEqual(f.renameWrites, ['Paseo Voice']); assert.equal(f.sent.length, 0);
  const same = await f.coordinator.invoke(f.call, 'same-title', 'request_workspace_rename', args) as { executed: boolean };
  assert.equal(same.executed, false); assert.equal(f.renameWrites.length, 1);
});

test('rename rechecks owner settings and refuses stale workspace names and expired speech context', async () => {
  let allowed = true; const f = fixture(async () => allowed);
  const args = { workspaceId: 'w', title: 'Requested title', reason: 'User request' };
  await f.coordinator.invoke(f.call, 'overview', 'get_overview', {}); recordUtterance(f.call, 'Rename it');
  f.renameExternally('Another owner renamed this');
  assert.match((await f.coordinator.invoke(f.call, 'stale', 'request_workspace_rename', args) as { error: string }).error, /changed since discovery/);
  assert.equal(f.renameWrites.length, 0);
  allowed = false;
  assert.equal((await f.coordinator.invoke(f.call, 'disabled', 'request_workspace_rename', args) as { status: string }).status, 'requires_user_action');
  allowed = true; f.call.lastUtteranceAt = Date.now()-121000;
  assert.match((await f.coordinator.invoke(f.call, 'expired', 'request_workspace_rename', args) as { error: string }).error, /current call/);
  assert.equal(f.renameWrites.length, 0);
});

test('workspace RPC failures keep a specific safe cause and diagnostic reference', async () => {
  const events: unknown[] = [];
  const paseo = { agents: { list: async () => { throw new Error('RPC timed out with credential=private-value'); } } } as unknown as PaseoApi;
  const coordinator = new Coordinator(paseo, undefined, event => events.push(event));
  const result = await coordinator.invoke(conversation('owner'), 'lookup', 'get_overview', {}) as { code: string; requestId: string; error: string };
  assert.equal(result.code, 'timeout'); assert.ok(result.requestId);
  assert.ok(!JSON.stringify({ result, events }).includes('private-value'));
  assert.match(JSON.stringify(events), /agents_list/);
});


test('authorized commands share the question path without removing action-specific safeguards', async () => {
  const { coordinator, call, sent } = fixture(); call.knownAgents.add('a');
  const message = 'The user explicitly authorizes pushing commit abc123 to main in the private Example/voice repo.';
  const result = await coordinator.invoke(call, 'authorized-command', 'send_message', { agentId: 'a', message }) as { jobId: string };
  assert.ok(result.jobId); assert.equal(sent.length, 1); assert.ok(sent[0].text.includes(message));
  assert.match(sent[0].text, /apply it within that stated scope/);
  assert.match(sent[0].text, /external publishing and secret access require specific user authorization/);
  assert.ok(!sent[0].text.includes('Do not change files'));
  assert.equal(new Set<string>(tools.map(tool => tool.name)).has('ask_agent'), false);
  assert.deepEqual(await coordinator.invoke(call, 'retired-tool', 'ask_agent', { agentId: 'a', question: 'Legacy request' }), { error: 'Unknown tool' });
  assert.equal(sent.length, 1, 'retired tool calls are never silently converted into work');
});
