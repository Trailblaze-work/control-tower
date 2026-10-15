import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { ExternalLink } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { launchRpc, launchStatusRpc } from '../shared/launch';
export function VoiceScreen({ theme, layout, host }: PluginScreenProps) {
  const launch = useRpc(launchRpc);
  const checkStatus = useRpc(launchStatusRpc);
  const link = useQuery({ queryKey: ['paseo-voice-launch', host.id], queryFn: () => launch({}), staleTime: 0, refetchInterval: 45000, retry: false });
  const { data, refetch } = link;
  useEffect(() => {
    if (!data) return;
    let disposed = false;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void checkStatus(data).then(status => {
        if (!disposed && status.refresh) void refetch();
      }).catch(() => {
        if (!disposed) void refetch();
      }).finally(() => { checking = false; });
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [data, checkStatus, refetch]);
  const text = { color: theme.colors.foreground };
  return <View style={{ padding: layout.compact ? 16 : 24, gap: 20, backgroundColor: theme.colors.surface0, flex: 1 }}>
    <Text style={{ ...text, fontSize: 24, fontWeight: '600' }}>Talk through your work.</Text>
    <Text style={text}>Start a live conversation with your workspace coordinator. The call page runs on your laptop and opens in your browser.</Text>
    {link.isPending && <Text style={text}>Preparing your private call link…</Text>}
    {link.error && <Text accessibilityRole="alert" style={text}>Start the Paseo Voice service on your laptop, then refresh this link.</Text>}
    {link.data && <>
      <ExternalLink href={link.data.url}>Talk on this device</ExternalLink>
      <ExternalLink href={link.data.localUrl}>Talk locally on the laptop</ExternalLink>
      <ExternalLink href={link.data.settingsUrl}>API key, spending and diagnostics (on laptop)</ExternalLink>
    </>}
    <Pressable accessibilityRole="button" onPress={() => void link.refetch()}><Text style={text}>Refresh private link</Text></Pressable>
    <Text style={text}>Your phone connects through a temporary Cloudflare tunnel. On the laptop, the local link works without the tunnel. Voice audio uses your configured OpenAI account. Car audio routing needs testing on your device.</Text>
  </View>;
}
