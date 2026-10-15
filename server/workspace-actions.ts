import type { PaseoApi } from '@getpaseo/client';
import { renameRequestSchema, type WorkspaceSummary } from './workspace-requests.ts';
import { errorCode, type Reporter } from './telemetry.ts';

export async function renameWorkspace(paseo: PaseoApi, known: Map<string, WorkspaceSummary>, raw: unknown, requestId: string, report: Reporter) {
  const args = renameRequestSchema.parse(raw);
  const observed = known.get(args.workspaceId);
  if (!observed) return { error: 'Use get_overview first and choose the workspace to rename.' };
  const workspace = paseo.workspaces.ref(args.workspaceId);
  const fresh = await workspace.refresh();
  if (!fresh || fresh.archivingAt) return { error: 'Workspace is unavailable or being archived. Refresh the overview.' };
  if (fresh.title === args.title) return { status: 'completed', kind: 'workspace_rename', executed: false, workspaceId: args.workspaceId, title: args.title, instruction: 'The workspace already has that title.' };
  if (fresh.name !== observed.name || fresh.projectId !== observed.projectId || fresh.workspaceDirectory !== observed.directory) return { error: 'Workspace identity or name changed since discovery. Refresh the overview before renaming.' };
  try {
    const result = await workspace.setTitle(args.title, requestId);
    if (result.title !== args.title) throw new Error('Unexpected title acknowledgement');
    known.set(args.workspaceId, { ...observed, title: args.title, name: args.title });
    report({ event: 'workspace_rename', outcome: 'completed' });
    return { status: 'completed', kind: 'workspace_rename', executed: true, workspaceId: args.workspaceId, previousName: fresh.name, title: result.title,
      instruction: 'The display title was renamed successfully. Report the outcome briefly. Branch and worktree directory are unchanged.' };
  } catch (error) {
    report({ event: 'workspace_rename', outcome: 'unknown', code: errorCode(error) });
    return { status: 'unknown', kind: 'workspace_rename', error: 'Rename acknowledgement was lost or invalid. Read a fresh overview to check the actual title before retrying.' };
  }
}
