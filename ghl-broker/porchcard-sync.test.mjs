import test from "node:test";
import assert from "node:assert/strict";
import { maybeRunPorchcardSync, runPorchcardSync, CURSOR_NAME } from "./porchcard-sync.js";

const LOC = "loc-1";
const ENV = { PORCHCARD_SYNC_ENABLED: "true", PORCHCARD_ADMIN_KEY: "pc_admin_test", PORCHCARD_LOCATION_ID: LOC };
const NOW = Date.parse("2026-11-20T20:00:00Z");
const PUBLIC = { summary: true, property: true, equity: true, photos: true };

function makeStore({ deals, rooms = {}, photos = {} }) {
  const cursors = {};
  return {
    cursors,
    listDeals: async () => deals,
    getJobCursor: async (loc, name) => cursors[name] || null,
    setJobCursor: async (loc, name, v) => { cursors[name] = JSON.parse(JSON.stringify(v)); },
    listDatarooms: async (loc, { offerId }) => rooms[offerId] || [],
    listOfferPhotos: async (offerId) => photos[offerId] || [],
    readPhotoBytes: async (id) => ({ contentType: "image/jpeg", bytes: Buffer.from(`jpeg-${id}`) }),
  };
}

// A pretend Porchcard: Matt's own listings, every call written down.
function makePorchcard(listings = []) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: u.pathname, body, headers: init.headers });
    const json = (status, obj) => ({ ok: status < 400, status, headers: new Map(), json: async () => obj });
    if (u.pathname === "/api/admin/v1/me") return json(200, { owner: { id: "acct-matt" } });
    if (u.pathname === "/api/v1/listings" && init.method === "GET") return json(200, { listings });
    if (u.pathname === "/api/v1/listings" && init.method === "POST") {
      const l = { key: `OWN-${++n}`, ...body, shown: true, photos: [], source: "own" };
      listings.push(l);
      return json(201, { listing: l });
    }
    const m = u.pathname.match(/^\/api\/v1\/listings\/([^/]+)(\/photos)?$/);
    const l = m && listings.find((x) => x.key === decodeURIComponent(m[1]));
    if (!l) return json(404, { error: { code: "not_found" } });
    if (m[2]) { l.photos.push(`photo-${l.photos.length}`); return json(201, { photo: {}, listing: l }); }
    Object.assign(l, body);
    return json(200, { listing: l });
  };
  return { fetch, calls, listings, writes: () => calls.filter((c) => c.method !== "GET") };
}

const room = (offerId, over = {}) => ({
  id: `room-${offerId}`, offerId, kind: "deal", status: "active", publicSections: PUBLIC, updatedAt: "2026-11-01T00:00:00Z",
  snapshot: {
    sections: PUBLIC,
    property: { address: "1200 Example Avenue North, Tacoma, Washington 98406", beds: 3, baths: 2, sqft: 1500, yearBuilt: 1962 },
    numbers: { investorPrice: 410000, arv: 620000, repairs: 70000 },
    notes: "Needs a kitchen and a roof.",
    ...over,
  },
});
const deal = (id, stage) => ({ id, address: "1200 Example Ave N, Tacoma, WA 98406", deal: { stage, contractPrice: 390000 } });

test("nothing goes to Porchcard while the switch is off, or for another location", async () => {
  const pc = makePorchcard();
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [room("o1")] } });
  assert.equal(await maybeRunPorchcardSync({ locationId: LOC, store, env: {}, deps: { fetch: pc.fetch }, now: NOW }), null);
  assert.equal(await maybeRunPorchcardSync({ locationId: LOC, store, env: { ...ENV, PORCHCARD_SYNC_ENABLED: "false" }, deps: { fetch: pc.fetch }, now: NOW }), null);
  assert.equal(await maybeRunPorchcardSync({ locationId: "other", store, env: ENV, deps: { fetch: pc.fetch }, now: NOW }), null);
  assert.equal(pc.calls.length, 0);
});

test("a live deal goes up on Matt's profile with its room's photos, once", async () => {
  const pc = makePorchcard();
  const store = makeStore({
    deals: [deal("o1", "buyer_found")],
    rooms: { o1: [room("o1")] },
    photos: { o1: [{ id: "p2", sort: 2 }, { id: "p1", sort: 1 }] },
  });
  const r = await maybeRunPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.equal(r.changed, 2); // created, then photos
  const posts = pc.writes();
  assert.equal(posts[0].path, "/api/v1/listings");
  assert.equal(posts[0].body.price, 410000);
  assert.equal(posts[0].headers["Porchcard-Account"], "acct-matt");
  assert.equal(posts[0].headers["Idempotency-Key"], "shepflips-deal-o1");
  assert.deepEqual(posts.slice(1).map((c) => c.headers["Idempotency-Key"]), ["shepflips-photo-p1", "shepflips-photo-p2"]);
  assert.match(posts[1].body.data, /^data:image\/jpeg;base64,/);
  assert.equal(store.cursors[CURSOR_NAME].doc.links.o1.photosDone, true);
  assert.equal(store.cursors[CURSOR_NAME].doc.run, null);

  pc.calls.length = 0;
  await maybeRunPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW + 15 * 60000 });
  assert.equal(pc.writes().length, 0);
});

