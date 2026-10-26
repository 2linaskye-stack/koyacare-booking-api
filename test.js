// Contract check for the booking API. No dependencies (needs Node 18+).
//
//   BASE_URL=http://localhost:3000 API_KEY=your-key node test.js
//
// WARNING: this calls POST /reset, which deletes all bookings and replaces all slots.

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error("Set API_KEY (and BASE_URL) first.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
  }
}

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { ...headers };
  if (key) h["X-API-Key"] = key;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json, headers: res.headers };
}

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.now() + 3 * DAY;

function slot(id, provider, offsetMin, fromMs = t0) {
  return { id, provider, start: iso(fromMs + offsetMin * 60000), end: iso(fromMs + (offsetMin + 30) * 60000) };
}

const SLOTS = [
  slot("s2", "Dr Bello", 60),
  slot("s1", "Dr Ade", 0),
  slot("s3", "Dr Ade", 30),
  slot("s4", "Dr Ade", 90),
  slot("s5", "Dr Ade", 120),
  slot("s6", "Dr Ade", 150),
  slot("s7", "Dr Ade", 180),
  slot("s8", "Dr Ade", 210),
  slot("s9", "Dr Ade", 240),
  slot("s10", "Dr Ade", 270),
  slot("s11", "Dr Ade", 300),
  slot("s12", "Dr Ade", 330),
  slot("past", "Dr Ade", -60, Date.now() - 2 * DAY),
];

async function reset() {
  return call("POST", "/reset", { body: { slots: SLOTS } });
}

