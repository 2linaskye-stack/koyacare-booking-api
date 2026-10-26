# Clinic booking API

A clinic booking API and a simple booking web page, built for the Koya Cohort 4 assessment (Task 1).

- **API:** Node.js + Express, data in PostgreSQL
- **Web page:** served by the same app at `/` (see available slots, book one, see the confirmation, cancel)
- **Levels 1-5:** all implemented

## How each level works

| Level | What | How |
|---|---|---|
| 1 | List slots, book, look up | `GET /slots`, `POST /bookings`, `GET /bookings/{id}` |
| 2 | API key + validation | `X-API-Key` header required on every API call (401 otherwise). Missing/empty/invalid fields -> 400, unknown slot -> 404, slot already started -> 400. Name and email are trimmed, email stored lower-case. |
| 3 | No double booking, cancel | A **partial unique index** (`one confirmed booking per slot`) makes the database itself refuse a second confirmed booking, so it holds even when requests arrive at the exact same moment. `DELETE /bookings/{id}` sets `cancelled` and frees the slot. |
| 4 | Idempotency + pagination | `Idempotency-Key` responses are stored; the same key and body replays the same status and booking id, a different body gives 422. Requests sharing a key are serialised with a Postgres advisory lock, so even simultaneous retries create one booking. `GET /bookings?email=` uses cursor pagination (`next_cursor`, `limit` 1-50). |
| 5 | Rate limit | 5 booking attempts per email per minute, failed attempts included, 6th returns 429 with `Retry-After` in whole seconds. Counted in Postgres under a per-email lock, so it is exact under concurrency and other emails are unaffected. |

State (slots, bookings, idempotency keys, rate-limit counters) lives in Postgres, so it survives restarts and works if more than one instance runs.

## Run it locally

1. Install Node 18+ and have a Postgres database (a free [Neon](https://neon.tech) project works).
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `API_KEY`.
3. ```
   npm install
   npm start
   ```
4. Open http://localhost:3000 for the web page.

On first start the app creates its tables and, if there are no slots, adds some demo slots so the page isn't empty. `POST /reset` replaces them.

### Test it

With the server running (PowerShell):

```
$env:BASE_URL="http://localhost:3000"
$env:API_KEY="the-same-key-as-in-.env"
node test.js
```

`test.js` checks every level, including 40 simultaneous bookings of one slot. **It calls `/reset`, which deletes all bookings and slots**, so don't run it against the deployed app after you've submitted.

## Deploy (free)

**Database: Neon**
1. Create a project at neon.tech and copy its connection string (`postgresql://...`).

**API + page: Render**
1. Push this folder to a new **public** GitHub repository.
2. On render.com: **New -> Web Service**, connect the repo.
3. Runtime `Node`, Build Command `npm install`, Start Command `npm start`, free plan.
4. Add environment variables: `DATABASE_URL` (the Neon string) and `API_KEY` (a long random string; generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
5. Deploy. Your URL is `https://<your-service>.onrender.com`.

Free Render services go to sleep when idle, so the first request after a pause can be slow. Add a free uptime monitor (for example UptimeRobot) that calls `https://<your-service>.onrender.com/health` every 5 minutes to keep it awake.

## What to submit

- **API base URL:** `https://<your-service>.onrender.com` (no trailing slash)
- **API key:** the `API_KEY` you set
- **Web page URL:** the same URL
- **GitHub repo:** the public repo link
- **Loom (5 min or less):** show the page working (list, book, confirmation, a taken slot) and walk through `server.js`

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/reset` | body `{ "slots": [{ "id", "provider", "start", "end" }] }`, replaces all slots, deletes all bookings |
| GET | `/slots` | optional `?provider=` (exact match), earliest start first |
| POST | `/bookings` | body `{ slot_id, name, email }`, optional `Idempotency-Key` header |
| GET | `/bookings?email=&limit=&cursor=` | that person's bookings, oldest first |
| GET | `/bookings/{id}` | one booking |
| DELETE | `/bookings/{id}` | cancel |
| GET | `/health` | no key needed, for uptime pings |

All errors look like `{ "error": "<message>" }`.
