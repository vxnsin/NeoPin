import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { WebView as NativeWebView } from "react-native-webview";
import useThemeManager from "@/hooks/useThemeManager";
import { buildMapHtml } from "@/lib/mapHtml";
import { reviewRoute } from "@/lib/review";

type MapWebViewHandle = { postMessage: (message: string) => void };
type MapWebViewProps = {
  ref?: React.Ref<MapWebViewHandle>;
  source: { html: string };
  style: StyleProp<ViewStyle>;
  onLoad: () => void;
  originWhitelist: string[];
  scrollEnabled: boolean;
};

// The package's own props type collapses to never with this TypeScript version (as on the map screen).
const WebView = NativeWebView as unknown as React.ComponentType<MapWebViewProps>;

const HEIGHT = 200;

type Props = { path: [number, number][] };

// The period's line on the same map page as the timeline, small and still: it does not take touches,
// so the review scrolls over it.
export default function ReviewMap({ path }: Props) {
  const theme = useThemeManager();
  const ref = useRef<MapWebViewHandle>(null);
  const [loaded, setLoaded] = useState(false);
  // Built once, the theme follows as a message like on the map screen.
  const html = useMemo(() => buildMapHtml(theme.isDark, 0, 0), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loaded) ref.current?.postMessage(JSON.stringify({ type: "theme", dark: theme.isDark }));
  }, [loaded, theme.isDark]);

  useEffect(() => {
    if (!loaded) return;
    const segments = reviewRoute(path, theme.colors.secondary);
    ref.current?.postMessage(JSON.stringify(segments.length ? { type: "route", segments, bottom: 18, top: 18 } : { type: "routeClear" }));
  }, [loaded, path, theme.colors.secondary]);

  return (
    <View style={[styles.frame, { backgroundColor: theme.colors.subtle }]} pointerEvents="none">
      <WebView ref={ref} source={{ html }} style={styles.map} onLoad={() => setLoaded(true)} originWhitelist={["*"]} scrollEnabled={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: HEIGHT, borderRadius: 18, overflow: "hidden" },
  map: { flex: 1, backgroundColor: "transparent" },
});
