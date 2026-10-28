// The timeline panel rests at one of four heights, the finger moves it between them. The lowest
// shows only the header: the map gets almost the whole screen, the day stays drawn on it, and
// the panel never goes away by dragging. Closing is the button in the header.
export type Snaps = { peek: number; low: number; mid: number; high: number };

// The header strip: top padding, grabber, the title row and the bottom padding, without the
// safe-area inset, which panelSnaps adds.
export const PEEK_CONTENT = 78;
// How far the finger can pull the panel below its lowest rest before it stops following.
export const OVERSHOOT = 40;
// A flick, in px/s: the panel moves one rest in that direction, however short the pull.
export const FLICK = 500;

export function panelSnaps(windowHeight: number, topInset: number, bottomInset = 0): Snaps {
  return {
    peek: PEEK_CONTENT + bottomInset,
    low: Math.round(windowHeight * 0.3),
    mid: Math.round(windowHeight * 0.55),
    high: Math.round(windowHeight - topInset - 24),
  };
}

// While the finger drags, the panel follows but not beyond the top or far below the lowest rest.
export function clampDrag(height: number, snaps: Snaps): number {
  return Math.min(snaps.high, Math.max(snaps.peek - OVERSHOOT, height));
}

// Where the panel comes to rest when the finger lets go.
export function restAfterDrag(height: number, velocityDown: number, snaps: Snaps): number {
  const rests = [snaps.peek, snaps.low, snaps.mid, snaps.high];
  if (velocityDown > FLICK) {
    const below = rests.filter((rest) => rest < height);
    return below.length ? Math.max(...below) : snaps.peek;
  }
  if (velocityDown < -FLICK) {
    const above = rests.filter((rest) => rest > height);
    return above.length ? Math.min(...above) : snaps.high;
  }
  return rests.reduce((best, rest) => (Math.abs(rest - height) < Math.abs(best - height) ? rest : best), snaps.mid);
}
