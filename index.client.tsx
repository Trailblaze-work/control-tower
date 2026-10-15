import type { PluginClientContext, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { VoiceScreen } from './client/voice';
function VoiceItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Mic" active={currentScreen?.screenId === 'voice'} onPress={() => openScreen({ screenId: 'voice' })} />;
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: 'voice', title: 'Voice coordinator', Component: VoiceScreen });
  client.addSidebarHeaderItem({ id: 'voice', title: 'Voice coordinator', Component: VoiceItem });
  return () => {};
}
