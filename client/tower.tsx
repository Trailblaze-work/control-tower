import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { ExternalLink } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { TowerIcon } from './tower-icon';
import { CallFrame, embeddingOrigin } from './web';
import { launchRpc, launchStatusRpc } from '../shared/launch';
export function TowerScreen({ theme, layout, host }: PluginScreenProps) {
  const origin = layout.platform === 'web' ? embeddingOrigin() : undefined;
  const [frame, setFrame] = useState<{ host: string; url: string }>();
  const launch = useRpc(launchRpc);
  const checkStatus = useRpc(launchStatusRpc);
  const link = useQuery({ queryKey: ['tower-launch', host.id, origin], queryFn: () => launch({ embedOrigin: origin }), staleTime: 0, refetchInterval: 45000, retry: false });
  const { data, refetch } = link;
  useEffect(() => { if (data?.embedUrl && frame?.host !== host.id) setFrame({ host: host.id, url: data.embedUrl }); }, [data, frame, host.id]);
  const frameUrl = frame?.host === host.id ? frame.url : undefined;
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}><TowerIcon size={56} /><Text style={{ ...text, fontSize: 28, fontWeight: '600' }}>Control Tower</Text></View>
    <Text style={text}>Your agents, on frequency.</Text>
    <Text style={text}>Talk with your workspace coordinator here. Open the browser link if your device restricts embedded microphone access.</Text>
    {link.isPending && <Text style={text}>Preparing your private call link…</Text>}
    {link.error && <Text accessibilityRole="alert" style={text}>Start the Control Tower service on your laptop, then refresh this link.</Text>}
    {frameUrl && <View style={{ flex: 1, minHeight: 520 }}><CallFrame url={frameUrl} /></View>}
    {link.data && <>
      <ExternalLink href={link.data.url}>Open in browser</ExternalLink>
      <ExternalLink href={link.data.localUrl}>Open locally on the laptop</ExternalLink>
      <ExternalLink href={link.data.settingsUrl}>API key, spending and diagnostics (on laptop)</ExternalLink>
    </>}
    <Pressable accessibilityRole="button" onPress={() => void link.refetch()}><Text style={text}>Refresh private link</Text></Pressable>
    {!frameUrl && <Text style={text}>Your phone connects through a temporary Cloudflare tunnel. On the laptop, the local link works without the tunnel. Voice audio uses your configured OpenAI account. Car audio routing needs testing on your device.</Text>}
  </View>;
}
