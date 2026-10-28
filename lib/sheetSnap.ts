// The timeline panel rests at one of three heights, the finger moves it between them.
export type Snaps = { low: number; mid: number; high: number };

// Pulled this far below the lowest rest, the panel closes.
export const CLOSE_PULL = 60;
// A flick, in px/s: the panel moves one rest in that direction, however short the pull.
export const FLICK = 500;

export function panelSnaps(windowHeight: number, topInset: number): Snaps {
  return {
    low: Math.round(windowHeight * 0.3),
    mid: Math.round(windowHeight * 0.55),
    high: Math.round(windowHeight - topInset - 24),
  };
}

// While the finger drags, the panel follows but not beyond the top or far below the lowest rest.
export function clampDrag(height: number, snaps: Snaps): number {
  return Math.min(snaps.high, Math.max(snaps.low - CLOSE_PULL - 40, height));
}

// Where the panel comes to rest when the finger lets go, null closes it.
export function restAfterDrag(height: number, velocityDown: number, snaps: Snaps): number | null {
  const rests = [snaps.low, snaps.mid, snaps.high];
  if (height < snaps.low - CLOSE_PULL) return null;
  if (velocityDown > FLICK) {
    const below = rests.filter((rest) => rest < height);
    return below.length ? Math.max(...below) : null;
  }
  if (velocityDown < -FLICK) {
    const above = rests.filter((rest) => rest > height);
    return above.length ? Math.min(...above) : snaps.high;
  }
  return rests.reduce((best, rest) => (Math.abs(rest - height) < Math.abs(best - height) ? rest : best), snaps.mid);
}
