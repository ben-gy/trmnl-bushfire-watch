# Bushfire Watch (TRMNL private plugin)

A TRMNL screen for one house in Victoria: today's and tomorrow's official Fire Danger Rating and
Total Fire Ban for its fire district, the weather that drives fire behaviour, and the warnings,
fires, planned burns and CFA calls within 30 km.

It is a Cloudflare Worker that TRMNL's cloud polls every 15 minutes (the Private Plugin "Polling"
strategy) plus the Liquid template TRMNL renders into the 800×480 1-bit image. **It is not an official warning service** — it can be late, incomplete or wrong. Use the
VicEmergency app, emergency.vic.gov.au or the VicEmergency Hotline 1800 226 226, and call 000 if you
see fire.

```
TRMNL cloud ──GET /v1/brief.json (headers: token, home location, district, radius)──▶ Worker
   Worker ─▶ VicEmergency events + FDR/TFB · CFA RSS · BoM IDV18555/IDV18560 · Open-Meteo · Vicmap
   Worker ─▶ one JSON document (≤ 6 KB, always HTTP 200) ─▶ plugin/src/full.liquid ─▶ device
```

## What it shows, and where each piece comes from

| On screen | Source | Notes |
|---|---|---|
| Warnings over or near the house | VicEmergency `public/events-geojson.json` | Measured from the warning **area's edge** (from its point, marked `~`, when it has no area); a warning covering the house takes over the top band |
| Fire Danger Rating and Total Fire Ban, today and tomorrow | VicEmergency `public/osom-fdrtfb.json` and the events feed's `conditions`, CFA's RSS; the rating also from BoM IDV18555 | By fire weather district, merged by date: the highest rating wins and any source's YES declares a ban |
| FBI, BoM's wind-change danger flag | BoM `reg.bom.gov.au/fwo/IDV18555.xml`, `IDV18560.xml` | Personal use only (BoM terms) |
| Max/min, humidity, wind and gusts, rain | Open-Meteo forecast (its default best-match model) | Labelled "model"; gusts run above BoM's. Sent the home location rounded to 2 dp (~1 km) |
| Counts within the radius | VicEmergency | warnings · going · controlled · burns · other CFA |
| District, council and neighbouring districts | Vicmap `cfa_tfb_district` and LGA (State of Victoria) | Looked up from the home location rounded to 3 dp (~100 m), even when you pick a district (the pick only overrides the answer); queried until Vicmap gives a complete answer, then cached 30 days per radius. While Vicmap is down an older answer (kept up to 90 days) stands in |

The home location lives only in TRMNL's form field and reaches the Worker in a request header. The
Worker never logs it and never stores the coordinates. The only copies that leave it are the
rounded points above, sent to Open-Meteo on each weather refresh (about every 15 minutes) and to
Vicmap as described in the table. The KV keys for the weather and the district lookup are hashes of
those rounded points, which someone with access to your KV could reverse by trying every point in
Victoria, and the district record names the council.

Failures never look like good news: a source that can't be read shows **UNAVAILABLE** (never 0 or
"No Rating"); an old all-clear is withheld (a warnings feed 10–45 minutes old is still shown, marked
OLD DATA); and an old alarm (Extreme or above, a Total Fire Ban, a warning over the house) stays for
up to 6 hours, labelled "LAST KNOWN" or "as of". The screen switches to **OUT OF DATE** when it
hasn't been updated for over an hour, that is, when TRMNL renders an answer the Worker made more
than an hour earlier. A device that stops refreshing altogether keeps its last image, so glance at
the **Checked** time in the title bar.

## Set it up

1. **Worker**:
   ```bash
   npm install
   npx wrangler kv namespace create FIRE_KV          # paste the id into wrangler.jsonc
   TOKEN=$(openssl rand -hex 32); echo "$TOKEN"      # the token: hex only (see below); keep it for step 2
   printf %s "$TOKEN" | npx wrangler secret put BRIEF_TOKEN
   npm run deploy
   ```
   Use a hex token (`openssl rand -hex 32`, characters 0–9 and a–f): TRMNL splits `polling_headers`
   on `&` and `=`, so a base64 token (`=`, `+`, `/`) can arrive mangled and every poll would show
   CONFIGURATION ERROR. `settings.yml` also passes it through `url_encode`, as TRMNL's help page
   documents for header values. Without the KV binding the Worker still runs, but keeps its
   last-good copies in isolate memory only.
   Then check the upstreams from the deployed Worker (`placement` should name a Sydney colo, e.g.
   `remote-SYD`, and `kv` should read `ok`):
   ```bash
   curl -s -H "x-brief-token: $TOKEN" https://trmnl-fire-risk.<account>.workers.dev/v1/sources | jq
   ```
