# iRacing /data API — research notes for Steward Kit

Research date: 2026-07-07. No live iRacing account was available during
development, so nothing here has been verified against the real API by us.
Everything is labeled:

- `[DOCUMENTED]` — stated by iRacing (release notes, /data/doc structure,
  official forum posts quoted by the community).
- `[FROM-CLIENT-SOURCE]` — read directly from the source code of maintained
  open-source clients (primarily `jasondilworth56/iracingdataapi` (Python)
  and `adrianjsclark/aydsko-iracingdata` (C#, has full response models)).
  These clients are widely used, so their shapes are probably right, but they
  are still second-hand.
- `[GUESS]` — our inference. Could be wrong.
- `[UNTESTED]` — applies to *everything* in this file in the sense that we
  have not run it against a live login. Use `--raw-dir` on `fetch_case.py`
  to dump raw responses on the first real run and please report differences.

## 1. Authentication

`[FROM-CLIENT-SOURCE]` Legacy password flow, still the one used by every
open-source client as of mid-2026:

```
POST https://members-ng.iracing.com/auth
Content-Type: application/json

{"email": "<email>", "password": "<encoded>"}
```

where `encoded = base64( sha256( password + lower(email) ) )` — raw digest
bytes, then base64. The email is lowercased (and should be whitespace-trimmed
`[DOCUMENTED]` per iRacing's own masking-algorithm description) before
concatenation; the password is used as typed.

- `[FROM-CLIENT-SOURCE]` Success = HTTP 200 **and** a non-empty `authcode`
  field in the JSON body. Session auth is carried by cookies set on the
  response (`requests.Session` handles this automatically). Some newer
  client versions also use a Bearer token; the cookie flow is the
  lowest-common-denominator and is what we implement.
- `[DOCUMENTED]` iRacing sometimes requires interactive verification
  (captcha): the /auth response then contains `"verificationRequired": true`
  and no usable authcode. There is no programmatic workaround — the user must
  log in via the website in a browser once, then retry. We detect this field
  and print exactly that instruction.
- `[FROM-CLIENT-SOURCE]` Rate limiting: HTTP 429 with `x-ratelimit-reset`
  header (unix timestamp). Also `x-ratelimit-remaining` on normal responses.
  We honor 429 with a bounded wait-and-retry.
- `[GUESS]` Repeated failed logins escalate to captcha/lockout quickly —
  we fail fast after one 401/verification response rather than retrying
  credentials.
- iRacing is rolling out OAuth2 (`oauth.iracing.com`) `[DOCUMENTED]`, but it
  requires client registration and the legacy /auth flow still works for
  personal scripting. Revisit if /auth is ever turned off.

## 2. The link-indirection pattern

`[FROM-CLIENT-SOURCE]` Every `/data/...` endpoint returns a small JSON body
containing a pre-signed S3 URL instead of the data:

```
GET https://members-ng.iracing.com/data/results/get?subsession_id=...
-> {"link": "https://scorpio-assets.s3.amazonaws.com/...", "expires": "..."}
```

Fetch the `link` URL **without** iRacing cookies/auth headers (the signature
is in the URL) to get the actual JSON payload.

`[FROM-CLIENT-SOURCE]` Large payloads are additionally **chunked**: the
linked payload contains `chunk_info`:

```
{"chunk_info": {"num_chunks": 2,
                "base_download_url": "https://...s3.../",
                "chunk_file_names": ["...0.json", "...1.json"]}}
```

Each chunk is a JSON array; concatenate them in order. `lap_chart_data`,
`lap_data` and `event_log` are all chunked. `[GUESS]` For these endpoints
`chunk_info` may sit under a `chunk_info` key next to other metadata rather
than being the whole body — we search the payload defensively.

## 3. Endpoints we use

### results/get

`GET /data/results/get?subsession_id=<id>&include_licenses=false`
`[FROM-CLIENT-SOURCE]`

Works for official, hosted and league subsessions with no extra params —
the subsession id is globally unique. `[FROM-CLIENT-SOURCE]` (league-specific
endpoints exist for *finding* sessions, but not for fetching results).
Caveat `[GUESS]`: you must be authorized to view the subsession (participant,
league member, or the session is public); expect 401/403 otherwise.

Response shape (top level, partial) `[FROM-CLIENT-SOURCE]`:

- `subsession_id`, `start_time` (ISO-8601), `end_time`
- `session_name` (hosted/league) / `series_name` (official) — either may be
  missing depending on session type
- `league_name`, `league_id` — present for league sessions only
- `track: {track_id, track_name, config_name}`
- `weather: {..., "simulated_start_time"/"simulated_start_utc_time": ...}` —
  exact key for the in-sim clock is `[GUESS]`; we try several.
- `car_classes: [{car_class_id, short_name, name, cars_in_class: [...]}]`
- `session_results: [ {simsession_number, simsession_type,
    simsession_type_name, simsession_name, results: [...] } ]`
  - simsession_number: 0 = main event (the race), negative numbers are the
    preceding sessions (-1 qualifying, -2 practice, ordering varies)
    `[FROM-CLIENT-SOURCE]`
  - each entry in `results`: `cust_id`, `display_name`, `finish_position`
    (0-based `[GUESS]` — the UI should treat it as opaque ordering),
    `finish_position_in_class`, `laps_complete`, `incidents`, `car_id`,
    `car_name`, `car_class_id`, `car_class_name`, `car_class_short_name`,
    `livery: {car_number, ...}`, `average_lap`, `best_lap_time`, ...
  - **Team sessions**: entries are teams (`team_id` < 0 convention) with a
    nested `driver_results` array of the same per-driver shape
    `[FROM-CLIENT-SOURCE]`. We flatten drivers and keep the team car number.

### results/lap_chart_data  (primary lap source)

`GET /data/results/lap_chart_data?subsession_id=<id>&simsession_number=0`
`[FROM-CLIENT-SOURCE]`

Returns lap-by-lap data for **all cars** in one (chunked) response — unlike
`lap_data`, which requires one call per `cust_id`/`team_id`. This is why we
build the case from `lap_chart_data`.

Per-lap fields `[FROM-CLIENT-SOURCE]` (Aydsko `SubsessionChartLap` /
`SubsessionLap` models, JSON names verbatim):

| field | type | notes |
|---|---|---|
| `group_id` | int | cust_id for solo sessions, team id for team sessions `[GUESS]` |
| `cust_id` | int | driver |
| `display_name` | string | |
| `lap_number` | int | lap 0 = grid-to-line crossing, usually no time `[GUESS]` |
| `lap_time` | int | **ten-thousandths of a second**; `-1` = no time (tow, disconnect, lap 0) `[FROM-CLIENT-SOURCE]` |
| `lap_events` | array of strings | see section 4 |
| `incident` | bool | any incident on this lap |
| `flags` | int | undocumented bitfield `[GUESS]`, passed through raw-dump only |
| `session_start_time` | int/null | units unconfirmed `[GUESS]` |
| `session_time` | int | units unconfirmed — probably ten-thousandths like lap_time `[GUESS]` |
| `lap_position` | int | position at end of lap |
| `interval`, `interval_units` | int, "ms"\|"lap" | gap to leader |
| `fastest_lap`, `personal_best_lap`, `ai` | bool | |

Because `session_time`/`session_start_time` units are unconfirmed, we do
**not** use them for replay timestamps; per SPEC we accumulate `lap_time`
sums instead (see fetch_case.py). Raw values are preserved in `--raw-dir`
dumps so the first live test can confirm the units, after which we could
switch to the API's own values.

### results/lap_data

`GET /data/results/lap_data?subsession_id=<id>&simsession_number=0&cust_id=<id>`
`[FROM-CLIENT-SOURCE]` — requires exactly one of `cust_id` or `team_id`.
Same per-lap shape as above. We only use it as a fallback when
`lap_chart_data` fails (one request per driver — slow and rate-limit-hungry).

### results/event_log  (timestamped incident stream — yes, it exists)

`GET /data/results/event_log?subsession_id=<id>&simsession_number=0`
`[FROM-CLIENT-SOURCE]` — chunked. Item fields (Aydsko
`SubsessionEventLogItem`, JSON names verbatim):

`subsession_id`, `simsession_number`, `session_time` (int), `event_seq`
(int), `event_code` (int), `group_id`, `cust_id`, `lap_number`,
`description` (string), `message` (string), `display_name` (string).

This is the same stream the membersite renders as the session event log
("... car contact with ...", black flags, etc.).

- `event_code` values are **undocumented** `[GUESS]` — we pass the code
  through and rely on `description`/`message` for human meaning.
- `session_time` units unconfirmed `[GUESS]` — we assume ten-thousandths of
  a second (consistent with `lap_time`); if the first live test shows the
  event times landing ~10x off from lap-derived times, it is milliseconds —
  flip `EVENT_LOG_TIME_DIVISOR` in fetch_case.py.
- Events sourced from here get `"source": "api"` in the case file so the UI
  and stewards can weigh them accordingly.

## 4. lap_events flag semantics

`[DOCUMENTED]` iRacing's own description of lap data (membersite/lap analysis,
echoed in community analyses of exported lap data): a lap can be flagged as
any combination of —

> pitted, off track, black flag, reset, contact (with an object),
> car contact (with another car), lost control, discontinuity,
> interpolated crossing, clock smash, tow

plus `invalid` (Race Control marks a lap invalid; associated with
interpolated crossings/discontinuities per 2023 release notes
`[DOCUMENTED]`).

`[FROM-CLIENT-SOURCE]` `lap_events` is an array of human-readable strings
(Aydsko models it as `string[]`, no enum). Exact casing as returned by the
API is unconfirmed `[GUESS]` — community dumps show lowercase phrases like
`"car contact"`, `"off track"`. Our mapping (case-insensitive, in
`fetch_case.py::LAP_EVENT_MAP`) into `steward-kit/case@1` flag strings:

| API string (lowercased) | case@1 flag |
|---|---|
| `pitted` | `pitted` |
| `off track` / `offtrack` | `off_track` |
| `black flag` | `black_flag` |
| `contact` | `contact` |
| `car contact` | `car_contact` |
| `lost control` | `lost_control` |
| `invalid` | `invalid` |
| `discontinuity` | `discontinuity` |
| `tow` / `towed` | `tow` |
| `reset` | `reset` |
| `interpolated crossing` | `interpolated_crossing` |
| `clock smash` | `clock_smash` |

Anything else passes through **verbatim** (per SPEC). Note `discontinuity`
can therefore appear both from the API (connection discontinuity) and from
our own interpolation of missing lap times; both mean "treat this timestamp
as unreliable", which is the correct steward-facing semantics.

Severity note `[DOCUMENTED]` (incident points, for context only — we do not
score): off track = 1x, lost control = 2x, contact = 0x/2x, car contact = 4x.

## 5. League / hosted sessions

- `results/get`, `lap_chart_data`, `event_log` all key off `subsession_id`
  alone; no league-specific params `[FROM-CLIENT-SOURCE]`.
- Finding the subsession id: easiest is the league's results page URL on the
  membersite (contains `subsessionid=`). Programmatic search exists
  (`/data/league/season_sessions`, `/data/results/search_hosted` — the
  latter requires `cust_id`/date-range params) but is out of scope for v1.
- `[GUESS]` Hosted/league results include `session_name`, `league_name`,
  `host` fields; official series include `series_name`, `season_name`.
  We take the first non-empty of `session_name`/`series_name`.

## 6. Known unknowns (please verify on first live run)

1. `lap_events` exact strings/casing (`--raw-dir` dump, look at
   `lap_chart_data.json`).
2. `event_log.session_time` units (compare with lap-derived times).
3. Whether `lap_chart_data.session_time` could replace our accumulated
   estimate (would be strictly better if units confirmed).
4. Team-session lap chart: whether laps carry driver `cust_id` per stint or
   the team `group_id` only.
5. `simulated_start` key name in the weather block.
