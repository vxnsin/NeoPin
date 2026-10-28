import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8 } from "fflate";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { recordPosition } from "../src/history.js";
import { gtfsSeconds, parseCsvLine, readTable, zipEntries } from "../src/gtfs.js";
import { activeCells, cellBounds, cellOf, feedsForCell, parseCatalog, readSlice, refreshTransit, resetTransit } from "../src/transit.js";
import { startServer } from "./helpers.js";
import { fakeTransitHost, gtfsText, gtfsZip } from "./gtfsFixture.js";

const DAY = 86_400_000;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "neopin-transit-"));
  config.transit = true;
  config.transitDir = dir;
  resetTransit();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const count = (table) => Number(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

test("CSV lines with quotes, and GTFS times past midnight", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseCsvLine('1,"Würzburg, Hbf","say ""hi""",'), ["1", "Würzburg, Hbf", 'say "hi"', ""]);
  assert.equal(gtfsSeconds("08:10:00"), 8 * 3600 + 600);
  assert.equal(gtfsSeconds("25:05"), 25 * 3600 + 300);
  assert.equal(gtfsSeconds(""), null);
});

test("tables are read straight out of the ZIP, deflated or stored, with or without a byte order mark", async () => {
  const text = gtfsText();
  text["stops.txt"] = "﻿" + text["stops.txt"];
  for (const level of [6, 0]) {
    const file = path.join(dir, `feed-${level}.zip`);
    fs.writeFileSync(file, gtfsZip({ level, text }));
    const entries = await zipEntries(file);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["agency.txt", "routes.txt", "shapes.txt", "stop_times.txt", "stops.txt", "trips.txt"]);
    const names = [];
    const found = await readTable(file, entries, "stops.txt", (col) => {
      assert.equal(col("stop_id"), 0, "the byte order mark is not part of the first column name");
      const name = col("stop_name");
      return (f) => names.push(f[name]);
    });
    assert.equal(found, true);
    assert.deepEqual(names, ["Sanderring", "Mainfranken Theater", "Juliuspromenade", "Hauptbahnhof", "München Hbf"]);
    assert.equal(await readTable(file, entries, "calendar.txt", () => () => {}), false);
  }
});

test("a slice holds only what touches the cell", async () => {
  const file = path.join(dir, "feed.zip");
  fs.writeFileSync(file, gtfsZip());
  const slice = await readSlice(file, { minLat: 49.7, maxLat: 49.9, minLon: 9.8, maxLon: 10.1 });
  assert.deepEqual(slice.stops.map((s) => s.id).sort(), ["A", "B", "C", "D"]);
  assert.deepEqual(slice.routes.map((r) => [r.shortName, r.type, r.color, r.agency, r.timezone]), [
    ["10", 3, "#e30613", "WVV", "Europe/Berlin"],
    ["3", 0, null, "WVV", "Europe/Berlin"],
  ]);
  assert.equal(slice.trips.length, 4);
  assert.equal(slice.stopTimes.length, 3 * 4 + 2);
  assert.ok(slice.shapes.length > 20);
  // Nothing of it inside Munich: no stops, so no trips, routes or shapes either.
  const munich = await readSlice(file, { minLat: 48.0, maxLat: 48.3, minLon: 11.3, maxLon: 11.8 });
  assert.deepEqual(munich, { stops: [], stopTimes: [], trips: [], routes: [], shapes: [] });
});

test("cells are about TRANSIT_REGION_KM wide and contain their points", () => {
  const cell = cellOf(49.7885, 9.933);
  assert.match(cell, /^\d+\.\d{3},\d+\.\d{3}$/);
  const b = cellBounds(cell);
  assert.ok(b.minLat <= 49.7885 && 49.7885 <= b.maxLat && b.minLon <= 9.933 && 9.933 <= b.maxLon);
  assert.ok(Math.abs((b.maxLat - b.minLat) * 111.32 - 30) < 0.5, "30 km high");
  assert.ok(Math.abs((b.maxLon - b.minLon) * 111.32 * Math.cos((49.7 * Math.PI) / 180) - 30) < 0.5, "30 km wide");
  assert.equal(cellOf(49.79, 9.94), cell, "the neighbouring street is the same cell");
  assert.notEqual(cellOf(48.14, 11.56), cell);
  const margin = cellBounds(cell, 5);
  assert.ok(margin.minLat < b.minLat && margin.maxLon > b.maxLon);
});

