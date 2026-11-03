import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { config, defaultMaxCoords, ownOsrm } from "../src/config.js";
import { checkOsrm } from "../src/paths.js";

test("an OSRM of your own is a Compose service, localhost or a private address, never the public one", () => {
  for (const url of [
    "http://osrm-{profile}:5000",
    "http://osrm-car:5000/",
    "http://localhost:5000",
    "http://127.0.0.1:5001",
    "http://10.0.0.7:5000",
    "http://192.168.1.20:5000/routed-{profile}",
    "http://172.20.0.3:5000",
    "http://[::1]:5000",
    "http://osrm.localhost:5000",
  ])
    assert.ok(ownOsrm(url), url);
  for (const url of [
    "https://routing.openstreetmap.de/routed-{profile}",
    "https://router.project-osrm.org",
    "http://172.32.0.1:5000",
    "http://8.8.8.8:5000",
    "not a url",
    "",
  ])
    assert.ok(!ownOsrm(url), url);
});

test("the own OSRM gets 100 points a request unasked, everything else stays at ten", () => {
  assert.equal(defaultMaxCoords("http://osrm-{profile}:5000"), 100);
  assert.equal(defaultMaxCoords("https://routing.openstreetmap.de/routed-{profile}"), 10);
  assert.equal(defaultMaxCoords("https://osrm.example.com/{profile}"), 10);
  assert.equal(defaultMaxCoords(null), 10);
  // Without anything set the public server and ten, as before.
  if (!process.env.ROAD_MATCH_URL && !process.env.ROAD_MATCH_MAX_COORDS) assert.equal(config.roadMatchMaxCoords, 10);
});

// An OSRM per profile behind one port: /routed-car/... and so on. `down` profiles answer 502
// without a body, the way a proxy does while the service is not there.
function fakeOsrm(down = new Set()) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const profile = /^\/routed-(\w+)\//.exec(req.url)?.[1];
    asked.push(req.url);
    if (down.has(profile)) {
      res.statusCode = 502;
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: "Ok", waypoints: [{ location: [11.4, 50.25], distance: 5e6 }] }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/routed-{profile}`,
        asked,
        down,
        close: () => new Promise((done) => server.close(done)),
      })
    )
  );
}

const saved = { roadMatch: config.roadMatch, roadMatchUrl: config.roadMatchUrl, roadMatchFallback: config.roadMatchFallback };
afterEach(() => Object.assign(config, saved));

function logs(t) {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  t.mock.method(console, "warn", (line) => lines.push(line));
  return lines;
}

test("at startup the own OSRM is asked for all three profiles and says so in one line", async (t) => {
  const osrm = await fakeOsrm();
  t.after(() => osrm.close());
  const lines = logs(t);
  Object.assign(config, { roadMatch: "osrm", roadMatchUrl: osrm.url });
  assert.equal(await checkOsrm({ retryMs: 10 }), true);
  assert.deepEqual(osrm.asked.sort(), ["car", "bike", "foot"].map((p) => `/routed-${p}/nearest/v1/driving/0,0`).sort());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /answers for car, bike and foot/);
});

test("an OSRM still preparing is asked again until it answers, with one warning before", async (t) => {
  const osrm = await fakeOsrm(new Set(["bike", "foot"]));
  t.after(() => osrm.close());
  const lines = logs(t);
  // The own matcher with OSRM standing in asks it too.
  Object.assign(config, { roadMatch: "own", roadMatchFallback: true, roadMatchUrl: osrm.url });
  setTimeout(() => osrm.down.clear(), 60);
  assert.equal(await checkOsrm({ retryMs: 20 }), true);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0], /does not answer for bike, foot yet/);
  assert.match(lines[1], /answers for car, bike and foot/);
});

test("one that never answers is given up on after its tries", async (t) => {
  const osrm = await fakeOsrm(new Set(["car"]));
  t.after(() => osrm.close());
  const lines = logs(t);
  Object.assign(config, { roadMatch: "osrm", roadMatchUrl: osrm.url });
  assert.equal(await checkOsrm({ retryMs: 5, tries: 3 }), false);
  assert.equal(osrm.asked.filter((u) => u.startsWith("/routed-car/")).length, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /still does not answer for car/);
});

test("nobody is asked for the public server, without OSRM or with road matching off", async (t) => {
  const osrm = await fakeOsrm();
  t.after(() => osrm.close());
  const lines = logs(t);
  Object.assign(config, { roadMatch: "osrm", roadMatchUrl: "https://routing.openstreetmap.de/routed-{profile}" });
  assert.equal(await checkOsrm(), null);
  Object.assign(config, { roadMatch: "own", roadMatchFallback: false, roadMatchUrl: osrm.url });
  assert.equal(await checkOsrm(), null);
  Object.assign(config, { roadMatch: "off", roadMatchUrl: osrm.url });
  assert.equal(await checkOsrm(), null);
  Object.assign(config, { roadMatch: "osrm", roadMatchUrl: null });
  assert.equal(await checkOsrm(), null);
  assert.equal(osrm.asked.length, 0);
  assert.equal(lines.length, 0);
});
