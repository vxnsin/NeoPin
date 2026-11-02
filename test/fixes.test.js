import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db.js";
import { positionsBetween } from "../src/history.js";
import { startServer } from "./helpers.js";

let s;
let luis;

beforeEach(async () => {
  s = await startServer();
  luis = await s.account("luis");
});

afterEach(() => s.stop());

// node:sqlite rows have no prototype, plain copies compare like normal objects.
const stored = () =>
  positionsBetween(luis.user.id, "phone", 0, Date.now() + 120_000).map(({ id, ground, ...row }) => ({ ...row }));
// What the GPS said about the height, straight from the table.
const heights = () =>
  getDb()
    .prepare("SELECT altitude, altitude_accuracy, ground FROM positions ORDER BY ts")
    .all()
    .map((row) => ({ ...row }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("a fix keeps its GPS time, accuracy and speed", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  const at = Date.now() - 30_000;
  phone.send({ type: "updatePosition", latitude: 49.79, longitude: 9.95, recordedAt: at, accuracy: 12, speed: 1.4 });
  await settle();
  assert.deepEqual(stored(), [{ ts: at, lat: 49.79, lon: 9.95, accuracy: 12, speed: 1.4 }]);
});

test("a fix keeps the GPS altitude as it came, the ground stays unknown while elevation is off", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 47.49, longitude: 11.09, altitude: 712.4, altitudeAccuracy: 3.5 });
  await settle();
  phone.send({
    type: "positionBatch",
    points: [{ latitude: 47.48, longitude: 11.08, recordedAt: Date.now() - 60_000, altitude: 690 }],
  });
  await settle();
  assert.deepEqual(heights(), [
    { altitude: 690, altitude_accuracy: null, ground: null },
    { altitude: 712.4, altitude_accuracy: 3.5, ground: null },
  ]);
});

test("an altitude out of range closes the socket", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 47.49, longitude: 11.09, altitude: 50_000 });
  assert.equal((await phone.closed).code, 1007);
});

test("a batch of 100 fixes with heights fits into one message", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  const now = Date.now();
  const points = Array.from({ length: 100 }, (_, i) => ({
    latitude: 47.491234567891234 + i / 1000,
    longitude: 11.095123456789012,
    recordedAt: now - (100 - i) * 10_000,
    accuracy: 4.800000190734863,
    speed: 1.2300000190734863,
    altitude: 712.4000244140625,
    altitudeAccuracy: 3.0999999046325684,
  }));
  phone.send({ type: "positionBatch", points });
  await settle();
  assert.equal(stored().length, 100);
});

test("a fix less exact than 100 m is not kept, the map still moves", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  phone.send({ type: "updatePosition", latitude: 49.79, longitude: 9.95, accuracy: 450 });
  await settle();
  assert.equal(stored().length, 0);
});

test("a phone clock far off falls back to the server time", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  const before = Date.now();
  phone.send({ type: "updatePosition", latitude: 49.79, longitude: 9.95, recordedAt: before + 3_600_000 });
  await settle();
  const [fix] = stored();
  assert.ok(fix.ts >= before && fix.ts <= Date.now());
});

test("fixes sent after a dead spot land in the history at their own time", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  const now = Date.now();
  // The live fix first, then what was collected before it without a connection.
  phone.send({ type: "updatePosition", latitude: 49.8, longitude: 9.96, recordedAt: now });
  await settle();
  phone.send({
    type: "positionBatch",
    points: [
      { latitude: 49.79, longitude: 9.95, recordedAt: now - 60_000, accuracy: 8 },
      { latitude: 49.795, longitude: 9.955, recordedAt: now - 30_000, speed: 9 },
    ],
  });
  await settle();
  assert.deepEqual(
    stored().map((p) => [p.ts, p.lat]),
    [
      [now - 60_000, 49.79],
      [now - 30_000, 49.795],
      [now, 49.8],
    ]
  );
});

test("a batch of more than 100 fixes closes the socket", async () => {
  const phone = await s.device("luis", "phone");
  await phone.next();
  const points = Array.from({ length: 101 }, (_, i) => ({ latitude: 49.79, longitude: 9.95, recordedAt: Date.now() - i * 1000 }));
  phone.send({ type: "positionBatch", points });
  assert.ok([1007, 1009].includes((await phone.closed).code));
});
