import type { PluginServerContext } from '@getpaseo/plugin/server';
import { launchRpc, launchStatusRpc } from './shared/launch';
import { launchVoice, launchStatus } from './server/launch';
export default function contribute(server: PluginServerContext) {
  server.handle(launchRpc, launchVoice);
  server.handle(launchStatusRpc, launchStatus);
  return () => {};
}
