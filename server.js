// Clinic booking API
//
// Levels implemented (see the Koya assessment contract):
//   1  list slots, book one, look up a booking
//   2  X-API-Key auth + input validation
//   3  no double booking (database-enforced, safe under concurrency) + cancel
//   4  Idempotency-Key + cursor pagination
//   5  rate limit: 5 booking attempts per email per minute
//
// All shared state lives in Postgres, so it survives restarts, works across
// several instances, and the guarantees below do not depend on Node's timing.

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !DATABASE_URL) {
  console.error("Missing API_KEY or DATABASE_URL environment variable.");
  process.exit(1);
}

// ---------- database ----------

function poolConfig() {
  const url = new URL(DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  // Handle TLS ourselves so hosted databases (Neon, Supabase) just work.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("channel_binding");
  return {
    connectionString: url.toString(),
    max: 10,
    ssl: local || process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  };
}

const pool = new Pool(poolConfig());
pool.on("error", (err) => console.error("Idle database client error:", err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  start_text TEXT NOT NULL,          -- returned exactly as it was sent
  end_text   TEXT NOT NULL,
  start_ts   TIMESTAMPTZ NOT NULL,   -- used for ordering and "already started"
  end_ts     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL PRIMARY KEY,  -- insertion order, used for pagination
  id         TEXT UNIQUE NOT NULL,
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself refuses a second confirmed booking for a slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  body_hash   TEXT NOT NULL,
  status_code INT NOT NULL,
  response    JSONB NOT NULL
);

-- Level 5: one row per counted booking attempt.
CREATE TABLE IF NOT EXISTS attempts (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS attempts_email_at ON attempts (email, at);
`;

async function seedDemoSlots() {
  const { rows } = await pool.query("SELECT 1 FROM slots LIMIT 1");
  if (rows.length) return;
  const providers = ["Dr Ade", "Dr Bello"];
  const times = [9, 10.5, 14];
  const slots = [];
  let n = 1;
  for (let day = 1; day <= 5; day++) {
    for (const provider of providers) {
      for (const t of times) {
        const start = new Date();
        start.setUTCDate(start.getUTCDate() + day);
        start.setUTCHours(Math.floor(t), (t % 1) * 60, 0, 0);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        slots.push({
          id: `s${n++}`,
          provider,
          start: start.toISOString().replace(".000Z", "Z"),
          end: end.toISOString().replace(".000Z", "Z"),
        });
      }
    }
  }
  await replaceSlots(pool, slots);
  console.log(`Seeded ${slots.length} demo slots.`);
}

// ---------- helpers ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const sendError = (res, status, message) => res.status(status).json({ error: message });

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function publicBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// Replace every booking and every slot (used by POST /reset and seeding).
async function replaceSlots(db, slots) {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM idempotency");
    await client.query("DELETE FROM attempts");
    await client.query("DELETE FROM slots");
    if (slots.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_text, end_text, start_ts, end_ts)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        [
          slots.map((s) => s.id),
          slots.map((s) => s.provider),
          slots.map((s) => s.start),
          slots.map((s) => s.end),
          slots.map((s) => new Date(s.start).toISOString()),
          slots.map((s) => new Date(s.end).toISOString()),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (client.release) client.release();
  }
}

// ---------- app ----------

const app = express();
app.disable("x-powered-by");

// CORS (so the page also works if it is ever hosted on another origin)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Retry-After");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

// Public: the web page and a health check (no API key needed to open a page).
const pageTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
app.get("/", (req, res) => {
  res.type("html").send(pageTemplate.split("__API_KEY__").join(JSON.stringify(API_KEY).slice(1, -1)));
});
app.get("/health", (req, res) => res.json({ ok: true }));

// Level 2: every API request needs the X-API-Key header.
const keyHash = sha256(API_KEY);
function requireKey(req, res, next) {
  const sent = req.get("X-API-Key");
  if (!sent || !crypto.timingSafeEqual(Buffer.from(sha256(sent)), Buffer.from(keyHash))) {
    return sendError(res, 401, "missing or invalid API key");
  }
  next();
}

const api = express.Router();

// POST /reset  — replace all slots, delete all bookings
api.post("/reset", async (req, res, next) => {
  try {
    const list = isObject(req.body) ? req.body.slots : undefined;
    if (!Array.isArray(list)) return sendError(res, 400, "body must contain a slots array");
    const seen = new Set();
    for (const s of list) {
      const ok =
        isObject(s) &&
        ["id", "provider", "start", "end"].every((k) => typeof s[k] === "string" && s[k].trim()) &&
        !Number.isNaN(Date.parse(s.start)) &&
        !Number.isNaN(Date.parse(s.end));
      if (!ok) return sendError(res, 400, "each slot needs id, provider, start and end");
      if (seen.has(s.id)) return sendError(res, 400, `duplicate slot id: ${s.id}`);
      seen.add(s.id);
    }
    await replaceSlots(pool, list);
    res.status(200).json({ ok: true, slots: list.length });
  } catch (err) {
    next(err);
  }
});

// GET /slots[?provider=]  — earliest start first
api.get("/slots", async (req, res, next) => {
  try {
    const provider = req.query.provider;
    if (provider !== undefined && typeof provider !== "string") {
      return sendError(res, 400, "provider must be a single value");
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_text, s.end_text,
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_ts, s.id`,
      [provider === undefined ? null : provider]
    );
    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_text,
        end: r.end_text,
        available: r.available,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /bookings
api.post("/bookings", async (req, res, next) => {
  const body = isObject(req.body) ? req.body : {};
  const idemKey = (req.get("Idempotency-Key") || "").trim();
  const bodyHash = sha256(stableStringify(body));

  // The email is the rate-limit key. Trim + lower-case it the way we store it.
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slotId = typeof body.slot_id === "string" ? body.slot_id : "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Level 4: serialise requests that share an Idempotency-Key, then replay.
    if (idemKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [`idem:${idemKey}`]);
      const prev = await client.query(
        "SELECT body_hash, status_code, response FROM idempotency WHERE key = $1",
        [idemKey]
      );
      if (prev.rowCount) {
        await client.query("COMMIT");
        const saved = prev.rows[0];
        if (saved.body_hash !== bodyHash) {
          return sendError(res, 422, "Idempotency-Key was already used with a different request body");
        }
        return res.status(saved.status_code).json(saved.response);
      }
    }

    // Level 5: at most 5 attempts per email per minute, failed ones included.
    if (email) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`rate:${email}`]);
      const recent = await client.query(
        `SELECT count(*)::int AS n,
                EXTRACT(EPOCH FROM (min(at) + interval '60 seconds' - clock_timestamp())) AS wait
           FROM attempts
          WHERE email = $1 AND at > clock_timestamp() - interval '60 seconds'`,
        [email]
      );
      if (recent.rows[0].n >= 5) {
        await client.query("COMMIT");
        const wait = Math.max(1, Math.ceil(Number(recent.rows[0].wait)));
        res.set("Retry-After", String(wait));
        return sendError(res, 429, "too many booking attempts for this email, try again later");
      }
      await client.query("INSERT INTO attempts (email) VALUES ($1)", [email]);
      await client.query("DELETE FROM attempts WHERE at < clock_timestamp() - interval '10 minutes'");
    }

    // From here on, the attempt above is already counted, so every exit COMMITs.
    const fail = async (status, message) => {
      await client.query("COMMIT");
      return sendError(res, status, message);
    };

    // Level 2: validation
    if (!slotId.trim() || !name || !email || !EMAIL_RE.test(email) || name.length > 200 || email.length > 320) {
      return await fail(400, "slot_id, name and a valid email are required");
    }
    const slot = await client.query("SELECT id, (start_ts <= clock_timestamp()) AS started FROM slots WHERE id = $1", [
      slotId,
    ]);
    if (!slot.rowCount) return await fail(404, "slot not found");
    if (slot.rows[0].started) return await fail(400, "slot has already started");

    // Level 3: the unique index decides who wins when requests collide.
    await client.query("SAVEPOINT book");
    let row;
    try {
      const ins = await client.query(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
        [crypto.randomUUID(), slotId, name, email]
      );
      row = ins.rows[0];
    } catch (err) {
      if (err.code === "23505") {
        await client.query("ROLLBACK TO SAVEPOINT book");
        return await fail(409, "slot is already booked");
      }
      if (err.code === "23503") {
        await client.query("ROLLBACK TO SAVEPOINT book");
        return await fail(404, "slot not found");
      }
      throw err;
    }

    const booking = publicBooking(row);
    if (idemKey) {
      await client.query(
        "INSERT INTO idempotency (key, body_hash, status_code, response) VALUES ($1, $2, 201, $3)",
        [idemKey, bodyHash, JSON.stringify(booking)]
      );
    }
    await client.query("COMMIT");
    res.status(201).json(booking);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* connection already gone */
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /bookings?email=&limit=&cursor=  — oldest first, cursor pagination
api.get("/bookings", async (req, res, next) => {
  try {
    const { email: rawEmail, limit: rawLimit, cursor: rawCursor } = req.query;
    if (typeof rawEmail !== "string" || !rawEmail.trim()) return sendError(res, 400, "email is required");
    const email = rawEmail.trim().toLowerCase();

    let limit = 10;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) return sendError(res, 400, "limit must be 1 to 50");
      limit = Number(rawLimit);
      if (limit < 1 || limit > 50) return sendError(res, 400, "limit must be 1 to 50");
    }

    let after = null;
    if (rawCursor !== undefined && rawCursor !== "") {
      const decoded = typeof rawCursor === "string" ? Buffer.from(rawCursor, "base64url").toString("utf8") : "";
      if (!/^\d{1,18}$/.test(decoded)) return sendError(res, 400, "invalid cursor");
      after = decoded;
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings
        WHERE email = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq
        LIMIT $3`,
      [email, after, limit + 1]
    );
    const page = rows.slice(0, limit);
    const next_cursor =
      rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url") : null;
    res.json({ bookings: page.map(publicBooking), next_cursor });
  } catch (err) {
    next(err);
  }
});

// GET /bookings/:id
api.get("/bookings/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
    if (!rows.length) return sendError(res, 404, "booking not found");
    res.json(publicBooking(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /bookings/:id  — cancel, frees the slot
api.delete("/bookings/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
      [req.params.id]
    );
    if (rows.length) return res.json(publicBooking(rows[0]));
    const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
    if (exists.rowCount) return sendError(res, 409, "booking is already cancelled");
    return sendError(res, 404, "booking not found");
  } catch (err) {
    next(err);
  }
});

app.use(["/reset", "/slots", "/bookings"], requireKey);
app.use(api);

app.use((req, res) => sendError(res, 404, "not found"));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return sendError(res, 400, "request body is not valid JSON");
  }
  console.error(err);
  sendError(res, 500, "internal server error");
});

// ---------- start ----------

(async () => {
  await pool.query(SCHEMA);
  await seedDemoSlots();
  app.listen(PORT, () => console.log(`Booking API listening on port ${PORT}`));
})().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
