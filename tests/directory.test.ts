import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoApi, PaseoWorkspace } from '@getpaseo/client';
import { directory, workspaceSummary } from '../server/paseo.ts';

test('overview maps attached PRs across pages without guessing from titles or losing ambiguous owners', async () => {
  const base = { projectId: 'p', projectDisplayName: 'App', projectRootPath: '/app', projectKind: 'git', workspaceKind: 'worktree' };
  const workspaces = [
    { ...base, id: 'w1', name: 'Billing', workspaceDirectory: '/trees/billing', worktreeSlug: 'billing', gitRuntime: { currentBranch: 'fix-billing' }, githubRuntime: { refreshedAt: '2026-10-15T09:00:00Z', pullRequest: { number: 42, url: 'https://github.com/owner/app/pull/42', title: 'Fix', state: 'OPEN', headRefName: 'fix-billing', baseRefName: 'main' } } },
    { ...base, id: 'w2', name: 'Second owner', workspaceDirectory: '/trees/second', githubRuntime: { pullRequest: { url: 'https://github.com/owner/app/pull/42', title: 'Fix' } } },
    { ...base, id: 'w3', name: 'PR #99', workspaceDirectory: '/trees/no-pr', githubRuntime: { error: { message: 'Forge unavailable' } } },
  ];
  const agentPages: (string | undefined)[] = []; const workspacePages: (string | undefined)[] = [];
  const paseo = {
    agents: { list: async ({ page }: { page: { cursor?: string } }) => {
      agentPages.push(page.cursor);
      return { entries: [{ agent: { id: page.cursor ? 'a2' : 'a1', workspaceId: page.cursor ? 'w2' : 'w1', pendingPermissions: [] } }], pageInfo: { hasMore: !page.cursor, nextCursor: 'agents-next' } };
    } },
    workspaces: { list: async ({ page }: { page: { cursor?: string } }) => {
      workspacePages.push(page.cursor);
      return { entries: page.cursor ? workspaces.slice(1) : workspaces.slice(0, 1), pageInfo: { hasMore: !page.cursor, nextCursor: 'workspaces-next' } };
    } },
  } as unknown as PaseoApi;
  const overview = await directory(paseo);
  assert.deepEqual(agentPages, [undefined, 'agents-next']); assert.deepEqual(workspacePages, [undefined, 'workspaces-next']);
  assert.deepEqual(overview.prMappings.map(m => [m.workspaceId, m.pullRequest?.number, m.agentIds]), [['w1', 42, ['a1']], ['w2', 42, ['a2']]]);
  assert.equal(overview.workspaces[0].branch, 'fix-billing');
  assert.equal(overview.workspaces[1].worktreeName, 'second');
  assert.equal(overview.workspaces[1].worktreeNameSource, 'directory_basename');
  assert.equal(overview.workspaces[2].pullRequest, null);
  assert.equal(overview.workspaces[2].mappingError, 'Forge unavailable');
  assert.match(overview.mappingNote, /not globally unique/);
  const local = workspaceSummary({ ...base, id: 'local', name: 'Local', workspaceKind: 'directory', workspaceDirectory: '/app' } as PaseoWorkspace);
  assert.equal(local.worktreeName, null);
});
