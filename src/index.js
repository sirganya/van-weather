// van-weather — location-based weather warnings for campervan life.
//
// Phone posts its location → stored in KV → hourly cron checks
// Meteoalarm (official national warnings, all of Europe) and Open-Meteo
// (wind gusts / frost / heavy rain thresholds) → pushes to your phone via Pushover.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The page itself is just static HTML; it shows nothing until the token is right.
    if (path === "/" && request.method === "GET") return page(env);

    // Everything below needs the shared token.
    if (!authorised(request, url, env)) return new Response("unauthorised", { status: 401 });

    if (path === "/status") return json(await status(env));
    if (path === "/loc" && request.method === "POST") return receiveLocation(request, env);
    if (path === "/check") return json(await runCheck(env, { force: url.searchParams.has("force") }));
    if (path === "/test") {
      try {
        const loc = await env.WX.get("loc", "json");
        let title = "TEST — van-weather", body = "Push is working.";
        if (loc) {
          const place = await resolvePlace(env, loc);
          const fc = await openMeteo(env, loc);
          if (fc.wind.alert) {
            title = `TEST — ${fc.wind.title}`;
            body = fc.wind.body + (place.label ? `\n📍 ${place.label}` : "");
          } else {
            body = `Push is working. No wind warning due at ${place.label || "current location"} (max gust ${fc.wind.maxGust} km/h in next ${fc.summary.hours}h).`;
          }
        }
        const res = await notify(env, { title, body, priority: 3 });
        return json({ ok: true, sent: res, title, body });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e), pushoverConfigured: !!(env.PUSHOVER_TOKEN && env.PUSHOVER_USER) });
      }
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, {}));
  },
};

// ---------------------------------------------------------------- auth

function authorised(request, url, env) {
  if (!env.TOKEN) return false;
  const q = url.searchParams.get("token");
  if (q && q === env.TOKEN) return true;
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Bearer ") && h.slice(7) === env.TOKEN) return true;
  if (h.startsWith("Basic ")) {
    // OwnTracks HTTP mode uses basic auth: any username, password = token
    try {
      const [, pass] = atob(h.slice(6)).split(":");
      if (pass === env.TOKEN) return true;
    } catch {}
  }
  return false;
}

// ---------------------------------------------------------------- location in

async function receiveLocation(request, env) {
  let body = {};
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("json")) body = await request.json();
    else if (ct.includes("form")) body = Object.fromEntries(await request.formData());
    else body = JSON.parse(await request.text() || "{}");
  } catch {
    return new Response("bad body", { status: 400 });
  }
  // OwnTracks sends {_type:"location", lat, lon, tst, acc}. Ignore its other message types.
  if (body._type && body._type !== "location") return json([]);

  const lat = Number(body.lat ?? body.latitude);
  const lon = Number(body.lon ?? body.lng ?? body.longitude);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return new Response("need lat/lon", { status: 400 });
  }
  const prev = await env.WX.get("loc", "json");
  const loc = {
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    acc: body.acc ? Number(body.acc) : undefined,
    ts: new Date().toISOString(),
    source: body._type ? "owntracks" : (body.source || "manual"),
  };
  await env.WX.put("loc", JSON.stringify(loc));

  // Moved more than ~15 km? Re-check straight away so you're not waiting an hour.
  if (!prev || distKm(prev, loc) > 15) {
    await env.WX.delete("place");
    await runCheck(env, {});
  }
  // OwnTracks expects a JSON array back.
  return json(body._type ? [] : { ok: true, loc });
}

function distKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const x = (b.lon - a.lon) * d * Math.cos(((a.lat + b.lat) / 2) * d);
  const y = (b.lat - a.lat) * d;
  return Math.sqrt(x * x + y * y) * R;
}

// ---------------------------------------------------------------- the check

