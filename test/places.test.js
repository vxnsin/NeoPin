import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config } from "../src/config.js";
import { recordPosition } from "../src/history.js";
import { bestCandidate, kindForTags, openAt, toCandidates } from "../src/places.js";
import { deviceHeaders, startServer } from "./helpers.js";

const MIN = 60_000;
// 2025-06-10 is a Tuesday. Times below are UTC, the tests ask with tz=0.
const DAY = "2025-06-10";
const DAY0 = Date.UTC(2025, 5, 10);

// A stand-in for Overpass: answers every query with `elements` and counts the requests.
function fakeOverpass(elements) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push(new URLSearchParams(body).get("data"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ elements }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/api/interpreter`, calls, close: () => server.close() })
    )
  );
}

const cafe = { type: "node", id: 1, lat: 49.79405, lon: 9.95105, tags: { amenity: "cafe", name: "Café Mohr", opening_hours: "Mo-Sa 08:00-18:00" } };
const office = { type: "way", id: 2, center: { lat: 49.7942, lon: 9.9512 }, tags: { office: "company", name: "Flyeralarm" } };
const busStop = { type: "node", id: 3, lat: 49.794, lon: 9.951, tags: { highway: "bus_stop", name: "Sanderring" } };

let s;
let luis;
let overpass;

beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  overpass = await fakeOverpass([cafe, office, busStop]);
  config.placeLookupUrl = overpass.url;
});

afterEach(async () => {
  config.placeLookupUrl = null;
  overpass.close();
  await s.stop();
});

// A stay of `minutes` at the spot, starting at `start` minutes after midnight.
function stay(start, minutes, lat = 49.794, lon = 9.951) {
  for (let m = 0; m <= minutes; m += 5) recordPosition(luis.user.id, "phone", lat, lon, DAY0 + (start + m) * MIN);
}

const api = (path, init = {}) =>
  fetch(`${s.baseUrl}/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...deviceHeaders("phone", luis.token), ...init.headers },
  });

const timeline = async () => (await api(`/timeline?deviceId=phone&date=${DAY}&tz=0`)).json();

test("OSM tags turn into a few kinds, things nobody stays at are left out", () => {
  assert.equal(kindForTags({ amenity: "cafe" }), "cafe");
  assert.equal(kindForTags({ shop: "supermarket" }), "grocery");
  assert.equal(kindForTags({ shop: "shoes" }), "shop");
  assert.equal(kindForTags({ railway: "station" }), "station");
  assert.equal(kindForTags({ office: "it" }), "work");
  assert.equal(kindForTags({ building: "train_station", name: "Würzburg Hbf" }), "station");
  assert.equal(kindForTags({ highway: "bus_stop" }), null);
  assert.deepEqual(
    toCandidates([cafe, office, busStop]).map((c) => [c.osmId, c.kind]),
    [
      ["node/1", "cafe"],
      ["way/2", "work"],
    ]
  );
});

test("opening hours: the common forms are read, the rest is unknown", () => {
  assert.equal(openAt("Mo-Fr 08:00-18:00", 2, 9 * 60), true);
  assert.equal(openAt("Mo-Fr 08:00-18:00", 2, 20 * 60), false);
  assert.equal(openAt("Mo-Fr 08:00-18:00", 0, 9 * 60), false);
  assert.equal(openAt("Mo-Fr 08:00-12:00,13:00-18:00; Sa 09:00-14:00", 6, 10 * 60), true);
  assert.equal(openAt("Fr-Sa 20:00-03:00", 6, 60), true, "past midnight");
  assert.equal(openAt("24/7", 3, 0), true);
  assert.equal(openAt("sunrise-sunset", 3, 600), null);
  assert.equal(openAt(undefined, 3, 600), null);
});

test("the café wins while it is open, the office when the café is closed", () => {
  const candidates = toCandidates([cafe, office]);
  const at = (hour) => ({ lat: 49.794, lon: 9.951, start: DAY0 + hour * 60 * MIN, end: DAY0 + (hour + 1) * 60 * MIN, durationMs: 60 * MIN });
  assert.equal(bestCandidate(candidates, at(10)).name, "Café Mohr");
  assert.equal(bestCandidate(candidates, at(21)).name, "Flyeralarm");
});