test("a house already put up by hand is taken as the deal's listing, not listed a second time", async () => {
  const pc = makePorchcard([{ key: "OWN-hand", address: "1200 Example Ave N", zip: "98406", status: "active", shown: true, photos: ["a", "b"], source: "own" }]);
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [room("o1")] }, photos: { o1: [{ id: "p1" }] } });
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.equal(pc.writes().length, 0);
  assert.deepEqual(store.cursors[CURSOR_NAME].doc.links.o1, { key: "OWN-hand", photoIds: [], photosDone: true });
});

test("when the deal closes its listing is marked closed at the contract price with no ARV or rehab, then left alone", async () => {
  const pc = makePorchcard([{ key: "OWN-1", address: "1200 Example Ave N", zip: "98406", status: "active", shown: true, photos: ["a"], arv: 620000, rehab: 70000, source: "own" }]);
  const store = makeStore({ deals: [deal("o1", "closed")], rooms: { o1: [room("o1")] } });
  store.cursors[CURSOR_NAME] = { at: "", doc: { links: { o1: { key: "OWN-1", photosDone: true } } } };
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  const [patch] = pc.writes();
  assert.equal(patch.method, "PATCH");
  assert.deepEqual({ ...patch.body, description: undefined }, { status: "closed", price: 390000, description: undefined, arv: null, rehab: null });
  assert.match(patch.body.description, /^Closed\./);

  // Next tick it's settled; the one after makes no call to Porchcard at all.
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW + 900000 });
  assert.equal(store.cursors[CURSOR_NAME].doc.links.o1.settled, true);
  pc.calls.length = 0;
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW + 1800000 });
  assert.equal(pc.calls.length, 0);
});

test("a deal that falls through comes off the profile, and Porchcard isn't called about it again", async () => {
  const pc = makePorchcard([{ key: "OWN-1", address: "1200 Example Ave N", zip: "98406", status: "active", shown: true, photos: ["a"], source: "own" }]);
  const store = makeStore({ deals: [deal("o1", "fell_through")], rooms: { o1: [room("o1")] } });
  store.cursors[CURSOR_NAME] = { at: "", doc: { links: { o1: { key: "OWN-1", photosDone: true } } } };
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.deepEqual(pc.writes().map((c) => c.body), [{ shown: false }]);
  pc.calls.length = 0;
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW + 900000 });
  assert.equal(pc.calls.length, 0);
});

test("a dead deal that never went up costs no call to Porchcard", async () => {
  const pc = makePorchcard();
  const store = makeStore({ deals: [deal("o1", "fell_through")], rooms: { o1: [room("o1")] } });
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.equal(pc.calls.length, 0);
});

test("a deal whose room keeps its photos private doesn't go up", async () => {
  const pc = makePorchcard();
  const privateRoom = { ...room("o1"), publicSections: { ...PUBLIC, photos: false } };
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [privateRoom] } });
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.equal(pc.writes().length, 0);
});

test("an agent-facing offer page is never published, even when it's the only room on the deal", async () => {
  const pc = makePorchcard();
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [{ ...room("o1"), kind: "offer" }] } });
  await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW });
  assert.equal(pc.writes().length, 0);
});

test("a deal Porchcard keeps refusing is tried three times in a day, then waits for tomorrow", async () => {
  const pc = makePorchcard();
  const failing = async (url, init) => (init?.method === "POST"
    ? { ok: false, status: 400, headers: new Map(), json: async () => ({ error: { code: "invalid_request", field: "zip" } }) }
    : pc.fetch(url, init));
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [room("o1")] } });
  for (let i = 0; i < 4; i++) await runPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: failing }, now: NOW + i * 900000 });
  assert.equal(pc.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/listings").length, 3);
  assert.equal(store.cursors[CURSOR_NAME].doc.links.o1.fails, 3);
});

test("a run another broker started a minute ago is left to finish", async () => {
  const pc = makePorchcard();
  const store = makeStore({ deals: [deal("o1", "buyer_found")], rooms: { o1: [room("o1")] } });
  store.cursors[CURSOR_NAME] = { at: "", doc: { run: { startedAt: new Date(NOW - 60000).toISOString() } } };
  assert.equal(await maybeRunPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW }), null);
  store.cursors[CURSOR_NAME].doc.run.startedAt = new Date(NOW - 31 * 60000).toISOString();
  assert.ok(await maybeRunPorchcardSync({ locationId: LOC, store, env: ENV, deps: { fetch: pc.fetch }, now: NOW }));
});
