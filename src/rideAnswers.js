import crypto from "crypto";
import { getDb } from "./db.js";

// The rides the server asked about while they were on, and what the rider said. One question per
// device and boarding time; the full line is kept, so "yes" can give it to the finished trip.

export const RIDE_ANSWERS = ["yes", "no"];

// Stores a question and returns its id, or null when this ride was asked about already.
// `timetable` is where the line came from: the feed, its trip and the boarding stop's place in it.
export function recordQuestion({ userId, deviceId, boardedAt, transit, timetable = null, now = Date.now() }) {
  const rideId = crypto.randomBytes(12).toString("base64url");
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO ride_answers (ride_id, user_id, device_id, boarded_at, line, transit, feed_id, trip_id, from_seq, asked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rideId,
      userId,
      deviceId,
      boardedAt,
      transit.line,
      JSON.stringify(transit),
      timetable?.feedId ?? null,
      timetable?.tripId ?? null,
      timetable?.fromSeq ?? null,
      now
    );
  return Number(result.changes) > 0 ? rideId : null;
}

// Whether the device was asked about this line since `since`. A long halt at a station starts a
// new ride for the server, but not for the rider, who should not be asked twice.
export function askedLately(userId, deviceId, line, since) {
  return !!getDb()
    .prepare("SELECT 1 FROM ride_answers WHERE user_id = ? AND device_id = ? AND line = ? AND boarded_at >= ?")
    .get(userId, deviceId, line, since);
}

// False when the ride is unknown or someone else's. A second answer replaces the first.
export function answerRide(userId, rideId, answer, now = Date.now()) {
  const result = getDb()
    .prepare("UPDATE ride_answers SET answer = ?, answered_at = ? WHERE ride_id = ? AND user_id = ?")
    .run(answer, now, rideId, userId);
  return Number(result.changes) > 0;
}

// The answered rides of a device that were boarded within a time range, oldest first.
export function rideAnswersBetween(userId, deviceId, from, to) {
  return getDb()
    .prepare(
      `SELECT boarded_at, answer, transit, feed_id, trip_id, from_seq FROM ride_answers
       WHERE user_id = ? AND device_id = ? AND boarded_at >= ? AND boarded_at <= ? AND answer IS NOT NULL ORDER BY boarded_at`
    )
    .all(userId, deviceId, from, to)
    .map((r) => ({
      boardedAt: Number(r.boarded_at),
      answer: r.answer,
      transit: JSON.parse(r.transit),
      timetable: r.feed_id === null ? null : { feedId: Number(r.feed_id), tripId: r.trip_id, fromSeq: Number(r.from_seq) },
    }));
}