test("at a station the station wins over the shops inside it", () => {
  const bakery = { osmId: "node/5", name: "Bakery", kind: "grocery", lat: 49.8015, lon: 9.9353 };
  const hbf = { osmId: "way/6", name: "Würzburg Hbf", kind: "station", lat: 49.8019, lon: 9.9355 };
  const visit = { lat: 49.8015, lon: 9.9353, start: DAY0, end: DAY0 + 20 * MIN, durationMs: 20 * MIN };
  assert.equal(bestCandidate([bakery, hbf], visit).name, "Würzburg Hbf");
});

test("a visit gets its place from OpenStreetMap, each spot is asked once", async () => {
  stay(10 * 60, 40);
  const first = await timeline();
  const [visit] = first.segments.filter((seg) => seg.type === "visit");
  assert.deepEqual(visit.place, { id: null, name: "Café Mohr", kind: "cafe", source: "osm", osmId: "node/1" });
  assert.equal(first.placesPending, false);

  await timeline();
  assert.equal(overpass.calls.length, 1, "the second load comes from the cache");
  assert.match(overpass.calls[0], /around:120,/);
});

test("a confirmed place wins the next time, also over a closer OSM place", async () => {
  stay(10 * 60, 40);
  const saved = await api("/places", {
    method: "POST",
    body: JSON.stringify({ lat: 49.794, lon: 9.951, name: "Arbeit", kind: "work" }),
  });
  assert.equal(saved.status, 200);
  const place = await saved.json();
  assert.equal(place.radiusM, 60);

  const [visit] = (await timeline()).segments.filter((seg) => seg.type === "visit");
  assert.deepEqual(visit.place, { id: place.id, name: "Arbeit", kind: "work", source: "own", osmId: null });

  // Picking another name at the same spot corrects that place instead of adding one.
  await api("/places", { method: "POST", body: JSON.stringify({ lat: 49.7941, lon: 9.951, name: "Café Mohr", kind: "cafe", osmId: "node/1" }) });
  const places = await (await api("/places")).json();
  assert.deepEqual(places.map((p) => [p.id, p.name, p.osmId]), [[place.id, "Café Mohr", "node/1"]]);
});

test("claiming an own place for a spot grows it and makes closer ones let go", async () => {
  const post = async (body) => (await api("/places", { method: "POST", body: JSON.stringify(body) })).json();
  // Work first: a spot inside an own place would rename that place instead of adding one.
  const work = await post({ lat: 49.7946, lon: 9.951, name: "Work", kind: "work", radiusM: 30 });
  const home = await post({ lat: 49.794, lon: 9.951, name: "Home", kind: "home", radiusM: 200 });
  // About 22 m from home and 44 m from work: home covers it and is closer.
  const spot = { lat: 49.7942, lon: 9.951 };
  stay(10 * 60, 40, spot.lat, spot.lon);
  const claimed = await api(`/places/${work.id}/claim`, { method: "POST", body: JSON.stringify(spot) });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).radiusM, 70);

  const [visit] = (await timeline()).segments.filter((seg) => seg.type === "visit");
  assert.equal(visit.place.name, "Work");
  const places = Object.fromEntries((await (await api("/places")).json()).map((p) => [p.name, p.radiusM]));
  assert.equal(places.Home, 21, "home shrank just enough");

  // Claiming again never shrinks the place.
  const again = await api(`/places/${work.id}/claim`, { method: "POST", body: JSON.stringify({ lat: 49.7946, lon: 9.951 }) });
  assert.equal((await again.json()).radiusM, 70);
  assert.equal((await api(`/places/${home.id + 99}/claim`, { method: "POST", body: JSON.stringify(spot) })).status, 404);
});

