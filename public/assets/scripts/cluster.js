// Groups points that are close on the screen. Plain function without exports, so the page can
// load it as a script and the tests can run the very same file.
//
// points: [{ id, x, y }] in pixels, threshold: pixels, keep: ids that always stay alone.
// Returns [{ ids, x, y }] where x and y are the centre of the group.
// The first point of a group is its seed, later points within the threshold of the seed join it.
function clusterPoints(points, threshold, keep = new Set()) {
  const groups = [];
  const taken = new Set();
  for (const seed of points) {
    if (taken.has(seed.id)) continue;
    taken.add(seed.id);
    const members = [seed];
    if (!keep.has(seed.id)) {
      for (const other of points) {
        if (taken.has(other.id) || keep.has(other.id)) continue;
        if (Math.hypot(other.x - seed.x, other.y - seed.y) < threshold) {
          taken.add(other.id);
          members.push(other);
        }
      }
    }
    groups.push({
      ids: members.map((m) => m.id),
      x: members.reduce((sum, m) => sum + m.x, 0) / members.length,
      y: members.reduce((sum, m) => sum + m.y, 0) / members.length,
    });
  }
  return groups;
}
