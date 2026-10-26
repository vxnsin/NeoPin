// Pins that are closer than this on screen (px) are drawn as one cluster marker.
export const CLUSTER_RADIUS_PX = 56;

export type ClusterPin = {
  key: string;
  // Screen position in px.
  x: number;
  y: number;
  // One id per person: two devices of the same person are one person.
  owner: string;
  // A pin that must stay on its own (the selected device).
  fixed?: boolean;
};

export type Cluster = { keys: string[]; x: number; y: number; owners: string[] };

// Greedy: the first pin (in key order) takes every free pin within the radius, the next free
// pin starts the next cluster. Single pins come back as clusters of one.
export function clusterPins(pins: ClusterPin[], radius: number): Cluster[] {
  const sorted = pins.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const limit = radius * radius;
  const used: boolean[] = [];
  const out: Cluster[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const seed = sorted[i];
    const members = [seed];
    if (!seed.fixed) {
      for (let j = i + 1; j < sorted.length; j++) {
        const other = sorted[j];
        if (used[j] || other.fixed) continue;
        const dx = other.x - seed.x;
        const dy = other.y - seed.y;
        if (dx * dx + dy * dy <= limit) {
          used[j] = true;
          members.push(other);
        }
      }
    }
    let sx = 0;
    let sy = 0;
    const keys: string[] = [];
    const owners: string[] = [];
    for (const member of members) {
      sx += member.x;
      sy += member.y;
      keys.push(member.key);
      if (owners.indexOf(member.owner) < 0) owners.push(member.owner);
    }
    out.push({ keys, x: sx / members.length, y: sy / members.length, owners });
  }
  return out;
}

// The same function for the WebView script, which cannot import. A jest test keeps both in step.
export const CLUSTER_SCRIPT = `function clusterPins(pins, radius) {
      var sorted = pins.slice().sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
      var limit = radius * radius;
      var used = [];
      var out = [];
      for (var i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        var seed = sorted[i];
        var members = [seed];
        if (!seed.fixed) {
          for (var j = i + 1; j < sorted.length; j++) {
            var other = sorted[j];
            if (used[j] || other.fixed) continue;
            var dx = other.x - seed.x;
            var dy = other.y - seed.y;
            if (dx * dx + dy * dy <= limit) { used[j] = true; members.push(other); }
          }
        }
        var sx = 0, sy = 0, keys = [], owners = [];
        for (var k = 0; k < members.length; k++) {
          sx += members[k].x;
          sy += members[k].y;
          keys.push(members[k].key);
          if (owners.indexOf(members[k].owner) < 0) owners.push(members[k].owner);
        }
        out.push({ keys: keys, x: sx / members.length, y: sy / members.length, owners: owners });
      }
      return out;
    }`;