test("tagging a spot as home or work needs no name", async () => {
  const post = async (body) => {
    const res = await api("/places", { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  assert.equal((await post({ lat: 49.794, lon: 9.951, kind: "home" })).name, "Home");
  assert.equal((await post({ lat: 49.8, lon: 9.9, kind: "home" })).name, "Home 2", "a second home elsewhere");
  assert.equal((await post({ lat: 49.81, lon: 9.9, kind: "work" })).name, "Work");
  assert.equal((await post({ lat: 49.794, lon: 9.951, kind: "home" })).name, "Home", "the same spot again keeps its name");
  assert.equal((await post({ lat: 49.794, lon: 9.951, kind: "work" })).name, "Work 2", "retagged, and Work is taken");
  const shop = await post({ lat: 49.82, lon: 9.9, kind: "shop" });
  assert.equal(shop.status, 400);
  assert.equal(shop.type, "name-required");
});

test("rename, radius and delete an own place", async () => {
  const place = await (await api("/places", { method: "POST", body: JSON.stringify({ lat: 49.8, lon: 9.9, name: "Home" }) })).json();
  const renamed = await api(`/places/${place.id}`, { method: "PATCH", body: JSON.stringify({ name: "Zuhause", kind: "home", radiusM: 120 }) });
  assert.deepEqual(
    (({ name, kind, radiusM }) => ({ name, kind, radiusM }))(await renamed.json()),
    { name: "Zuhause", kind: "home", radiusM: 120 }
  );
  assert.equal((await api(`/places/${place.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await api(`/places/${place.id}`, { method: "DELETE" })).status, 404);
  assert.deepEqual(await (await api("/places")).json(), []);
});

test("nearby lists own places first, then OSM, nearest first", async () => {
  await api("/places", { method: "POST", body: JSON.stringify({ lat: 49.7945, lon: 9.951, name: "Uni" }) });
  const choices = await (await api("/places/nearby?lat=49.794&lon=9.951")).json();
  assert.deepEqual(
    choices.map((c) => [c.name, c.source]),
    [
      ["Uni", "own"],
      ["Café Mohr", "osm"],
      ["Flyeralarm", "osm"],
    ]
  );
  assert.ok(choices.every((c, i) => i === 0 || c.source !== choices[i - 1].source || c.distanceM >= choices[i - 1].distanceM));
});

test("another account sees neither the places nor can change them", async () => {
  const place = await (await api("/places", { method: "POST", body: JSON.stringify({ lat: 49.8, lon: 9.9, name: "Home" }) })).json();
  const anna = await s.account("anna");
  const asAnna = (path, init = {}) =>
    fetch(`${s.baseUrl}/api${path}`, { ...init, headers: { "content-type": "application/json", cookie: anna.cookie } });
  assert.deepEqual(await (await asAnna("/places")).json(), []);
  assert.equal((await asAnna(`/places/${place.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await asAnna(`/places?userId=${luis.user.id}`)).status, 403);
});

test("without a lookup service a visit simply has no place", async () => {
  config.placeLookupUrl = null;
  stay(10 * 60, 40);
  const result = await timeline();
  const [visit] = result.segments.filter((seg) => seg.type === "visit");
  assert.equal(visit.place, null);
  assert.equal(result.placesPending, false);
  assert.equal(overpass.calls.length, 0);
});

test("when Overpass is busy, Photon names the place", async () => {
  const busy = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 502;
    res.end("at capacity");
  });
  const photonCalls = [];
  const photon = http.createServer((req, res) => {
    photonCalls.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        features: [
          { geometry: { coordinates: [9.95105, 49.79405] }, properties: { osm_type: "N", osm_id: 9, osm_key: "amenity", osm_value: "cafe", name: "Café Mohr" } },
          { geometry: { coordinates: [9.951, 49.794] }, properties: { osm_type: "W", osm_id: 8, osm_key: "highway", osm_value: "footway", name: "Weg" } },
        ],
      })
    );
  });
  await Promise.all([busy, photon].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  config.placeLookupUrl = `http://127.0.0.1:${busy.address().port}/api/interpreter`;
  config.placeFallbackUrl = `http://127.0.0.1:${photon.address().port}/reverse`;
  try {
    stay(10 * 60, 40);
    const [visit] = (await timeline()).segments.filter((seg) => seg.type === "visit");
    assert.deepEqual(visit.place, { id: null, name: "Café Mohr", kind: "cafe", source: "osm", osmId: "node/9" });
    assert.match(photonCalls[0], /radius=0\.12/);
  } finally {
    config.placeFallbackUrl = null;
    busy.close();
    photon.close();
  }
});