(async () => {
  console.log(`Testing ${BASE}\n`);

  console.log("Level 2: API key");
  for (const [m, p] of [["GET", "/slots"], ["GET", "/bookings?email=a@b.co"], ["POST", "/reset"], ["POST", "/bookings"], ["GET", "/bookings/x"], ["DELETE", "/bookings/x"]]) {
    const none = await call(m, p, { key: null, body: m === "POST" ? {} : undefined });
    const wrong = await call(m, p, { key: "nope", body: m === "POST" ? {} : undefined });
    check(`${m} ${p} without key -> 401`, none.status === 401 && typeof none.json?.error === "string", none);
    check(`${m} ${p} with wrong key -> 401`, wrong.status === 401, wrong);
  }

  console.log("\nLevel 1: reset, slots, book, look up");
  const r = await reset();
  check("POST /reset -> 200", r.status === 200, r);
  const list = await call("GET", "/slots");
  check("GET /slots -> 200 with slots array", list.status === 200 && Array.isArray(list.json?.slots), list);
  const starts = list.json.slots.map((s) => Date.parse(s.start));
  check("slots sorted by start, earliest first", starts.every((v, i) => i === 0 || starts[i - 1] <= v));
  check("slots echo id/provider/start/end exactly", list.json.slots.find((s) => s.id === "s1")?.start === SLOTS[1].start);
  check("all slots start as available", list.json.slots.every((s) => s.available === true));
  const ade = await call("GET", "/slots?provider=Dr%20Ade");
  check("provider filter is exact", ade.json.slots.length === SLOTS.filter((s) => s.provider === "Dr Ade").length && ade.json.slots.every((s) => s.provider === "Dr Ade"));
  const none = await call("GET", "/slots?provider=dr%20ade");
  check("provider filter is case-exact (no match)", none.json.slots.length === 0);

  const b1 = await call("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi  ", email: "  ADA@Example.COM " } });
  check("POST /bookings -> 201 confirmed", b1.status === 201 && b1.json?.status === "confirmed", b1);
  check("booking has id, slot_id, name, email, created_at", b1.json?.id && b1.json.slot_id === "s1" && b1.json.created_at, b1.json);
  check("name trimmed, email trimmed + lower-cased", b1.json?.name === "Ada Obi" && b1.json?.email === "ada@example.com", b1.json);
  const got = await call("GET", `/bookings/${b1.json.id}`);
  check("GET /bookings/{id} -> 200 same booking", got.status === 200 && got.json.id === b1.json.id, got);
  const missing = await call("GET", "/bookings/does-not-exist");
  check("GET unknown booking -> 404", missing.status === 404 && typeof missing.json?.error === "string", missing);
  const after = await call("GET", "/slots");
  check("booked slot shows available:false", after.json.slots.find((s) => s.id === "s1").available === false);

  console.log("\nLevel 2: validation");
  const bad = [
    ["missing slot_id", { name: "A", email: "a@b.co" }],
    ["missing name", { slot_id: "s2", email: "a@b.co" }],
    ["missing email", { slot_id: "s2", name: "A" }],
    ["empty name", { slot_id: "s2", name: "   ", email: "a@b.co" }],
    ["empty email", { slot_id: "s2", name: "A", email: "" }],
    ["invalid email", { slot_id: "s2", name: "A", email: "not-an-email" }],
  ];
  let i = 0;
  for (const [label, body] of bad) {
    const x = await call("POST", "/bookings", { body });
    check(`${label} -> 400`, x.status === 400 && typeof x.json?.error === "string", x);
    i++;
  }
  const unk = await call("POST", "/bookings", { body: { slot_id: "nope", name: "A", email: "v1@b.co" } });
  check("unknown slot -> 404", unk.status === 404, unk);
  const past = await call("POST", "/bookings", { body: { slot_id: "past", name: "A", email: "v2@b.co" } });
  check("slot that already started -> 400", past.status === 400, past);

  console.log("\nLevel 3: no double booking, cancel");
  const dup = await call("POST", "/bookings", { body: { slot_id: "s1", name: "Bola", email: "bola@b.co" } });
  check("second booking of same slot -> 409", dup.status === 409 && typeof dup.json?.error === "string", dup);

  await reset();
  const race = await Promise.all(
    Array.from({ length: 40 }, (_, n) => call("POST", "/bookings", { body: { slot_id: "s3", name: `P${n}`, email: `race${n}@b.co` } }))
  );
  const wins = race.filter((x) => x.status === 201).length;
  const conflicts = race.filter((x) => x.status === 409).length;
  check("40 simultaneous requests for one slot: exactly one 201", wins === 1, { wins, conflicts, other: race.filter((x) => ![201, 409].includes(x.status)).map((x) => x.status) });
  check("...and the other 39 get 409", conflicts === 39);

  const c1 = await call("POST", "/bookings", { body: { slot_id: "s4", name: "Chi", email: "chi@b.co" } });
  const del = await call("DELETE", `/bookings/${c1.json.id}`);
  check("DELETE -> 200 with status cancelled", del.status === 200 && del.json?.status === "cancelled" && del.json.id === c1.json.id, del);
  const del2 = await call("DELETE", `/bookings/${c1.json.id}`);
  check("DELETE again -> 409 already cancelled", del2.status === 409, del2);
  const del3 = await call("DELETE", "/bookings/not-a-booking");
  check("DELETE unknown -> 404", del3.status === 404, del3);
  const g2 = await call("GET", `/bookings/${c1.json.id}`);
  check("cancelled booking still readable, status cancelled", g2.status === 200 && g2.json.status === "cancelled", g2);
  const s4 = (await call("GET", "/slots")).json.slots.find((s) => s.id === "s4");
  check("cancelled slot is available again", s4.available === true, s4);
  const rebook = await call("POST", "/bookings", { body: { slot_id: "s4", name: "Dayo", email: "dayo@b.co" } });
  check("cancelled slot can be booked again -> 201", rebook.status === 201, rebook);

  console.log("\nLevel 4: Idempotency-Key");
  await reset();
  const body = { slot_id: "s5", name: "Efe", email: "efe@b.co" };
  const k1 = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
  const k2 = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
  check("first call -> 201", k1.status === 201, k1);
  check("retry with same key + body -> same status and same booking id", k2.status === k1.status && k2.json?.id === k1.json?.id, k2);
  const k3 = await call("POST", "/bookings", { body: { ...body, name: "Someone Else" }, headers: { "Idempotency-Key": "key-1" } });
  check("same key, different body -> 422", k3.status === 422 && typeof k3.json?.error === "string", k3);
  const mine = await call("GET", "/bookings?email=efe@b.co");
  check("retries created exactly one booking", mine.json?.bookings?.length === 1, mine.json);

  const cb = { slot_id: "s6", name: "Femi", email: "femi@b.co" };
  const conc = await Promise.all(Array.from({ length: 15 }, () => call("POST", "/bookings", { body: cb, headers: { "Idempotency-Key": "key-conc" } })));
  const ids = new Set(conc.map((x) => x.json?.id));
  check("15 simultaneous retries: all 201, one booking id", conc.every((x) => x.status === 201) && ids.size === 1, { statuses: conc.map((x) => x.status), ids: [...ids] });
  const femi = await call("GET", "/bookings?email=femi@b.co");
  check("...and only one booking stored", femi.json.bookings.length === 1);

  await call("DELETE", `/bookings/${k1.json.id}`);
  const k4 = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": "key-1" } });
  check("replay after cancel still returns the original response", k4.status === 201 && k4.json.id === k1.json.id, k4);

  console.log("\nLevel 4: pagination");
  await reset();
  const people = [];
  for (let n = 3; n <= 7; n++) {
    const x = await call("POST", "/bookings", { body: { slot_id: `s${n}`, name: "Gina", email: "Gina@B.co" } });
    people.push(x.json?.id);
  }
  await call("POST", "/bookings", { body: { slot_id: "s8", name: "Hauwa", email: "hauwa@b.co" } });
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await call("GET", `/bookings?email=GINA@b.co&limit=2${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    if (page.status !== 200) {
      check("page request ok", false, page);
      break;
    }
    seen.push(...page.json.bookings.map((b) => b.id));
    cursor = page.json.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  check("5 bookings across pages of 2 (2,2,1)", pages === 3 && seen.length === 5, { pages, n: seen.length });
  check("oldest first, no repeats, none missing", JSON.stringify(seen) === JSON.stringify(people), { seen, people });
  check("other people's bookings not included", !seen.includes((await call("GET", "/bookings?email=hauwa@b.co")).json.bookings[0].id));
  const lastPage = await call("GET", `/bookings?email=gina@b.co&limit=50`);
  check("last page has next_cursor: null", lastPage.json.next_cursor === null && lastPage.json.bookings.length === 5, lastPage.json);
  const def = await call("GET", "/bookings?email=gina@b.co");
  check("default limit works", def.status === 200 && def.json.bookings.length === 5);
  for (const bad of ["0", "51", "abc", "-1", "2.5"]) {
    const x = await call("GET", `/bookings?email=gina@b.co&limit=${bad}`);
    check(`limit=${bad} -> 400`, x.status === 400, x);
  }
  const badCursor = await call("GET", "/bookings?email=gina@b.co&cursor=%25%25%25");
  check("garbage cursor -> 400", badCursor.status === 400, badCursor);
  const noEmail = await call("GET", "/bookings");
  check("missing email -> 400", noEmail.status === 400, noEmail);
  const nobody = await call("GET", "/bookings?email=nobody@b.co");
  check("unknown person -> 200 with empty list", nobody.status === 200 && nobody.json.bookings.length === 0 && nobody.json.next_cursor === null, nobody);

  console.log("\nLevel 5: rate limit");
  await reset();
  const rl = [];
  for (let n = 0; n < 6; n++) {
    rl.push(await call("POST", "/bookings", { body: { slot_id: "nope", name: "Ife", email: "ife@b.co" } }));
  }
  check("attempts 1-5 are processed (failed attempts count)", rl.slice(0, 5).every((x) => x.status === 404), rl.map((x) => x.status));
  check("6th attempt -> 429", rl[5].status === 429, rl[5]);
  const ra = rl[5].headers.get("Retry-After");
  check("Retry-After is whole seconds (1-60)", /^\d+$/.test(ra || "") && Number(ra) >= 1 && Number(ra) <= 60, ra);
  check("429 body has an error message", typeof rl[5].json?.error === "string");
  const other = await call("POST", "/bookings", { body: { slot_id: "s9", name: "Jide", email: "jide@b.co" } });
  check("a different email is not affected", other.status === 201, other);
  const caseVariant = await call("POST", "/bookings", { body: { slot_id: "s10", name: "Ife", email: " IFE@b.co " } });
  check("same email in different case/spacing shares the limit", caseVariant.status === 429, caseVariant);

  await reset();
  const burst = await Promise.all(Array.from({ length: 20 }, () => call("POST", "/bookings", { body: { slot_id: "nope", name: "Kemi", email: "kemi@b.co" } })));
  const allowed = burst.filter((x) => x.status !== 429).length;
  check("20 simultaneous attempts: exactly 5 allowed, 15 limited", allowed === 5, { allowed });

  console.log("\nOther");
  const badJson = await fetch(BASE + "/bookings", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: "{not json" });
  check("malformed JSON -> 400 {error}", badJson.status === 400 && typeof (await badJson.json()).error === "string");
  const page = await fetch(BASE + "/");
  check("web page loads at /", page.status === 200 && (await page.text()).includes("<html"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
