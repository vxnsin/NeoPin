import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  GestureResponderEvent,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Photo } from "@/lib/avatar";
import { baseScale, clampView, cropRect, type CropRect, type CropView } from "@/lib/crop";

type Props = {
  // The photo to cut, null keeps the view closed.
  photo: Photo | null;
  onCancel: () => void;
  onSave: (rect: CropRect) => void;
};

const START: CropView = { zoom: 1, x: 0, y: 0 };

type Touches = { count: number; x: number; y: number; distance: number };

function readTouches(event: GestureResponderEvent): Touches {
  const touches = event.nativeEvent.touches;
  if (touches.length >= 2) {
    const [a, b] = touches;
    return {
      count: 2,
      x: (a.pageX + b.pageX) / 2,
      y: (a.pageY + b.pageY) / 2,
      distance: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1,
    };
  }
  const t = touches[0];
  return { count: 1, x: t?.pageX ?? 0, y: t?.pageY ?? 0, distance: 1 };
}

// Full-screen crop: drag the photo and pinch to zoom, the circle shows what the picture will be.
// Plain responders, so it behaves the same in Expo Go as in a build.
export default function AvatarCropper({ photo, onCancel, onSave }: Props) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const frame = Math.min(screenWidth - 40, 340);
  const [view, setView] = useState<CropView>(START);
  const viewRef = useRef<CropView>(START);
  const start = useRef({ view: START, touches: { count: 0, x: 0, y: 0, distance: 1 } as Touches });
  const photoRef = useRef<Photo | null>(null);
  photoRef.current = photo;

  useEffect(() => {
    viewRef.current = START;
    setView(START);
  }, [photo]);

  const responder = useMemo(() => {
    const baseline = (event: GestureResponderEvent) => {
      start.current = { view: viewRef.current, touches: readTouches(event) };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: baseline,
      onPanResponderMove: (event) => {
        const current = photoRef.current;
        if (!current) return;
        const touches = readTouches(event);
        // A finger came or went: measure from here, so the photo does not jump.
        if (touches.count !== start.current.touches.count) {
          baseline(event);
          return;
        }
        const from = start.current;
        const next = clampView(current.width, current.height, frame, {
          zoom: from.view.zoom * (touches.distance / from.touches.distance),
          x: from.view.x + (touches.x - from.touches.x),
          y: from.view.y + (touches.y - from.touches.y),
        });
        viewRef.current = next;
        setView(next);
      },
    });
  }, [frame]);

  if (!photo) return null;

  const scale = baseScale(photo.width, photo.height, frame) * view.zoom;
  const shownWidth = photo.width * scale;
  const shownHeight = photo.height * scale;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.title}>Move and zoom</Text>
        <View style={styles.stage}>
          <View style={[styles.frame, { width: frame, height: frame, borderRadius: frame / 2 }]} {...responder.panHandlers}>
            <Image
              source={{ uri: photo.uri }}
              style={{
                position: "absolute",
                width: shownWidth,
                height: shownHeight,
                left: frame / 2 - shownWidth / 2 + view.x,
                top: frame / 2 - shownHeight / 2 + view.y,
              }}
              pointerEvents="none"
            />
          </View>
          <View
            pointerEvents="none"
            style={[styles.ring, { width: frame + 4, height: frame + 4, borderRadius: (frame + 4) / 2 }]}
          />
        </View>
        <Text style={styles.hint}>Drag to move, pinch to zoom.</Text>
        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.cancel]} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.save]}
            onPress={() => onSave(cropRect(photo.width, photo.height, frame, view))}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000", paddingHorizontal: 20 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", textAlign: "center" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: { overflow: "hidden", backgroundColor: "#111" },
  ring: { position: "absolute", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },
  hint: { color: "rgba(255,255,255,0.7)", fontSize: 13, textAlign: "center", marginBottom: 16 },
  actions: { flexDirection: "row", gap: 12 },
  button: { flex: 1, height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  cancel: { backgroundColor: "rgba(255,255,255,0.16)" },
  save: { backgroundColor: "#d3171e" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
