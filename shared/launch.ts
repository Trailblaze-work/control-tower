import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
export const launchRpc = defineRpc({ name: 'voice.launch', input: z.object({}), output: z.object({ url: z.string().url(), localUrl: z.string().url(), settingsUrl: z.string().url() }) });
export const launchStatusRpc = defineRpc({ name: 'voice.launch_status', input: z.object({ url: z.string().url(), localUrl: z.string().url() }), output: z.object({ refresh: z.boolean() }) });