async function runCheck(env, { force }) {
  const loc = await env.WX.get("loc", "json");
  if (!loc) return { ok: false, reason: "no location yet" };

  const place = await resolvePlace(env, loc);
  const [official, forecast] = await Promise.all([
    meteoalarm(place).catch((e) => ({ error: String(e), alerts: [] })),
    openMeteo(env, loc).catch((e) => ({ error: String(e), alerts: [] })),
  ]);

  const sent = (await env.WX.get("sent", "json")) || {};
  const now = Date.now();
  // Drop expired dedupe entries
  for (const k of Object.keys(sent)) if (sent[k].until < now) delete sent[k];

  const pushed = [], pushErrors = [];
  for (const a of [...official.alerts, ...forecast.alerts]) {
    const prev = sent[a.id];
    const escalated = prev && a.level > prev.level;
    if (force || !prev || escalated) {
      try {
        await notify(env, {
          title: a.title,
          body: a.body + (place.label ? `\n📍 ${place.label}` : ""),
          priority: a.priority,
                    click: a.link,
        });
        sent[a.id] = { level: a.level, until: a.until || now + 12 * 3600e3 };
        pushed.push(a.id);
      } catch (e) {
        pushErrors.push(`${a.id}: ${e.message}`); // not marked sent → retried next run
      }
    }
  }
  await env.WX.put("sent", JSON.stringify(sent));

  const result = {
    ok: true,
    checked: new Date(now).toISOString(),
    loc,
    place,
    official: { feed: official.feed, matched: official.alerts.length, total: official.total, error: official.error },
    forecast: { summary: forecast.summary, alerts: forecast.alerts.map((a) => a.id), error: forecast.error },
    pushed,
    pushErrors: pushErrors.length ? pushErrors : undefined,
  };
  await env.WX.put("last", JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------- where am I (country + region names)

async function resolvePlace(env, loc) {
  const cached = await env.WX.get("place", "json");
  if (cached && cached.lat === loc.lat && cached.lon === loc.lon) return cached;

  const r = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.lat}&longitude=${loc.lon}&localityLanguage=en`,
    { headers: { "user-agent": "van-weather/1.0" } }
  );
  const g = r.ok ? await r.json() : {};
  // Collect every administrative name we can — Meteoalarm areas are named
  // differently per country (county, département, Landkreis, region...).
  const names = new Set();
  for (const a of g.localityInfo?.administrative || []) if (a.name) names.add(a.name);
  for (const k of ["principalSubdivision", "locality", "city"]) if (g[k]) names.add(g[k]);
  const place = {
    lat: loc.lat,
    lon: loc.lon,
    country: g.countryCode || null,
    countryName: g.countryName || null,
    label: [g.locality || g.city, g.principalSubdivision, g.countryCode].filter(Boolean).join(", "),
    names: [...names],
  };
  await env.WX.put("place", JSON.stringify(place), { expirationTtl: 7 * 86400 });
  return place;
}

// ---------------------------------------------------------------- Meteoalarm

// ISO country code → Meteoalarm feed slug
const FEEDS = {
  AT: "austria", BE: "belgium", BA: "bosnia-herzegovina", BG: "bulgaria", HR: "croatia", CY: "cyprus",
  CZ: "czechia", DK: "denmark", EE: "estonia", FI: "finland", FR: "france", DE: "germany", GR: "greece",
  HU: "hungary", IS: "iceland", IE: "ireland", IL: "israel", IT: "italy", LV: "latvia", LT: "lithuania",
  LU: "luxembourg", MT: "malta", MD: "moldova", ME: "montenegro", NL: "netherlands", MK: "republic-of-north-macedonia",
  NO: "norway", PL: "poland", PT: "portugal", RO: "romania", RS: "serbia", SK: "slovakia", SI: "slovenia",
  ES: "spain", SE: "sweden", CH: "switzerland", UA: "ukraine", GB: "united-kingdom", AD: "andorra",
};

const SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
const COLOUR = { 4: "RED", 3: "ORANGE", 2: "YELLOW", 1: "green" };

async function meteoalarm(place) {
  const slug = FEEDS[place.country];
  if (!slug) return { feed: null, total: 0, alerts: [] };
  const feed = `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`;
  const r = await fetch(feed, { headers: { "user-agent": "van-weather/1.0", accept: "application/atom+xml" } });
  if (!r.ok) throw new Error(`meteoalarm ${r.status}`);
  const xml = await r.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const mine = norm(place.names);
  const now = Date.now();
  const alerts = [];

  for (const e of entries) {
    const tag = (t) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.trim();
    const area = tag("cap:areaDesc") || "";
    const status = tag("cap:status");
    const msgType = tag("cap:msgType");
    if (status && status !== "Actual") continue;
    if (msgType === "Cancel") continue;
    const expires = Date.parse(tag("cap:expires") || "");
    if (expires && expires < now) continue;

    // Area match: Meteoalarm area name vs the administrative names at our position.
    const a = norm([area]);
    if (!a.some((x) => mine.some((y) => x === y || x.includes(y) || y.includes(x)))) continue;

    const sev = tag("cap:severity") || "Minor";
    const level = SEVERITY[sev] || 1;
    if (level < 2) continue; // skip green/minor
    const event = tag("cap:event") || tag("title") || "Weather warning";
    const onset = tag("cap:onset") || tag("cap:effective");
    const link = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1];
    const id = "ma:" + (tag("id") || tag("cap:identifier") || `${event}:${area}:${onset}`);

    alerts.push({
      id,
      level,
      priority: level >= 3 ? 5 : 4,
      title: `${COLOUR[level]} ${event} — ${area}`,
      body: `${fmtRange(onset, tag("cap:expires"))}\n${(tag("cap:description") || tag("summary") || "").replace(/<[^>]+>/g, "").slice(0, 400)}`.trim(),
      link,
      until: expires || undefined,
    });
  }
  return { feed, total: entries.length, alerts };
}

function norm(list) {
  return list
    .filter(Boolean)
    .map((s) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\b(county|co\.?|departement|department|province|region|district|kreis|landkreis|canton|comarca|provincia|comune)\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    )
    .filter((s) => s.length > 2);
}

function fmtRange(a, b) {
  const f = (s) => {
    const d = new Date(s);
    return isNaN(d) ? "" : d.toLocaleString("en-IE", { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
  };
  const x = f(a), y = f(b);
  return x && y ? `${x} → ${y}` : x || y || "";
}

// ---------------------------------------------------------------- Open-Meteo thresholds

async function openMeteo(env, loc) {
  const hours = +env.FORECAST_HOURS || 36;
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", loc.lat);
  u.searchParams.set("longitude", loc.lon);
  u.searchParams.set("hourly", "wind_gusts_10m,wind_speed_10m,wind_direction_10m,temperature_2m,precipitation");
  u.searchParams.set("forecast_hours", hours);
  u.searchParams.set("wind_speed_unit", "kmh");
  u.searchParams.set("timezone", "auto");
  const r = await fetch(u);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const d = await r.json();
  const h = d.hourly;
  const temps = h.temperature_2m, rain = h.precipitation, times = h.time;

  const minT = Math.min(...temps), iT = temps.indexOf(minT);
  const rain24 = rain.slice(0, 24).reduce((s, x) => s + (x || 0), 0);
  const today = times[0].slice(0, 10);

  const alerts = [];
  const gustWarn = +env.GUST_WARN_KMH || 70, gustSevere = +env.GUST_SEVERE_KMH || 90;
  const wind = windOutlook(h, { warn: gustWarn, severe: gustSevere });
  if (wind.alert) {
    alerts.push({
      id: `fc:gust:${today}`,
      level: wind.severe ? 2 : 1,
      priority: wind.severe ? 5 : 4,
      title: wind.title,
      body: wind.body,
    });
  }
  if (minT <= (+env.FROST_C || 0)) {
    alerts.push({
      id: `fc:frost:${today}`,
      level: minT <= -5 ? 2 : 1,
      priority: 3,
      title: `Frost — down to ${minT.toFixed(1)}°C`,
      body: `Coldest around ${fmtT(times[iT])}.`,
    });
  }
  if (rain24 >= (+env.RAIN_24H_MM || 30)) {
    alerts.push({
      id: `fc:rain:${today}`,
      level: rain24 >= 60 ? 2 : 1,
      priority: 3,
      title: `Heavy rain — ${Math.round(rain24)} mm in 24h`,
      body: `Most of it ${fmtT(times[rain.slice(0, 24).indexOf(Math.max(...rain.slice(0, 24)))])}.`,
    });
  }
  return {
    summary: { maxGustKmh: wind.maxGust, peak: wind.peakAt, minTempC: +minT.toFixed(1), rainMm: +rain24.toFixed(1), hours },
    wind,
    alerts,
  };
}

// ---------------------------------------------------------------- wind: direction, duration, swing

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const fmtT = (iso) => new Date(iso).toLocaleString("en-IE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const fmtH = (iso) => new Date(iso).toLocaleString("en-IE", { hour: "2-digit", minute: "2-digit" });
// signed angular difference b - a in (-180, 180]
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;

// Builds the wind alert text from Open-Meteo hourly arrays.
// Reports: peak gust and when, the window(s) of strong wind, the direction at onset,
// and every meaningful swing (≥ 30°) with the time it happens — i.e. when to turn the van.
function windOutlook(h, { warn, severe }) {
  const times = h.time, gusts = h.wind_gusts_10m, dirs = h.wind_direction_10m, speeds = h.wind_speed_10m || gusts;
  const n = times.length;
  const maxGust = Math.round(Math.max(...gusts)), iPeak = gusts.indexOf(Math.max(...gusts));
  const out = { maxGust, peakAt: fmtT(times[iPeak]), peakDir: compass(dirs[iPeak]), alert: maxGust >= warn, severe: maxGust >= severe, windows: [] };

  // Strong-wind windows: consecutive hours with gusts ≥ warn (bridge single-hour lulls).
  let i = 0;
  while (i < n) {
    if (gusts[i] < warn) { i++; continue; }
    let j = i;
    while (j + 1 < n && (gusts[j + 1] >= warn || (j + 2 < n && gusts[j + 2] >= warn))) j++;
    out.windows.push({ from: i, to: j }); // inclusive hour indices
    i = j + 1;
  }

  // Direction track across the whole forecast (so we also see a swing coming before the wind picks up).
  // Walk hourly; emit a change whenever the direction has moved ≥ 30° from the last emitted direction.
  const track = [{ i: 0, deg: dirs[0] }];
  for (let k = 1; k < n; k++) {
    const last = track[track.length - 1];
    if (Math.abs(angDiff(last.deg, dirs[k])) >= 30) track.push({ i: k, deg: dirs[k] });
  }

  if (!out.alert) {
    out.title = `Wind outlook — gusts to ${maxGust} km/h`;
  } else {
    out.title = `${out.severe ? "SEVERE WIND" : "Wind"} — gusts to ${maxGust} km/h from ${out.peakDir}`;
  }

  const lines = [];
  lines.push(`Peak ${maxGust} km/h ${fmtT(times[iPeak])} from ${out.peakDir} (${Math.round(dirs[iPeak])}°)`);

  if (out.windows.length) {
    for (const w of out.windows) {
      const dur = w.to - w.from + 1;
      const wmax = Math.round(Math.max(...gusts.slice(w.from, w.to + 1)));
      lines.push(`Strong ${fmtT(times[w.from])} → ${w.to + 1 < n ? fmtT(times[w.to + 1]) : "end of forecast"} (${dur}h, to ${wmax} km/h)`);
    }
  }

  // Direction now and swings
  lines.push(`Now from ${compass(dirs[0])} (${Math.round(dirs[0])}°), ${Math.round(speeds[0])} km/h`);
  const swings = track.slice(1);
  if (!swings.length) {
    lines.push(`Direction steady from ${compass(dirs[0])} — no swing expected`);
  } else {
    const parts = swings.map((t, k) => {
      const prev = k === 0 ? track[0] : swings[k - 1];
      const d = angDiff(prev.deg, t.deg);
      const how = d > 0 ? "veers" : "backs";
      return `${fmtT(times[t.i])} ${how} to ${compass(t.deg)} (${Math.round(t.deg)}°)`;
    });
    lines.push(`Swing: ${parts.join("; ")}`);
    const total = angDiff(dirs[0], dirs[n - 1]);
    lines.push(`Overall ${Math.abs(Math.round(total))}° ${total > 0 ? "clockwise" : "anticlockwise"} by ${fmtT(times[n - 1])}`);
  }

  out.body = lines.join("\n");
  return out;
}

// ---------------------------------------------------------------- push

// `priority` uses a 1–5 scale throughout: 5 = emergency, 4 = high, 3 = normal.
async function notify(env, { title, body, priority = 3, click }) {
  if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER) throw new Error("PUSHOVER_TOKEN and PUSHOVER_USER secrets must be set on the Worker");
  return pushover(env, { title, body, priority, click });
}

async function pushover(env, { title, body, priority, click }) {
  // Pushover priorities: 2 emergency (repeats until acknowledged), 1 high (bypasses quiet hours), 0 normal.
  const p = priority >= 5 ? 2 : priority >= 4 ? 1 : 0;
  const form = new URLSearchParams({
    token: env.PUSHOVER_TOKEN.trim(),
    user: env.PUSHOVER_USER.trim(),
    title,
    message: body.slice(0, 1024),
    priority: String(p),
    sound: p === 2 ? "siren" : p === 1 ? "alien" : "pushover",
  });
  if (p === 2) { form.set("retry", "300"); form.set("expire", "3600"); } // nag every 5 min for up to an hour
  if (click) { form.set("url", click); form.set("url_title", "Open warning"); }
  if (env.PUSHOVER_DEVICE) form.set("device", env.PUSHOVER_DEVICE);
  const r = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 1) throw new Error(`pushover ${r.status}: ${(j.errors || []).join(", ") || "unknown error"}`);
  return { service: "pushover", request: j.request, priority: p };
}

// ---------------------------------------------------------------- status + manual page

async function status(env) {
  const [loc, last, place] = await Promise.all([
    env.WX.get("loc", "json"),
    env.WX.get("last", "json"),
    env.WX.get("place", "json"),
  ]);
  return { loc, place, last };
}

function json(x) {
  return new Response(JSON.stringify(x, null, 2), { headers: { "content-type": "application/json" } });
}

function page() {
  return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>van-weather</title>
<style>
  body{font:17px/1.4 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:480px;background:#111;color:#eee}
  h1{font-size:22px;margin:0 0 16px}
  button{width:100%;padding:18px;font-size:20px;border:0;border-radius:12px;background:#2d7ef7;color:#fff;margin:8px 0}
  button.sec{background:#333}
  input{width:100%;padding:12px;font-size:16px;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee;box-sizing:border-box}
  pre{background:#1a1a1a;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px;overflow:auto}
  .ok{color:#6c6}.err{color:#f66}
</style>
<h1>🚐 van-weather</h1>
<input id="tok" placeholder="token" type="password">
<button onclick="here()">📍 I'm here</button>
<button class="sec" onclick="check()">Check now</button>
<button class="sec" onclick="test()">Test push</button>
<div id="msg"></div>
<pre id="out">loading…</pre>
<script>
const tok=document.getElementById('tok'),out=document.getElementById('out'),msg=document.getElementById('msg');
const q=new URLSearchParams(location.search);
if(q.get('token')){tok.value=q.get('token');history.replaceState({}, '', '/')}else tok.value=localStorage.token||'';
const auth=()=>({authorization:'Bearer '+tok.value});
const say=(t,c)=>msg.innerHTML='<p class="'+c+'">'+t+'</p>';
let t;tok.oninput=()=>{clearTimeout(t);t=setTimeout(refresh,400)};
async function refresh(){
  if(!tok.value){out.textContent='🔒 Enter the token to see status.';return}
  const r=await fetch('/status',{headers:auth()});
  if(r.status===401){delete localStorage.token;out.textContent='🔒 Wrong token.';return}
  localStorage.token=tok.value;
  out.textContent=JSON.stringify(await r.json(),null,2);
}
function here(){
  if(!tok.value)return say('Enter the token first','err');
  say('Getting GPS…','');
  navigator.geolocation.getCurrentPosition(async p=>{
    const r=await fetch('/loc',{method:'POST',headers:{'content-type':'application/json',...auth()},
      body:JSON.stringify({lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy,source:'manual'})});
    say(r.ok?'Location saved':r.status===401?'Wrong token':'Failed: '+r.status,r.ok?'ok':'err');refresh();
  },e=>say('GPS error: '+e.message,'err'),{enableHighAccuracy:true,timeout:15000});
}
async function check(){say('Checking…','');const r=await fetch('/check?force=1',{headers:auth()});say(r.ok?'Done':r.status===401?'Wrong token':'Failed: '+r.status,r.ok?'ok':'err');refresh()}
async function test(){const r=await fetch('/test',{headers:auth()});if(r.status===401)return say('Wrong token','err');const j=await r.json();say(j.ok?'Test push sent:<br><b>'+j.title+'</b><br><small>'+j.body.replace(/\n/g,'<br>')+'</small>':'Push failed: '+j.error,j.ok?'ok':'err')}
refresh();
</script>`;