test("the catalog is reduced to free GTFS feeds with a sane rectangle", () => {
  const header =
    "mdb_source_id,data_type,provider,name,urls.direct_download,urls.authentication_type,urls.latest,urls.license,location.country_code,location.bounding_box.minimum_latitude,location.bounding_box.maximum_latitude,location.bounding_box.minimum_longitude,location.bounding_box.maximum_longitude,status,redirect.id";
  const feeds = parseCatalog(
    [
      header,
      "1,gtfs,WVV,Würzburg,https://x/wvv.zip,0,https://latest/1.zip,CC BY 4.0,DE,49.6,49.9,9.8,10.1,,",
      "2,gtfs-rt,WVV,Würzburg live,https://x/rt,0,,,DE,49.6,49.9,9.8,10.1,,",
      "3,gtfs,Keyed,Needs a key,https://x/k.zip,1,,,DE,49.6,49.9,9.8,10.1,,",
      "4,gtfs,Old,Deprecated,https://x/old.zip,0,,,DE,49.6,49.9,9.8,10.1,deprecated,",
      "5,gtfs,Moved,Redirected,https://x/moved.zip,0,,,DE,49.6,49.9,9.8,10.1,,1",
      "6,gtfs,World,Everything,https://x/world.zip,0,,,DE,-89.9,69.5,-170,179.9,,",
      "7,gtfs,Only copy,,,0,https://latest/7.zip,,FR,48.5,49.1,2,2.6,active,",
      // The real catalog has a provider list that spans two lines inside its quotes.
      '8,gtfs,"Bus A,\nBus B",Two lines,https://x/two.zip,0,,,TW,24,25,120,122,,',
    ].join("\n")
  );
  assert.deepEqual(
    feeds.map((f) => [f.source, f.name, f.url, f.latestUrl, f.license, f.country]),
    [
      ["mdb:1", "Würzburg", "https://x/wvv.zip", "https://latest/1.zip", "CC BY 4.0", "DE"],
      ["mdb:7", "Only copy", "https://latest/7.zip", null, null, "FR"],
      ["mdb:8", "Two lines", "https://x/two.zip", null, null, "TW"],
    ]
  );
});

test("a preferred country feed wins over the catalog pieces, border cells keep the neighbours", () => {
  const box = (minLat, maxLat, minLon, maxLon) => ({ minLat, maxLat, minLon, maxLon });
  const catalog = [
    { source: "mdb:1", country: "DE", bbox: box(49.6, 49.9, 9.7, 10.1) },
    { source: "mdb:2", country: "DE", bbox: box(47, 55, 6, 15) },
    { source: "mdb:3", country: "FR", bbox: box(42, 51, -5, 10) },
    { source: "mdb:4", country: "AT", bbox: box(46, 49, 9, 17) },
  ];
  const preferred = [{ source: "preferred:DE", country: "DE", bbox: box(47.2, 55.1, 5.8, 15.1) }];
  assert.deepEqual(
    feedsForCell(cellOf(49.79, 9.93), catalog, preferred).map((f) => f.source),
    ["preferred:DE", "mdb:3"]
  );
  // Without a preferred feed the catalog feeds covering the cell, the widest first.
  assert.deepEqual(
    feedsForCell(cellOf(49.79, 9.93), catalog, []).map((f) => f.source),
    ["mdb:3", "mdb:2", "mdb:1"]
  );
});

let s;
let luis;
let host;
beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
  host = await fakeTransitHost(gtfsZip());
  config.transitCatalogUrl = host.url;
});
afterEach(async () => {
  await host.close();
  await s.stop();
});

// A walk through town: a few fixes in the region, spaced so the thinning keeps them.
function beenHere(now, lat = 49.79, lon = 9.93) {
  for (let i = 0; i < 8; i++) recordPosition(luis.user.id, "phone", lat + i * 0.001, lon, now - (8 - i) * 10 * 60_000);
}

const status = async () => (await fetch(`${s.baseUrl}/api/transit`, { headers: { cookie: luis.cookie } })).json();

