// A tapped notification asks the map screen to open a sheet. The screen may not be mounted yet (cold start),
// so the request waits here until it takes it.
export type RequestedSheet = "groups" | "notifications";

let pending: RequestedSheet | null = null;
const listeners = new Set<(sheet: RequestedSheet) => void>();

export function requestSheet(sheet: RequestedSheet) {
  pending = sheet;
  listeners.forEach((listener) => listener(sheet));
}

export function takeRequestedSheet(): RequestedSheet | null {
  const sheet = pending;
  pending = null;
  return sheet;
}

export function onSheetRequest(listener: (sheet: RequestedSheet) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
