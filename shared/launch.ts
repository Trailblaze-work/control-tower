import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
export const launchRpc = defineRpc({ name: 'tower.launch', input: z.object({ embedOrigin: z.string().optional() }), output: z.object({ url: z.string().url(), localUrl: z.string().url(), settingsUrl: z.string().url(), embedUrl: z.string().url().optional() }) });
export const launchStatusRpc = defineRpc({ name: 'tower.launch_status', input: z.object({ url: z.string().url(), localUrl: z.string().url() }), output: z.object({ refresh: z.boolean() }) });
