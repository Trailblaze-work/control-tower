import type { PluginServerContext } from '@getpaseo/plugin/server';
import { launchRpc, launchStatusRpc } from './shared/launch';
import { launchTower, launchStatus } from './server/launch';
export default function contribute(server: PluginServerContext) {
  server.handle(launchRpc, launchTower);
  server.handle(launchStatusRpc, launchStatus);
  return () => {};
}
