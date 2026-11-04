// Offline smoke test: mocks the three upstream APIs + ntfy and exercises the Worker end to end.
import worker from "../src/index.js";

const store = new Map();
const WX = {
  get: async (k, t) => { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
};
const env = { WX, TOKEN: "s3cret", NTFY_TOPIC: "van-test", NTFY_URL: "https://ntfy.sh", GUST_WARN_KMH: "70", GUST_SEVERE_KMH: "90", FROST_C: "0", RAIN_24H_MM: "30", FORECAST_HOURS: "24" };

const pushes = [];
const meteoalarmXml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<title>MeteoAlarm Ireland</title>
<entry>
 <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-ireland/abc123?index=0</id>
 <title>Orange Wind warning issued for Ireland - Mayo</title>
 <link href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-ireland/abc123?index=0"/>
 <cap:identifier>2.49.0.0.372.0.IE.abc123</cap:identifier>
 <cap:status>Actual</cap:status>
 <cap:msgType>Alert</cap:msgType>
 <cap:event>Wind</cap:event>
 <cap:severity>Severe</cap:severity>
 <cap:onset>2026-11-01T18:00:00+00:00</cap:onset>
 <cap:expires>2099-11-02T06:00:00+00:00</cap:expires>
 <cap:areaDesc>Mayo</cap:areaDesc>
 <cap:geocode><cap:valueName>EMMA_ID</cap:valueName><cap:value>IE14</cap:value></cap:geocode>
 <cap:description>Southwest winds veering westerly will reach mean speeds of 65 to 80 km/h with gusts of 110 to 130 km/h.</cap:description>
</entry>
<entry>
 <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-ireland/def456?index=0</id>
 <title>Yellow Rain warning issued for Ireland - Cork</title>
 <cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType>
 <cap:event>Rain</cap:event><cap:severity>Moderate</cap:severity>
 <cap:onset>2026-11-01T18:00:00+00:00</cap:onset><cap:expires>2099-11-02T06:00:00+00:00</cap:expires>
 <cap:areaDesc>Cork</cap:areaDesc>
</entry>
<entry>
 <id>expired</id><cap:status>Actual</cap:status><cap:event>Fog</cap:event><cap:severity>Moderate</cap:severity>
 <cap:expires>2000-01-01T00:00:00Z</cap:expires><cap:areaDesc>Mayo</cap:areaDesc>
</entry>
</feed>`;

const hours = 24;
const t0 = new Date("2026-11-01T12:00");
const times = Array.from({ length: hours }, (_, i) => new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 16));
const openMeteoJson = {
  hourly: {
    time: times,
    wind_gusts_10m: times.map((_, i) => (i === 8 ? 96 : 40)),
    temperature_2m: times.map((_, i) => (i === 18 ? -1.2 : 6)),
    precipitation: times.map(() => 0.5),
  },
};
const geo = {
  countryCode: "IE", countryName: "Ireland", principalSubdivision: "County Mayo", locality: "Westport",
  localityInfo: { administrative: [{ name: "Ireland" }, { name: "Connacht" }, { name: "County Mayo" }, { name: "Westport" }] },
};

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url ?? input.toString();
  if (url.includes("meteoalarm")) return new Response(meteoalarmXml, { status: 200 });
  if (url.includes("open-meteo")) return Response.json(openMeteoJson);
  if (url.includes("bigdatacloud")) return Response.json(geo);
  if (url.includes("ntfy.sh")) { pushes.push({ url, headers: init.headers, body: init.body }); return Response.json({ id: "x" }); }
  throw new Error("unexpected fetch " + url);
};

const ctx = { waitUntil: (p) => p };
const call = (path, opts = {}) => worker.fetch(new Request("https://van.example" + path, opts), env, ctx);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok  -", m); };

// 1. unauthorised
assert((await call("/loc", { method: "POST", body: "{}" })).status === 401, "rejects missing token");

// 2. OwnTracks-style post with basic auth → stores + triggers immediate check
let r = await call("/loc", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Basic " + btoa("greg:s3cret") },
  body: JSON.stringify({ _type: "location", lat: 53.8012, lon: -9.5225, tst: 1, acc: 10 }),
});
assert(r.status === 200 && (await r.text()) === "[]", "OwnTracks post accepted, returns []");
const loc = JSON.parse(store.get("loc"));
assert(loc.lat === 53.8012 && loc.source === "owntracks", "location stored");
const last = JSON.parse(store.get("last"));
assert(last.place.country === "IE", "reverse geocode → IE");
assert(last.official.matched === 1, `meteoalarm matched Mayo only (got ${last.official.matched})`);
assert(last.forecast.alerts.includes("fc:gust:2026-11-01") && last.forecast.alerts.includes("fc:frost:2026-11-01"), "forecast gust + frost alerts");
assert(!last.forecast.alerts.some((a) => a.startsWith("fc:rain")), "no rain alert at 12mm");
assert(pushes.length === 3, `3 pushes sent (got ${pushes.length})`);
assert(pushes[0].headers.Priority === "5" && pushes[0].headers.Title.startsWith("ORANGE Wind"), "orange warning is priority 5");
console.log("   sample push:", pushes[0].headers.Title, "|", pushes[0].body.split("\n")[0]);

// 3. second check → nothing re-sent
await call("/check?token=s3cret");
assert(pushes.length === 3, "no duplicate pushes on re-check");

// 4. forced check → re-sends
await call("/check?token=s3cret&force");
assert(pushes.length === 6, "force re-sends");

// 5. manual post nearby (<15km) does not re-run check; status works
r = await call("/loc", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: JSON.stringify({ lat: 53.81, lon: -9.52 }) });
assert((await r.json()).ok, "manual post ok");
assert(pushes.length === 6, "nearby move doesn't trigger a check");
assert((await call("/status")).status === 401, "status requires token");
assert((await call("/status?token=wrong")).status === 401, "status rejects wrong token");
r = await call("/status?token=s3cret");
assert((await r.json()).loc.lat === 53.81, "status reflects latest location");

// 6. scheduled handler runs
await worker.scheduled({}, env, ctx);
assert(JSON.parse(store.get("last")).ok, "scheduled run ok");

// 7. test push
r = await call("/test?token=s3cret");
assert(pushes.at(-1).headers.Title === "van-weather test", "test push");

// 8. page renders
r = await call("/");
assert((await r.text()).includes("I'm here"), "manual page served");

// 9. missing topic → /test reports it instead of pretending
r = await call("/test?token=s3cret");
assert((await r.json()).ok === true, "test push reports ok");
const noTopic = { ...env, NTFY_TOPIC: undefined };
r = await worker.fetch(new Request("https://van.example/test?token=s3cret"), noTopic, ctx);
const j = await r.json();
assert(j.ok === false && /NTFY_TOPIC/.test(j.error), "missing NTFY_TOPIC is reported");
