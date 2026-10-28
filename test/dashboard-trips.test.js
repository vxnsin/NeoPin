import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The dashboard loads these files as plain scripts, so they are run the same way here.
const load = (name, names) => {
  const file = new URL(`../public/assets/scripts/${name}`, import.meta.url);
  return vm.runInNewContext(`${fs.readFileSync(file, "utf8")}\n({ ${names.join(", ")} });`);
};
const trips = load("trips.js", ["MODES", "MODE_CHOICES", "badgeColors", "tripColor", "tripIcon", "rideLabel", "stillPending", "segmentIndex", "safeColor"]);
const hidden = load("hidden.js", ["HIDDEN_FOREVER", "HIDE_CHOICES", "minutesUntilMorning", "hiddenLabel"]);
// Results come from another realm, a JSON round trip makes them comparable.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ride = (transit) => ({ type: "trip", start: 1, mode: "transit", transit, path: [] });
const line = { kind: "bus", line: "10", color: "#d3171e", textColor: "#ffffff", from: { name: "A" }, to: { name: "B" } };

test("a matched line draws in its own colour and shows its vehicle", () => {
  assert.equal(trips.tripColor(ride(line)), "#d3171e");
  assert.equal(trips.tripIcon(ride(line)), "#i-bus");
  assert.equal(trips.rideLabel(line), "Bus");
});

test("a trip without a line takes the colour and icon of its mode", () => {
  assert.equal(trips.tripColor({ type: "trip", mode: "cycling" }), trips.MODES.cycling.color);
  assert.equal(trips.tripIcon({ type: "trip", mode: "driving" }), "#i-car");
  // "This was: Transit" without a known line.
  assert.equal(trips.tripColor(ride(null)), trips.MODES.transit.color);
  assert.equal(trips.rideLabel(null), "Transit");
});

test("a gap is grey and dashed whatever its mode", () => {
  assert.equal(trips.tripColor({ type: "trip", mode: "driving", gap: true }), "#94a3b8");
  assert.equal(trips.tripIcon({ type: "trip", mode: "driving", gap: true }), "#i-gap");
});

test("only plain hex colours from a feed reach the page", () => {
  assert.equal(trips.safeColor("#0a0"), "#0a0");
  assert.equal(trips.safeColor("#00AA00"), "#00AA00");
  assert.equal(trips.safeColor("red;background:url(x)"), null);
  assert.equal(trips.safeColor("00aa00"), null);
  assert.equal(trips.tripColor(ride({ ...line, color: "url(x)" })), trips.MODES.transit.color);
});

test("a badge gets readable text when the feed names only the background", () => {
  assert.deepEqual(plain(trips.badgeColors(line)), { bg: "#d3171e", fg: "#ffffff" });
  assert.deepEqual(plain(trips.badgeColors({ color: "#ffd800" })), { bg: "#ffd800", fg: "#0f172a" });
  assert.deepEqual(plain(trips.badgeColors({ color: "#003" })), { bg: "#003", fg: "#ffffff" });
  assert.deepEqual(plain(trips.badgeColors({ color: null, textColor: null })), { bg: null, fg: null });
});

test("the chooser offers every mode and the way back to the guess last", () => {
  assert.deepEqual(plain(trips.MODE_CHOICES), ["walking", "cycling", "driving", "transit", "auto"]);
});

test("the day is asked for again while names or paths are pending", () => {
  assert.equal(trips.stillPending({ placesPending: true }), true);
  assert.equal(trips.stillPending({ pathsPending: true }), true);
  assert.equal(trips.stillPending({ placesPending: false, pathsPending: false }), false);
  assert.equal(trips.stillPending(null), false);
});

test("a focused segment is found again by its kind and start", () => {
  const day = [
    { type: "visit", start: 100 },
    { type: "trip", start: 200 },
    { type: "visit", start: 300 },
  ];
  assert.equal(trips.segmentIndex(day, { type: "visit", start: 300 }), 2);
  // A dismissed stop before it moves it up.
  assert.equal(trips.segmentIndex(day.slice(1), { type: "visit", start: 300 }), 1);
  assert.equal(trips.segmentIndex(day, { type: "trip", start: 100 }), -1);
  assert.equal(trips.segmentIndex(day, null), -1);
});

test("hiding until the morning ends at 7:00, never before", () => {
  assert.equal(hidden.minutesUntilMorning(new Date(2026, 9, 28, 22, 0, 0)), 9 * 60);
  assert.equal(hidden.minutesUntilMorning(new Date(2026, 9, 28, 6, 59, 30)), 1);
  // Right at 7 it is the next morning.
  assert.equal(hidden.minutesUntilMorning(new Date(2026, 9, 28, 7, 0, 0)), 24 * 60);
});

test("until I turn it off sends no minutes, the rest send theirs", () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);
  assert.deepEqual(plain(hidden.HIDE_CHOICES.map((c) => c.minutes(now))), [15, 30, 60, 180, 19 * 60, null]);
});

test("the label says how long the hiding lasts", () => {
  const now = new Date(2026, 9, 28, 12, 0, 0);
  assert.equal(hidden.hiddenLabel(hidden.HIDDEN_FOREVER, now), "Hidden until you turn it off");
  assert.match(hidden.hiddenLabel(new Date(2026, 9, 28, 14, 35).getTime(), now), /^Hidden until \d/);
  assert.match(hidden.hiddenLabel(new Date(2026, 9, 29, 7, 0).getTime(), now), /^Hidden until tomorrow, /);
});
