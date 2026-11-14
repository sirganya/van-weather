// Offline smoke test: mocks the three upstream APIs + ntfy and exercises the Worker end to end.
import worker from "../src/index.js";

const store = new Map();
const WX = {
  get: async (k, t) => { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
};
const env = { WX, TOKEN: "s3cret", PUSHOVER_TOKEN: "apptoken", PUSHOVER_USER: "userkey", GUST_WARN_KMH: "70", GUST_SEVERE_KMH: "90", FROST_C: "0", RAIN_24H_MM: "40", RAIN_HOURLY_MM: "10", FORECAST_HOURS: "48", GREY_FREEZE_C: "0", GREY_FREEZE_HOURS: "2", GREY_HARD_C: "-2", GREY_LEAD_HOURS: "3", TANK_FREEZE_C: "-2", TANK_FREEZE_HOURS: "4", TANK_HARD_C: "-5" };

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

const hours = 48;
const t0 = new Date("2026-11-01T12:00");
const times = Array.from({ length: hours }, (_, i) => new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 16));
const openMeteoJson = {
  hourly: {
    time: times,
    wind_gusts_10m: times.map((_, i) => (i >= 6 && i <= 14 ? (i === 8 ? 96 : 75) : 40)),
    wind_speed_10m: times.map((_, i) => (i >= 6 && i <= 14 ? 55 : 25)),
    wind_direction_10m: times.map((_, i) => (i < 9 ? 220 : i < 12 ? 265 : 310)),
    temperature_2m: times.map((_, i) => (i === 18 ? -1.2 : i >= 40 && i <= 45 ? (i === 43 ? -4 : -3) : 6)),
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
  if (url.includes("pushover.net")) { const f = init.body; pushes.push({ url, headers: { Title: f.get("title"), Priority: f.get("priority") }, body: f.get("message"), po: Object.fromEntries(f) }); return Response.json({ status: 1, request: "r1" }); }
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
assert(last.forecast.alerts.includes("fc:gust:2026-11-01") && last.forecast.alerts.some((a) => a.startsWith("fc:tank:")) && last.forecast.alerts.some((a) => /^fc:grey:[\d-]+$/.test(a)) && !last.forecast.alerts.some((a) => a.endsWith(":now")) && !last.forecast.alerts.some((a) => a.startsWith("fc:frost")), "gust + grey heads-up + fresh tank; no 'now' yet; frost suppressed");
const greyPush = pushes.find((p) => p.po && /^GREY TANK — heater on by/.test(p.po.title));
assert(greyPush && greyPush.po.priority === "1", "grey heads-up is high priority with heater-on time");
console.log("--- grey alert ---\n" + greyPush.po.title + "\n" + greyPush.body + "\n------------------");
const tankPush = pushes.find((p) => p.po && /TANK FREEZE/.test(p.po.title));
assert(tankPush && tankPush.po.priority === "1" && /Below -2°C from .* until .* \(6h\)/.test(tankPush.body) && /Coldest -4\.0°C/.test(tankPush.body), "tank alert: high priority, spell start/end/duration, min temp");
console.log("--- tank alert ---\n" + tankPush.po.title + "\n" + tankPush.body + "\n------------------");
assert(!last.forecast.alerts.some((a) => a.startsWith("fc:rain")), "no rain alert at 12mm");
const windPush = pushes.find((p) => p.po && /SEVERE WIND/.test(p.po.title));
assert(windPush && /Swing:.*veers to W.*veers to NW/.test(windPush.body) && !/Nose to/.test(windPush.body), "wind alert has direction and swing, no advice");
console.log("--- wind alert ---\n" + windPush.po.title + "\n" + windPush.body + "\n------------------");
assert(pushes.length === 4, `4 alerts sent (got ${pushes.length})`);
const po = pushes.find((p) => p.po && p.po.title.startsWith("ORANGE Wind"));
assert(po && po.po.priority === "2" && po.po.retry === "300", "orange warning is Pushover emergency with retry");
console.log("   sample push:", pushes[0].headers.Title, "|", pushes[0].body.split("\n")[0]);

// 3. second check → nothing re-sent
await call("/check?token=s3cret");
assert(pushes.length === 4, "no duplicate pushes on re-check");

// 4. forced check → re-sends
await call("/check?token=s3cret&force");
assert(pushes.length === 8, "force re-sends");

// 5. manual post nearby (<15km) does not re-run check; status works
r = await call("/loc", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: JSON.stringify({ lat: 53.81, lon: -9.52 }) });
assert((await r.json()).ok, "manual post ok");
assert(pushes.length === 8, "nearby move doesn't trigger a check");
assert((await call("/status")).status === 401, "status requires token");
assert((await call("/status?token=wrong")).status === 401, "status rejects wrong token");
assert((await call("/status?token=s3cret%20")).status === 200, "token with trailing space accepted");
assert((await worker.fetch(new Request("https://van.example/status?token=s3cret"), { ...env, TOKEN: " s3cret\n" }, ctx)).status === 200, "secret with whitespace accepted");
r = await call("/status?token=s3cret");
assert((await r.json()).loc.lat === 53.81, "status reflects latest location");

// 6. scheduled handler runs
await worker.scheduled({}, env, ctx);
assert(JSON.parse(store.get("last")).ok, "scheduled run ok");

// 7. test push
r = await call("/test?token=s3cret");
assert(pushes.at(-1).headers.Title.startsWith("TEST — "), "test push");

// 8. page renders
r = await call("/");
const html = await r.text();
assert(html.includes("I'm here"), "manual page served");
// The page script must at least compile — a syntax error there silently kills the whole UI.
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
let compiles = true; try { new Function(script); } catch (e) { compiles = false; console.error("   page script error:", e.message); }
assert(compiles, "page script compiles");

// 9. test push carries a real formatted outlook; missing config is reported
for (const [type, re, pri] of [["push", /Push is working/, 3], ["wind", /Swing:.*veers/, 5], ["official", /^ORANGE Wind — Mayo/, 5], ["frost", /^Frost/, 3], ["tank", /^FRESH TANK FREEZE/, 4], ["grey", /^GREY TANK — heater on by/, 4], ["greynow", /^GREY TANK HEATER ON/, 5], ["rain", /^Heavy rain/, 3]]) {
  r = await call(`/test?token=s3cret&type=${type}`);
  const tj = await r.json();
  assert(tj.ok && (re.test(tj.title) || re.test(tj.body)) && tj.priority === pri && pushes.at(-1).po.title.startsWith("TEST — "), `test ${type} alert`);
}
const none = { ...env, PUSHOVER_TOKEN: undefined };
r = await worker.fetch(new Request("https://van.example/test?token=s3cret"), none, ctx);
const j = await r.json();
assert(j.ok === false && /PUSHOVER_TOKEN/.test(j.error), "missing Pushover config is reported");

// 10. grey spell within lead time → emergency "heater on"
openMeteoJson.hourly.temperature_2m = times.map((_, i) => (i >= 2 && i <= 8 ? -1 : 6));
store.set("sent", "{}");
await call("/check?token=s3cret");
const nowPush = pushes.find((p) => p.po && /^GREY TANK HEATER ON — freezing in 2h/.test(p.po.title));
assert(nowPush && nowPush.po.priority === "2", "heater-on emergency fires when spell is 2h away");
assert(!JSON.parse(store.get("last")).forecast.alerts.some((a) => a.startsWith("fc:tank")), "fresh tank not alerted at -1°C");

// 11. Atom feed refuses (406) → JSON API fallback still matches the county
const jsonApi = [{ uuid: "u1", alert: { identifier: "IE-json-1", status: "Actual", msgType: "Alert", info: [
  { language: "en-GB", event: "Wind", severity: "Moderate", onset: "2026-11-01T18:00:00Z", expires: "2099-01-01T00:00:00Z", description: "Yellow wind warning.", area: [{ areaDesc: "Mayo" }] },
  { language: "en-GB", event: "Rain", severity: "Moderate", onset: "2026-11-01T18:00:00Z", expires: "2099-01-01T00:00:00Z", description: "x", area: [{ areaDesc: "Cork" }] } ] } }];
globalThis.fetch = ((orig) => async (u, i) => {
  const url = String(u);
  if (url.includes("meteoalarm-legacy-atom")) return new Response("Not Acceptable", { status: 406 });
  if (url.includes("/api/v1/warnings/")) return Response.json(jsonApi);
  return orig(u, i);
})(globalThis.fetch);
store.set("sent", "{}");
await call("/check?token=s3cret");
const l2 = JSON.parse(store.get("last"));
assert(l2.official.feed.includes("/api/v1/") && l2.official.matched === 1 && /406/.test(l2.official.note), `JSON fallback used after 406 (matched ${l2.official.matched})`);
assert(pushes.at(-1).po.title.startsWith("YELLOW Wind — Mayo") || pushes.some((p) => p.po && p.po.title.startsWith("YELLOW Wind — Mayo")), "JSON-sourced warning pushed");

// 12. post attempts are logged, including rejected ones
await call("/loc", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + btoa("greg:wrongpw"), "user-agent": "OwnTracks/1.0" }, body: JSON.stringify({ _type: "location", lat: 1, lon: 1 }) });
r = await call("/status?token=s3cret"); const st = await r.json();
assert(st.recentPosts[0].status === 401 && /OwnTracks/.test(st.recentPosts[0].ua) && st.recentPosts.some((p) => /owntracks location accepted/.test(p.note)), "post log shows rejected OwnTracks attempt and earlier success");

// 13. BigDataCloud fails → Nominatim fallback; failures are not cached
store.delete("place");
globalThis.fetch = ((orig) => async (u, i) => {
  const url = String(u);
  if (url.includes("bigdatacloud")) return new Response("", { status: 500 });
  if (url.includes("nominatim")) return Response.json({ address: { town: "Gorey", county: "County Wexford", state: "Leinster", country: "Ireland", country_code: "ie" } });
  return orig(u, i);
})(globalThis.fetch);
await call("/check?token=s3cret");
let l3 = JSON.parse(store.get("last"));
assert(l3.place.country === "IE" && l3.place.source === "nominatim" && /Gorey/.test(l3.place.label), "nominatim fallback resolves Wexford");
store.delete("place");
globalThis.fetch = ((orig) => async (u, i) => (String(u).includes("nominatim") ? new Response("", { status: 503 }) : orig(u, i)))(globalThis.fetch);
await call("/check?token=s3cret");
l3 = JSON.parse(store.get("last"));
assert(l3.place.country === null && store.get("place") === undefined && /no country/.test(l3.official.error), "geocode failure not cached, reported in status");
