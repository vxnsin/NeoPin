export const MAX_ZOOM = 6;

// Where the photo sits inside the square crop frame. zoom 1 is the smallest size that still
// covers the frame, x and y move the photo's centre away from the frame's centre, in screen px.
export type CropView = { zoom: number; x: number; y: number };

export type CropRect = { originX: number; originY: number; width: number; height: number };

// Screen px per image px when the photo just covers the frame.
export function baseScale(imageWidth: number, imageHeight: number, frame: number): number {
  return frame / Math.min(imageWidth, imageHeight);
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, zoom));
}

// The photo may not leave a gap inside the frame.
export function clampView(imageWidth: number, imageHeight: number, frame: number, view: CropView): CropView {
  const zoom = clampZoom(view.zoom);
  const scale = baseScale(imageWidth, imageHeight, frame) * zoom;
  const maxX = Math.max(0, (imageWidth * scale - frame) / 2);
  const maxY = Math.max(0, (imageHeight * scale - frame) / 2);
  return {
    zoom,
    x: Math.min(maxX, Math.max(-maxX, view.x)) || 0,
    y: Math.min(maxY, Math.max(-maxY, view.y)) || 0,
  };
}

// The part of the photo, in image pixels, that the frame shows.
export function cropRect(imageWidth: number, imageHeight: number, frame: number, view: CropView): CropRect {
  const { zoom, x, y } = clampView(imageWidth, imageHeight, frame, view);
  const scale = baseScale(imageWidth, imageHeight, frame) * zoom;
  const size = Math.min(Math.round(frame / scale), imageWidth, imageHeight);
  const centreX = imageWidth / 2 - x / scale;
  const centreY = imageHeight / 2 - y / scale;
  return {
    originX: Math.min(imageWidth - size, Math.max(0, Math.round(centreX - size / 2))),
    originY: Math.min(imageHeight - size, Math.max(0, Math.round(centreY - size / 2))),
    width: size,
    height: size,
  };
}
