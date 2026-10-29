// The tables of the weekly and monthly review (src/review.js). Apart from db.js so that file
// keeps no import of the review and the review keeps its tables in one place.
export const REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS review_days (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    date TEXT NOT NULL,
    stamp TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, start_ms, end_ms)
  );
  CREATE TABLE IF NOT EXISTS review_spots (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    spots TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );
  CREATE TABLE IF NOT EXISTS review_history (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    complete_before TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notify INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_sent (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    from_date TEXT NOT NULL,
    notified INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (user_id, period, from_date)
  );
`;
