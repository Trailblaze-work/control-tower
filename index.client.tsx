import type { PluginClientContext, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { TowerIcon } from './client/tower-icon';
import { TowerScreen } from './client/tower';
function TowerItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={TowerIcon} label="Control Tower" active={currentScreen?.screenId === 'control-tower'} onPress={() => openScreen({ screenId: 'control-tower' })} />;
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: 'control-tower', title: 'Control Tower', Component: TowerScreen });
  client.addSidebarHeaderItem({ id: 'control-tower', title: 'Control Tower', Component: TowerItem });
  return () => {};
}