test("the feeds covering the regions with recent positions are imported, once a week", async () => {
  const now = Date.now();
  assert.deepEqual(activeCells(now), []);
  beenHere(now);
  const cell = cellOf(49.79, 9.93);
  assert.deepEqual(activeCells(now), [cell]);

  const first = await refreshTransit({ now, preferred: [] });
  assert.deepEqual(first, { regions: 1, imported: 1, failed: 0 });
  assert.equal(count("transit_stops"), 4, "the Munich stop is outside the slice");
  assert.equal(count("transit_routes"), 2);
  assert.equal(count("transit_trips"), 4);
  assert.equal(count("transit_stop_times"), 14);
  assert.ok(fs.existsSync(path.join(dir, "catalog.csv")) && fs.existsSync(path.join(dir, "mdb-9001.zip")));

  const body = await status();
  assert.equal(body.enabled, true);
  assert.equal(body.regions.length, 1);
  const [region] = body.regions;
  assert.equal(region.cell, cell);
  assert.equal(region.updatedAt, new Date(now).toISOString());
  assert.deepEqual(region.feeds, [
    { name: "Würzburg test feed", provider: "WVV", license: null, stops: 4, routes: 2, trips: 4, updatedAt: new Date(now).toISOString() },
  ]);
  assert.equal((await fetch(`${s.baseUrl}/api/transit`)).status, 401);

  // A day later nothing is downloaded again; a week later the catalog and the feed are.
  assert.deepEqual(await refreshTransit({ now: now + DAY, preferred: [] }), { regions: 1, imported: 0, failed: 0 });
  assert.deepEqual(host.calls, { catalog: 1, feed: 1 });
  const later = now + 8 * DAY;
  beenHere(later);
  assert.deepEqual(await refreshTransit({ now: later, preferred: [], force: true }), { regions: 1, imported: 1, failed: 0 });
  assert.deepEqual(host.calls, { catalog: 2, feed: 2 });
  assert.equal(count("transit_stops"), 4, "the old slice was replaced, not added to");
});

test("a region nobody has been in for 90 days loses its feeds", async () => {
  const now = Date.now();
  beenHere(now);
  await refreshTransit({ now, preferred: [] });
  assert.equal(count("transit_feeds"), 1);
  const result = await refreshTransit({ now: now + 100 * DAY, preferred: [] });
  assert.deepEqual(result, { regions: 0, imported: 0, failed: 0 });
  assert.equal(count("transit_feeds"), 0);
  assert.equal(count("transit_stops"), 0, "the slice went with the feed");
  assert.deepEqual((await status()).regions, []);
});

test("a preferred feed is downloaded from its own address, the catalog feed of its country is left out", async () => {
  const now = Date.now();
  beenHere(now);
  const preferred = [
    {
      source: "preferred:XX",
      country: "DE",
      name: "Test country",
      provider: "test",
      url: host.feedUrl,
      latestUrl: null,
      license: "CC BY 4.0",
      bbox: { minLat: 49, maxLat: 50.5, minLon: 9, maxLon: 11 },
    },
  ];
  await refreshTransit({ now, preferred });
  const [region] = (await status()).regions;
  assert.deepEqual(
    region.feeds.map((f) => [f.name, f.license, f.stops]),
    [["Test country", "CC BY 4.0", 4]]
  );
  assert.ok(fs.existsSync(path.join(dir, "preferred-XX.zip")));
});

test("a feed that cannot be read is reported and tried again next time", async () => {
  const now = Date.now();
  beenHere(now);
  host.setFeed(strToU8("this is not a zip"));
  assert.deepEqual(await refreshTransit({ now, preferred: [] }), { regions: 1, imported: 0, failed: 1 });
  const [region] = (await status()).regions;
  assert.equal(region.updatedAt, null);
  assert.equal(region.feeds[0].updatedAt, null);
  host.setFeed(gtfsZip());
  assert.deepEqual(await refreshTransit({ now, preferred: [], force: true }), { regions: 1, imported: 1, failed: 0 });
});

test("with TRANSIT off nothing is fetched and the status says so", async () => {
  config.transit = false;
  beenHere(Date.now());
  assert.deepEqual(await refreshTransit({ preferred: [] }), { regions: 0, imported: 0, failed: 0 });
  assert.deepEqual(await status(), { enabled: false, regions: [] });
  assert.deepEqual(host.calls, { catalog: 0, feed: 0 });
});