2. **TRMNL** (needs the Developer Edition add-on, US$20 once per device):
   Plugins → Private Plugin → New. Strategy **Polling**; set `polling_url` to your Worker's
   `/v1/brief.json`, and copy `polling_headers` and the form fields from `plugin/src/settings.yml`;
   paste `plugin/src/full.liquid` into the Full markup.
   Fill in the form: your home location, district (**Central** for North Warrandyte, or Auto), radius
   30 km and the token. Save, then **Force Refresh**.
   (`trmnlp push` from `plugin/` also works if you have Ruby ≥ 4: `brew install ruby`, `gem install
   trmnl_preview`. Add the `id` the first push prints to `settings.yml`, or every push creates a new
   plugin.)
3. **Device**, for the fire season:
   - make this the only playlist item (or mark it important) with the 15-minute refresh;
   - turn **Sleep Mode off**; keep it on **USB power** and enable low-battery email;
   - don't put Cloudflare Bot Fight Mode or WAF challenges in front of the Worker (they block TRMNL).

## Routes

| Route | What it does |
|---|---|
| `GET /v1/brief.json` | The merge variables TRMNL polls. Needs `x-brief-token`; takes `x-home-secret` (`lat,lon`), `x-district` (`auto` or a district) and `x-radius-km` (5–100, default 30). Always HTTP 200: a missing or wrong token or location comes back as a full-screen message, with an `x-brief-error` response header naming the problem; an unknown district means `auto` |
| `GET /v1/sources` | Needs `x-brief-token`. Each upstream's HTTP status, time and revalidation as seen from wherever the Worker runs, plus the KV check and placement |
| `GET /health` | Liveness, no token and no upstream calls |
| `GET /preview` | Dev only (`DEV=1`); see below |

## Develop

```bash
npm test            # vitest: parsers, geometry, ratings, weather, store, template, worker
npm run typecheck
npm run dev         # wrangler dev with DEV=1 and ALLOW_QUERY_LOCATION=1
```

- `GET /v1/brief.json?fixture=busy-warrandyte` (with `x-brief-token`) renders from bundled, scrubbed
  fixtures (`quiet`, `busy-warrandyte`, `horsham-inside`, `catastrophic`, `outage`) with a frozen
  clock and no network calls, watermarked "SAMPLE DATA · NOT LIVE". It needs no location, works on
  the deployed Worker too, and a TRMNL test plugin pointed at it checks real rendering.
- `GET /v1/brief.json?lat=-37.73&lon=145.22` (also `district=` and `radius_km=`) works in dev only:
  production takes them from the headers, so the location never lands in URLs or logs.
- `GET /preview` (dev only) renders the template with every fixture at 800×480 using TRMNL's own CSS
  and runs an overflow check. `?live` adds a live render at the suburb test point; `?bits=2` renders
  in 2-bit.
- `npm run capture` writes dated snapshots of every live feed to `fixtures/local/`
  (git-ignored) and re-creates the two archived VicEmergency days in `fixtures/` from pinned commits;
  events captures are scrubbed of officer email addresses and warning text before they are written.
  A capture changes nothing the tests or `?fixture=` read. To update a committed fixture, copy a
  scrubbed capture into `fixtures/`, point `src/fixtures.ts`, `test/helpers.ts` (`FX`) and the tests
  that read the file directly at its new name, update `THIRD_PARTY.md`, and delete the old file; the
  frozen test clocks and some expectations follow the snapshot. Never copy a BoM capture: the
  committed `IDV185*-sample.xml` files are synthetic.

Never commit the house's exact coordinates: they live only in the TRMNL form field. `.wrangler/`
(at any depth: `wrangler dev` caches the dev machine's IP geolocation there) and `fixtures/local/`
(live captures, including BoM products that must not be published) are git-ignored.

## Licences and terms

- VicEmergency data © State of Victoria, Australia (Emergency Management Victoria), CC BY 3.0 AU —
  <https://www.emv.vic.gov.au/responsibilities/victorias-warning-system/emergency-data>. The screen
  shows when the feed was last received, as the licence requires. No logos or branding are used.
- CFA RSS feeds and Vicmap: CC BY 4.0 (DataVic).
- Bureau of Meteorology products: personal use only; not for redistribution or commercial use.
- Open-Meteo: CC BY 4.0, free for non-commercial use.

Keep the plugin private: don't publish it as a TRMNL recipe. Test-data credits are in
`THIRD_PARTY.md`; the code is MIT (`LICENSE`).
