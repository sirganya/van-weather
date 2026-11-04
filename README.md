# van-weather

Weather warnings for wherever the van is parked, pushed to your phone.

- **Location in:** phone posts GPS to the Worker (OwnTracks in the background, or the "I'm here" button on the web page).
- **Hourly check:** official national warnings from [Meteoalarm](https://meteoalarm.org) (all of Europe) + [Open-Meteo](https://open-meteo.com) forecast thresholds for wind gusts, frost and heavy rain.
- **Push out:** [Pushover](https://pushover.net) → iPhone notification. Orange/red warnings and severe gusts go out as *emergency* (repeats until acknowledged); yellow/wind as *high* (bypasses quiet hours). ntfy can be kept as an optional backup channel.

Runs on a Cloudflare Worker with one KV namespace. Free tier is plenty.

## Deploy (GitHub → Cloudflare)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick `sirganya/van-weather`.
   Build command: leave empty. Deploy command: `npx wrangler deploy`. Deploy.
2. Worker → **Settings → Variables and Secrets** → add these **secrets**:
   - `TOKEN` — any long random string. The phone uses it to post location.
   - `PUSHOVER_TOKEN` — the API token of an application you create at pushover.net/apps/build (name it van-weather).
   - `PUSHOVER_USER` — your user key, shown on the pushover.net dashboard.
   - `NTFY_TOPIC` — optional. If set, every alert is also posted to this ntfy topic.
3. Note the Worker URL, e.g. `https://van-weather.<you>.workers.dev`.

Every push to `main` redeploys.

## Phone setup (iPhone)

**Notifications**
1. Install the **Pushover** app (one-off purchase after the trial), sign in.
2. iOS Settings → Notifications → Pushover: allow notifications, Lock Screen + Banners on, and turn on **Critical Alerts** so emergency warnings break through silent mode and Focus.
3. Open `https://van-weather…workers.dev/?token=YOUR_TOKEN` in Safari once (it stores the token) → tap **Test push**.
4. Optional: in the Pushover app, set Quiet Hours — normal-priority alerts (frost, rain) respect them; wind warnings don't.

**Background location (recommended)**
1. Install **OwnTracks**.
2. Settings → Mode: **HTTP**.
3. URL: `https://van-weather…workers.dev/loc`
4. Authentication: username anything, password `YOUR_TOKEN`.
5. Monitoring mode: **Significant** (battery-friendly, fires when you move a few hundred metres).

**Manual fallback**
Open the Worker URL in Safari, add it to the home screen, tap **I'm here** whenever you park up. Moving more than 15 km triggers an immediate check instead of waiting for the hourly run.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /` | — | Manual page (static; shows nothing without the token) |
| `GET /status` | token | Last location, resolved place, last check result |
| `POST /loc` | token | Accepts `{lat, lon}` or an OwnTracks location message |
| `GET /check` | token | Run the check now (`?force=1` re-sends active alerts) |
| `GET /test` | token | Send a test push |

Token goes in `Authorization: Bearer …`, Basic auth password, or `?token=`.

## Tuning

Thresholds live in `wrangler.toml` under `[vars]`: gust warning/severe speeds (km/h), frost temperature, 24h rain total. Defaults: 70/90 km/h, 0 °C, 30 mm.

## Known limits

- **Meteoalarm area matching is by name.** Meteoalarm publishes warnings per named area (Irish counties, French départements, German Landkreise…). The Worker reverse-geocodes your position and matches those names against the warning's area name. It works well in most countries; if a country uses area names that don't line up with administrative names, warnings there can be missed. `/status` shows the names it's matching on — check it when you cross a border.
- Meteoalarm covers Europe only. Outside Europe you still get the Open-Meteo thresholds.
- The Worker only knows where you are if the phone tells it. iOS can suspend background apps; the manual button exists for that reason.

## Test

```
node test/run.mjs
```

Offline smoke test with mocked upstreams.
