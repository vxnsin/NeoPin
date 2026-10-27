import type { Message } from "./SocketClient";
import { distanceM } from "./fixes";

// "Find me": the state of one search as the server's messages move it along, and the maths
// for the arrow. The server only forwards; the app works out direction and distance itself.

export type FindPeer = { id: number; username: string; displayName: string; avatarUrl: string | null };

export type FindFix = { latitude: number; longitude: number; accuracy: number | null; heading: number | null; at: number };

export type FindState =
  // Somebody asks to find me, the question is open.
  | { phase: "asked"; session: string; peer: FindPeer; expiresAt: number }
  // I asked, the other side has not answered yet.
  | { phase: "pending"; session: string; peer: FindPeer; expiresAt: number }
  // Both sides share positions.
  | { phase: "active"; session: string; peer: FindPeer; expiresAt: number; theirs: FindFix | null }
  | { phase: "ended"; session: string | null; peer: FindPeer | null; reason: string };

// What the server sends while a search runs.
export const FIND_MESSAGES = ["findRequest", "findPending", "findStarted", "findPosition", "findEnded"];

// The next state after a server message. Messages for another session are ignored, except a
// fresh request, which always counts.
export function reduceFind(state: FindState | null, msg: Message): FindState | null {
  switch (msg.type) {
    case "findRequest":
      // While I search myself, nobody else gets through.
      if (state && (state.phase === "pending" || state.phase === "active")) return state;
      return { phase: "asked", session: msg.session, peer: msg.from, expiresAt: msg.expiresAt };
    case "findPending":
      return { phase: "pending", session: msg.session, peer: msg.peer, expiresAt: msg.expiresAt };
    case "findStarted":
      return { phase: "active", session: msg.session, peer: msg.peer, expiresAt: msg.expiresAt, theirs: null };
    case "findPosition":
      if (state?.phase !== "active" || state.session !== msg.session) return state;
      return {
        ...state,
        theirs: { latitude: msg.latitude, longitude: msg.longitude, accuracy: msg.accuracy ?? null, heading: msg.heading ?? null, at: msg.at },
      };
    case "findEnded":
      // A refused request has no session, every other end names the one it ends.
      if (msg.session !== null && state && state.phase !== "ended" && state.session !== msg.session) return state;
      return { phase: "ended", session: msg.session, peer: state?.peer ?? null, reason: msg.reason };
    default:
      return state;
  }
}

// The way from a to b, degrees clockwise from north.
export function bearingDeg(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(b.latitude * rad);
  const x = Math.cos(a.latitude * rad) * Math.sin(b.latitude * rad) - Math.sin(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// How far to turn the arrow on screen: the bearing minus where the phone points, -180..180.
export function arrowAngle(bearing: number, heading: number): number {
  return ((((bearing - heading) % 360) + 540) % 360) - 180;
}

export function formatMeters(m: number): string {
  if (m < 10) return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// Far: a map does the job. Near: the arrow. Close: GPS wobbles more than the distance left.
export type DistanceBand = "far" | "near" | "close";
export const FAR_M = 150;
export const CLOSE_M = 20;

export function distanceBand(m: number): DistanceBand {
  if (m > FAR_M) return "far";
  if (m > CLOSE_M) return "near";
  return "close";
}

export function hintFor(band: DistanceBand, hasHeading: boolean): string {
  if (band === "far") return "Still a way to go. The map knows the streets.";
  if (band === "close") return "Very close. Look around, GPS cannot tell the last few metres.";
  return hasHeading ? "Follow the arrow." : "Turn until the distance drops. Your phone has no compass reading yet.";
}

export function distanceBetween(mine: { latitude: number; longitude: number }, theirs: { latitude: number; longitude: number }): number {
  return distanceM(mine, theirs);
}

// Walking directions in the phone's maps app. Android prefers Google Maps navigation and falls
// back to any maps app, iOS opens Apple Maps.
export function mapsUrls(platform: "ios" | "android" | string, lat: number, lon: number): string[] {
  const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (platform === "ios") return [`maps://?daddr=${at}&dirflg=w`, `https://maps.apple.com/?daddr=${at}&dirflg=w`];
  return [`google.navigation:q=${at}&mode=w`, `geo:${at}?q=${at}`, `https://www.google.com/maps/dir/?api=1&destination=${at}&travelmode=walking`];
}

export function endedText(reason: string, name: string | null): string {
  const who = name ?? "The other side";
  switch (reason) {
    case "declined":
      return `${who} said no.`;
    case "offline":
      return `${who} has no phone online right now.`;
    case "unavailable":
      return `${who} cannot be found right now.`;
    case "timeout":
      return "Time ran out.";
    case "answered":
      return "Answered on another of your devices.";
    case "disconnected":
      return `${who} lost the connection.`;
    case "replaced":
      return "You started another search.";
    case "met":
      return "You found each other.";
    default:
      return "The search ended.";
  }
}
