import type { PluginClientContext, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { TowerIcon } from './client/tower-icon';
import { TowerScreen } from './client/tower';
function TowerItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={TowerIcon} label="Tower" active={currentScreen?.screenId === 'tower'} onPress={() => openScreen({ screenId: 'tower' })} />;
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: 'tower', title: 'Tower', Component: TowerScreen });
  client.addSidebarHeaderItem({ id: 'tower', title: 'Tower', Component: TowerItem });
  return () => {};
}
