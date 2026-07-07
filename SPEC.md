# Steward Kit — build contract (v1)

Steward Kit cuts league incident review from an hour of replay scrubbing to
minutes: pull a hosted/league session's results from the iRacing /data API,
get a per-incident review sheet with **estimated replay timestamps**, apply a
penalty rubric, and generate the ruling post for Discord. Built for the
Operation Motorsport eMotorsport League but league-agnostic.

Two components, two owners:

- `python/` + root `README.md` + `.gitignore` — the credentialed fetcher.
  **Owner: agent A.**
- `docs/` — static review UI for GitHub Pages. **Owner: agent B.** B must not
  touch files outside `docs/`.

Privacy split (the whole reason for the architecture): iRacing credentials and
API calls live only in the local Python tool; the web UI only ever sees the
exported case file and stores everything in localStorage. Nothing uploads.

## Shared schema: `steward-kit/case@1` (stewardcase.json)

Produced by the fetcher; consumed by the web UI. Fields marked OPT may be
absent/null — the UI must degrade gracefully without them.

```json
{
  "format": "steward-kit/case@1",
  "fetched_at": "ISO-8601",
  "session": {
    "subsession_id": 12345678,
    "session_name": "string", "league_name": "string|null",
    "track": "string", "config": "string|null",
    "start_time": "ISO-8601",
    "simulated_start": "string|null",
    "session_types": ["PRACTICE", "QUALIFY", "RACE"]
  },
  "drivers": [
    {
      "car_idx": 3, "cust_id": 123456, "name": "string",
      "car": "string", "car_number": "33", "car_class": "string|null",
      "finish_pos": 1, "laps_complete": 45, "incidents": 7,
      "laps": [
        {
          "lap": 1, "time_s": 92.412,
          "position": 4,
          "flags": ["pitted", "off_track", "black_flag", "contact", "car_contact", "lost_control", "invalid", "discontinuity"],
          "session_time_s": 812.4
        }
      ]
    }
  ],
  "events": [
    { "type": "string", "session_time_s": 812.4, "lap": 12,
      "car_idx": [3, 7], "description": "string", "source": "api|derived" }
  ]
}
```

Notes:
- `laps[].flags` come from the /data lap_data lap-event flags — agent A maps
  whatever the API actually returns into these strings and documents the
  mapping. Unknown flags pass through verbatim.
- `laps[].session_time_s` is the estimated session time at the START of that
  lap: cumulative sum of the driver's prior lap times anchored to the race
  session start. This is the replay-jump number. Where lap times are missing
  (towed laps), interpolate from neighbors and add the `discontinuity` flag.
- `events` is OPT: populated from lap flags at minimum (`source: "derived"` —
  one event per flagged lap, grouping same-lap `car_contact` across drivers
  into one event when session_time estimates are within 30 s).

## Rubric: `steward-kit/rubric@1` (lives in the UI, localStorage + import/export)

```json
{
  "format": "steward-kit/rubric@1",
  "league": "string",
  "penalties": [
    {"code": "AC1", "label": "Avoidable contact, minor", "action": "Warning"},
    {"code": "AC2", "label": "Avoidable contact, position lost", "action": "Drive-through (next race) / 30s post-race"},
    {"code": "TR1", "label": "Track limits abuse", "action": "Lap deletion / warning"}
  ]
}
```

Default rubric ships with sensible endurance-league defaults, clearly editable.

## Ruling output

Plain-text/markdown block per decision, Discord-paste ready:
session, involved cars/drivers, lap + estimated replay time (mm:ss into the
race session), steward finding (free text), rubric code + action, protest
reference (free text, OPT). Deterministic template — no AI.

## API reality check (agent A, FIRST TASK)

Research the community-documented iRacing /data API (docs endpoint
https://members-ng.iracing.com/data/doc, forum threads, existing open-source
clients e.g. pyracing/iracing-data-api) and determine what results/lap_data
actually returns for hosted + league sessions, especially lap event flags and
whether any timestamped incident stream exists. Write findings to
python/API_NOTES.md with confidence labels. Build against the documented
shapes; anything unverifiable without a live login gets a [UNTESTED] label and
a graceful fallback. Authentication: email + password prompted at runtime
(getpass) or ~/.steward-kit-auth.json (documented, gitignored pattern),
iRacing's legacy auth flow (POST /auth with SHA256(password+lowercase(email))
base64 — verify against current client implementations).

## Fixtures

Agent A commits python/tests/fixtures/sample_case.json — a synthetic but
shape-faithful stewardcase (2 classes, 6 drivers, 20 laps, contact events,
a tow with discontinuity) built by python/make_sample.py, plus pytest coverage
of session_time_s accumulation, interpolation, and event derivation. Agent B's
Node tests consume that fixture when present (generate an equivalent
provisional one meanwhile) and must render/derive identically where logic is
shared (timestamp math to 1e-6).

## Non-goals v1

- No protest web-form intake (protests are pasted as free text into a case).
- No automatic guilt assignment — the tool organizes evidence; stewards decide.
- No replay file parsing (.rpy is undocumented; timestamps get you there).
