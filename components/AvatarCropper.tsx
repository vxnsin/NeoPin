import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
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

// Full-screen crop: drag the photo and pinch to zoom, the circle shows what the picture will be.
// The gestures run natively, so two fingers work inside the modal on every phone.
export default function AvatarCropper({ photo, onCancel, onSave }: Props) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const frame = Math.min(screenWidth - 40, 340);
  const [view, setView] = useState<CropView>(START);
  const viewRef = useRef<CropView>(START);
  // Where the photo was when the fingers came down: a drag and a pinch each measure from there.
  const dragFrom = useRef<CropView>(START);
  const pinchFrom = useRef<CropView>(START);
  const photoRef = useRef<Photo | null>(null);
  photoRef.current = photo;

  useEffect(() => {
    viewRef.current = START;
    setView(START);
  }, [photo]);

  const gesture = useMemo(() => {
    const apply = (next: CropView) => {
      const current = photoRef.current;
      if (!current) return;
      const clamped = clampView(current.width, current.height, frame, next);
      viewRef.current = clamped;
      setView(clamped);
    };
    const drag = Gesture.Pan()
      .averageTouches(true)
      .onBegin(() => {
        dragFrom.current = viewRef.current;
      })
      .onUpdate((e) => {
        apply({ ...viewRef.current, x: dragFrom.current.x + e.translationX, y: dragFrom.current.y + e.translationY });
      });
    const pinch = Gesture.Pinch()
      .onStart(() => {
        pinchFrom.current = viewRef.current;
      })
      .onUpdate((e) => {
        apply({ ...viewRef.current, zoom: pinchFrom.current.zoom * e.scale });
      });
    return Gesture.Simultaneous(drag, pinch);
  }, [frame]);

  if (!photo) return null;

  const scale = baseScale(photo.width, photo.height, frame) * view.zoom;
  const shownWidth = photo.width * scale;
  const shownHeight = photo.height * scale;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      {/* A modal is its own window on Android, the gestures need their own root in it. */}
      <GestureHandlerRootView style={styles.root}>
        <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.title}>Move and zoom</Text>
          <View style={styles.stage}>
            <GestureDetector gesture={gesture}>
              <View style={[styles.frame, { width: frame, height: frame, borderRadius: frame / 2 }]} collapsable={false}>
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
            </GestureDetector>
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
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
