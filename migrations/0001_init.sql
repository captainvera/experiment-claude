-- Togetherly schema.
--
-- Every row is scoped to a pair code. Nothing here is per-device: a partner is
-- identified by their role ('a' = the person who created the pair, 'b' = the
-- person who joined), so the same account works from a phone and a laptop.

CREATE TABLE pairs (
  code        TEXT PRIMARY KEY,
  a_name      TEXT    NOT NULL DEFAULT '',
  b_name      TEXT    NOT NULL DEFAULT '',
  -- Minutes returned by Date.getTimezoneOffset() on the creating device.
  -- Used to work out which week/day a pair is in, and when the daily word opens.
  tz_offset   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- NULL while the invite code is still open. Set once partner B joins, which
  -- permanently closes the code to further joins.
  b_joined_at INTEGER
);

-- One row per signed-in device. The bearer token is never stored, only its
-- SHA-256, so a database dump cannot be replayed against the API.
CREATE TABLE devices (
  token_hash   TEXT PRIMARY KEY,
  code         TEXT    NOT NULL REFERENCES pairs(code) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_code ON devices (code);

-- Weekly check-in. One row per partner per week, so the two of you can never
-- overwrite each other. `week` is the Monday of the pair's local week.
CREATE TABLE checkins (
  code   TEXT    NOT NULL,
  week   TEXT    NOT NULL,
  role   TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  scores TEXT    NOT NULL,
  note   TEXT    NOT NULL DEFAULT '',
  at     INTEGER NOT NULL,
  PRIMARY KEY (code, week, role)
);

CREATE TABLE nudges (
  code TEXT    NOT NULL,
  week TEXT    NOT NULL,
  role TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  at   INTEGER NOT NULL,
  PRIMARY KEY (code, week)
);

-- Boos. `kind` mirrors the two-slot model the app expects: 'shared' is the last
-- Boo you published to your partner, 'self' is your latest one whether or not
-- you shared it. Saving privately updates 'self' only, so your partner keeps
-- seeing the last thing you actually chose to show them.
CREATE TABLE boos (
  code  TEXT    NOT NULL,
  role  TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  kind  TEXT    NOT NULL CHECK (kind IN ('self', 'shared')),
  stats TEXT    NOT NULL,
  need  TEXT,
  note  TEXT    NOT NULL DEFAULT '',
  at    INTEGER NOT NULL,
  PRIMARY KEY (code, role, kind)
);

CREATE TABLE boo_seen (
  code TEXT    NOT NULL,
  role TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  at   INTEGER NOT NULL,
  PRIMARY KEY (code, role)
);

-- One word for today. `day` is the pair's local date.
CREATE TABLE words (
  code TEXT    NOT NULL,
  day  TEXT    NOT NULL,
  role TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  word TEXT    NOT NULL,
  at   INTEGER NOT NULL,
  PRIMARY KEY (code, day, role)
);

-- Moments jar. Append-only, so two people adding at once cannot clobber.
CREATE TABLE jar (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT    NOT NULL,
  week TEXT    NOT NULL,
  role TEXT    NOT NULL CHECK (role IN ('a', 'b')),
  text TEXT    NOT NULL,
  at   INTEGER NOT NULL
);
CREATE INDEX jar_code_week ON jar (code, week);

-- Failed join attempts, used to rate limit guessing of pairing codes.
CREATE TABLE join_attempts (
  ip    TEXT    NOT NULL PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);
