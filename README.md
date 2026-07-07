# Steward Kit

League incident review for iRacing without the hour of replay scrubbing:
fetch a subsession's results, get every flagged lap with an **estimated
replay timestamp**, review it in a local web UI, and paste the ruling into
Discord. Built for the Operation Motorsport eMotorsport League, but
league-agnostic.

**This is an evidence organizer, not a judge.** It collects lap flags,
contact events and timestamps so stewards can jump straight to the right
moment in the replay. It assigns no fault and issues no penalties — stewards
decide.

## How it works

Two parts, deliberately separated:

1. **`python/fetch_case.py`** (runs on your machine) — logs into the iRacing
   /data API with *your* credentials, pulls results + lap data + event log
   for a subsession, and writes a single `case.json` file.
2. **The web UI** at <https://oblivionspeak.github.io/steward-kit/> — a
   static page. You drop the `case.json` in; everything stays in your
   browser's localStorage. **Nothing is uploaded anywhere.** Your iRacing
   credentials never leave the Python tool.

## Quickstart

```bash
pip install requests
python python/fetch_case.py 12345678 -o case.json
```

You'll be prompted for your iRacing email and password. The subsession id is
in the results-page URL on the iRacing membersite (`subsessionid=...`).

Then open <https://oblivionspeak.github.io/steward-kit/> and load `case.json`.

Useful flags:

- `--save-auth` — store credentials in `~/.steward-kit-auth.json` so you are
  not prompted every time (see safety note below).
- `--raw-dir raw/` — also dump the raw API responses (for debugging).
- `--simsession N` — pick a specific sim-session instead of auto-picking the
  race.

## Credential safety

- Your password is **never stored and never logged**. iRacing's login takes
  `base64(sha256(password + lowercased email))`; that hash is all the tool
  ever holds.
- `--save-auth` writes only that login hash to `~/.steward-kit-auth.json`.
  Note: the hash is still a working login secret for the iRacing API — the
  file is created user-only-readable and is gitignored, but treat it like a
  password and delete it if in doubt.
- The web UI never sees credentials at all; it only reads the exported case
  file.

## Honesty section: [UNTESTED] against the live API

The iRacing /data API is not publicly documented. This tool was built from
community documentation and the source code of maintained open-source
clients — **it has not yet been run against a live iRacing account.** Every
claim about the API is confidence-labeled in
[`python/API_NOTES.md`](python/API_NOTES.md).

If you have an iRacing account and a league session to test with, you would
be the first — please run:

```bash
python python/fetch_case.py <subsession_id> -o case.json --raw-dir raw/
```

and report what happens (the raw dumps contain session data but no
credentials). Likely first-run issues and their meaning are listed in
API_NOTES.md section 6. The timestamp math, lap-flag mapping, interpolation
and event grouping are covered by an offline test suite
(`python -m pytest python/tests/`) against a synthetic fixture.

## Replay timestamps are estimates

`session_time_s` for each lap is the cumulative sum of the driver's prior
lap times anchored to the race session start. Laps with no lap time (tows,
disconnects) are interpolated from neighboring laps and flagged
`discontinuity` — treat timestamps at and after a discontinuity as
approximate and scrub a little.

## Repo layout

- `python/fetch_case.py` — the fetcher CLI (stdlib + `requests` only)
- `python/API_NOTES.md` — API research notes with confidence labels
- `python/make_sample.py`, `python/tests/` — synthetic fixture + pytest suite
- `docs/` — the static review UI (GitHub Pages)
- `SPEC.md` — the build contract, including the `steward-kit/case@1` schema
