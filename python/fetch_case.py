#!/usr/bin/env python3
"""fetch_case.py — pull an iRacing subsession into a steward-kit/case@1 file.

Usage:
    python fetch_case.py <subsession_id> -o case.json

Credentials: prompted at runtime (getpass) or read from
~/.steward-kit-auth.json (see --save-auth). The password itself is never
written to disk or logs — only iRacing's login hash
base64(sha256(password + lower(email))).

Everything about the live API is [UNTESTED] — see python/API_NOTES.md.
Use --raw-dir to dump raw API responses when reporting problems.

stdlib + requests only. Single-entry file (PyInstaller-friendly).
"""

import argparse
import base64
import getpass
import hashlib
import json
import os
import stat
import sys
import time
from datetime import datetime, timezone

try:
    import requests
except ImportError:  # transform/tests work without requests installed
    requests = None

BASE_URL = "https://members-ng.iracing.com"
AUTH_URL = BASE_URL + "/auth"
DEFAULT_AUTH_FILE = os.path.join(os.path.expanduser("~"), ".steward-kit-auth.json")

# lap_time and (assumed) event_log session_time are in 1/10000 s.
# See API_NOTES.md section 3/6 — flip to 1000.0 if the first live test
# shows event-log times landing ~10x off from lap-derived times.
LAP_TIME_DIVISOR = 10000.0
EVENT_LOG_TIME_DIVISOR = 10000.0

# Group same-lap car_contact events across drivers into one event when the
# session-time estimates are within this many seconds (SPEC rule).
CONTACT_GROUP_WINDOW_S = 30.0

# API lap_events string (lowercased) -> case@1 flag. Unknown strings pass
# through verbatim. See API_NOTES.md section 4.
LAP_EVENT_MAP = {
    "pitted": "pitted",
    "off track": "off_track",
    "offtrack": "off_track",
    "black flag": "black_flag",
    "contact": "contact",
    "car contact": "car_contact",
    "lost control": "lost_control",
    "invalid": "invalid",
    "discontinuity": "discontinuity",
    "tow": "tow",
    "towed": "tow",
    "reset": "reset",
    "interpolated crossing": "interpolated_crossing",
    "clock smash": "clock_smash",
}

# flags that generate derived events, in reporting priority order
EVENT_FLAGS = ["car_contact", "contact", "lost_control", "off_track", "black_flag"]


# ---------------------------------------------------------------------------
# Transform layer (pure functions — no network; exercised by the test suite)
# ---------------------------------------------------------------------------

def normalize_lap_events(lap_events):
    """Map raw API lap_events strings into case@1 flags.

    Known strings (case-insensitive, surrounding whitespace ignored) are
    normalized; unknown strings pass through verbatim per SPEC. Order is
    preserved, duplicates dropped.
    """
    out = []
    for ev in lap_events or []:
        if not isinstance(ev, str):
            continue
        flag = LAP_EVENT_MAP.get(ev.strip().lower(), ev)
        if flag not in out:
            out.append(flag)
    return out


def fill_missing_lap_times(laps):
    """Interpolate missing lap times (time_s is None) from neighbors.

    laps: list of dicts with at least "time_s" and "flags", ordered by lap
    number. Mutates and returns the list. Each filled lap gets time_s set by
    linear interpolation between the nearest valid neighbors and gains the
    "discontinuity" flag:

        gap of g laps between prev value p and next value n:
        position m (1-based) gets  p + (n - p) * m / (g + 1)

    Edge gaps (no prev / no next) take the nearest valid value; if the
    driver has no valid laps at all, 0.0.
    """
    n_laps = len(laps)
    i = 0
    while i < n_laps:
        if laps[i]["time_s"] is not None:
            i += 1
            continue
        j = i
        while j < n_laps and laps[j]["time_s"] is None:
            j += 1
        prev_t = laps[i - 1]["time_s"] if i > 0 else None
        next_t = laps[j]["time_s"] if j < n_laps else None
        gap = j - i
        for m in range(1, gap + 1):
            k = i + m - 1
            if prev_t is not None and next_t is not None:
                t = prev_t + (next_t - prev_t) * m / (gap + 1)
            elif prev_t is not None:
                t = prev_t
            elif next_t is not None:
                t = next_t
            else:
                t = 0.0
            laps[k]["time_s"] = t
            if "discontinuity" not in laps[k]["flags"]:
                laps[k]["flags"].append("discontinuity")
        i = j
    return laps


def accumulate_session_times(laps, anchor_s=0.0):
    """Set session_time_s = estimated session time at the START of each lap.

    Cumulative sum of the driver's prior lap times, anchored to the race
    session start (anchor_s). Missing times must be filled first
    (fill_missing_lap_times). Mutates and returns the list.
    """
    st = float(anchor_s)
    for lap in laps:
        lap["session_time_s"] = round(st, 6)
        st += lap["time_s"] if lap["time_s"] is not None else 0.0
    return laps


def build_driver_laps(raw_laps, anchor_s=0.0):
    """Raw lap-chart rows for one driver -> case@1 laps list.

    raw_laps: dicts with lap_number, lap_time (1/10000 s int, -1 = missing),
    lap_events (list of strings), optional lap_position.
    """
    laps = []
    for rl in sorted(raw_laps, key=lambda r: r.get("lap_number", 0)):
        lt = rl.get("lap_time", -1)
        time_s = None if lt is None or lt < 0 else round(lt / LAP_TIME_DIVISOR, 6)
        lap = {
            "lap": rl.get("lap_number", 0),
            "time_s": time_s,
            "flags": normalize_lap_events(rl.get("lap_events")),
        }
        if rl.get("lap_position") is not None:
            lap["position"] = rl["lap_position"]
        laps.append(lap)
    fill_missing_lap_times(laps)
    accumulate_session_times(laps, anchor_s)
    return laps


def derive_events(drivers):
    """Derive events from lap flags (SPEC: one event per flagged lap;
    same-lap car_contact across drivers grouped into one event when the
    session_time estimates are within CONTACT_GROUP_WINDOW_S of the
    group's earliest member)."""
    events = []
    contact_candidates = []  # (lap, session_time_s, car_idx, name)

    for d in drivers:
        for lap in d["laps"]:
            flags = lap.get("flags", [])
            for flag in EVENT_FLAGS:
                if flag not in flags:
                    continue
                if flag == "car_contact":
                    contact_candidates.append(
                        (lap["lap"], lap["session_time_s"], d["car_idx"], _label(d))
                    )
                else:
                    events.append({
                        "type": flag,
                        "session_time_s": lap["session_time_s"],
                        "lap": lap["lap"],
                        "car_idx": [d["car_idx"]],
                        "description": "%s: %s (lap %d)"
                        % (flag.replace("_", " ").capitalize(), _label(d), lap["lap"]),
                        "source": "derived",
                    })

    # group car_contact: same lap number, session times within window of the
    # earliest member of the group
    by_lap = {}
    for cand in contact_candidates:
        by_lap.setdefault(cand[0], []).append(cand)
    for lap_no in sorted(by_lap):
        cands = sorted(by_lap[lap_no], key=lambda c: c[1])
        group = []
        for cand in cands:
            if group and cand[1] - group[0][1] > CONTACT_GROUP_WINDOW_S:
                events.append(_contact_event(lap_no, group))
                group = []
            group.append(cand)
        if group:
            events.append(_contact_event(lap_no, group))

    events.sort(key=lambda e: (e["session_time_s"], e["lap"]))
    return events


def _label(driver):
    num = driver.get("car_number")
    name = driver.get("name", "?")
    return "#%s %s" % (num, name) if num else name


def _contact_event(lap_no, group):
    return {
        "type": "car_contact",
        "session_time_s": group[0][1],
        "lap": lap_no,
        "car_idx": [c[2] for c in group],
        "description": "Car contact (lap %d): %s" % (lap_no, ", ".join(c[3] for c in group)),
        "source": "derived",
    }


def convert_event_log(items, cust_to_idx):
    """results/event_log items -> case@1 events (source: "api").

    session_time unit assumed 1/10000 s — see API_NOTES.md. event_code is
    undocumented; the human text lives in description/message.
    """
    events = []
    for it in items or []:
        st = it.get("session_time")
        if st is None:
            continue
        desc = it.get("message") or it.get("description") or ""
        code = it.get("event_code")
        idxs = []
        cid = it.get("cust_id")
        if cid in cust_to_idx:
            idxs = [cust_to_idx[cid]]
        events.append({
            "type": "event_log" if code is None else "event_log_%s" % code,
            "session_time_s": round(st / EVENT_LOG_TIME_DIVISOR, 6),
            "lap": it.get("lap_number", 0),
            "car_idx": idxs,
            "description": desc,
            "source": "api",
        })
    events.sort(key=lambda e: (e["session_time_s"], e["lap"]))
    return events


SESSION_TYPE_MAP = [
    ("race", "RACE"),
    ("qual", "QUALIFY"),
    ("practice", "PRACTICE"),
    ("warmup", "PRACTICE"),
]


def classify_simsession(type_name):
    low = (type_name or "").lower()
    for needle, label in SESSION_TYPE_MAP:
        if needle in low:
            return label
    return (type_name or "UNKNOWN").upper()


def pick_race_simsession(session_results):
    """Choose the race sim-session (else the highest simsession_number)."""
    if not session_results:
        return None
    races = [s for s in session_results
             if classify_simsession(s.get("simsession_type_name")
                                    or s.get("simsession_name")) == "RACE"]
    pool = races or session_results
    return max(pool, key=lambda s: s.get("simsession_number", 0))


def flatten_result_rows(results):
    """Flatten team rows (driver_results nested) into per-driver rows,
    inheriting team-level fields (car number, class, finish position)."""
    rows = []
    for r in results or []:
        drs = r.get("driver_results")
        if drs:
            for dr in drs:
                merged = dict(r)
                merged.pop("driver_results", None)
                merged.update({k: v for k, v in dr.items() if v is not None})
                rows.append(merged)
        else:
            rows.append(r)
    return rows


def build_case(result_payload, lap_chart_rows, event_log_items=None, fetched_at=None):
    """Assemble a steward-kit/case@1 dict from raw API payloads.

    result_payload: results/get body.
    lap_chart_rows: flattened results/lap_chart_data rows (all drivers).
    event_log_items: optional results/event_log rows.

    Note: the /data API has no CarIdx (that is a telemetry concept); we
    assign car_idx as a stable index over the race classification order.
    cust_id is the real cross-reference key.
    """
    rp = result_payload or {}
    race = pick_race_simsession(rp.get("session_results") or [])
    race_rows = flatten_result_rows((race or {}).get("results"))

    weather = rp.get("weather") or {}
    simulated_start = (
        rp.get("simulated_start_time")
        or weather.get("simulated_start_time")
        or weather.get("simulated_start_utc_time")
        or weather.get("simulated_start_utc_offset")
    )

    track = rp.get("track") or {}
    session = {
        "subsession_id": rp.get("subsession_id"),
        "session_name": rp.get("session_name") or rp.get("series_name") or "",
        "league_name": rp.get("league_name"),
        "track": track.get("track_name") or "",
        "config": track.get("config_name") or None,
        "start_time": rp.get("start_time") or "",
        "simulated_start": simulated_start if isinstance(simulated_start, str) else None,
        "session_types": sorted(
            {classify_simsession(s.get("simsession_type_name") or s.get("simsession_name"))
             for s in rp.get("session_results") or []}
        ),
    }

    # laps grouped per driver (cust_id); fall back to group_id for team rows
    laps_by_cust = {}
    for row in lap_chart_rows or []:
        key = row.get("cust_id")
        if key is None:
            key = row.get("group_id")
        laps_by_cust.setdefault(key, []).append(row)

    drivers = []
    cust_to_idx = {}
    for idx, row in enumerate(race_rows):
        cust_id = row.get("cust_id")
        livery = row.get("livery") or {}
        raw_laps = laps_by_cust.get(cust_id) or laps_by_cust.get(row.get("team_id")) or []
        driver = {
            "car_idx": idx,
            "cust_id": cust_id,
            "name": row.get("display_name") or "",
            "car": row.get("car_name") or "",
            "car_number": str(livery.get("car_number", "")) or None,
            "car_class": row.get("car_class_short_name") or row.get("car_class_name"),
            "finish_pos": row.get("finish_position"),
            "laps_complete": row.get("laps_complete"),
            "incidents": row.get("incidents"),
            "laps": build_driver_laps(raw_laps),
        }
        drivers.append(driver)
        if cust_id is not None:
            cust_to_idx[cust_id] = idx

    events = derive_events(drivers)
    if event_log_items:
        events.extend(convert_event_log(event_log_items, cust_to_idx))
        events.sort(key=lambda e: (e["session_time_s"], e["lap"]))

    return {
        "format": "steward-kit/case@1",
        "fetched_at": fetched_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "session": session,
        "drivers": drivers,
        "events": events,
    }


# ---------------------------------------------------------------------------
# API client (network layer) — everything here is [UNTESTED] vs live iRacing
# ---------------------------------------------------------------------------

def encode_password(email, password):
    digest = hashlib.sha256((password + email.strip().lower()).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("utf-8")


class FetchError(RuntimeError):
    pass


class IRacingClient:
    def __init__(self, email, password_hash, verbose=True):
        if requests is None:
            raise FetchError("the 'requests' package is required: pip install requests")
        self.email = email.strip()
        self.password_hash = password_hash
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "steward-kit/1.0"
        self.verbose = verbose

    def log(self, msg):
        if self.verbose:
            print("  " + msg)

    def login(self):
        self.log("logging in as %s ..." % self.email)
        r = self.session.post(
            AUTH_URL,
            json={"email": self.email, "password": self.password_hash},
            timeout=15,
        )
        if r.status_code == 429:
            self._wait_rate_limit(r)
            return self.login()
        try:
            body = r.json()
        except ValueError:
            raise FetchError("auth: non-JSON response (HTTP %d): %r"
                             % (r.status_code, r.text[:200]))
        if body.get("verificationRequired"):
            raise FetchError(
                "iRacing requires interactive verification (captcha).\n"
                "  Log in once at https://members.iracing.com in a browser, "
                "then re-run this tool."
            )
        if r.status_code == 200 and body.get("authcode"):
            self.log("login ok")
            return
        raise FetchError("auth failed (HTTP %d): %s"
                         % (r.status_code, body.get("message") or json.dumps(body)[:300]))

    def _wait_rate_limit(self, r):
        reset = r.headers.get("x-ratelimit-reset")
        wait = 5.0
        if reset:
            try:
                wait = max(1.0, min(120.0, float(reset) - time.time()))
            except ValueError:
                pass
        self.log("rate limited; waiting %.0fs ..." % wait)
        time.sleep(wait)

    def get_data(self, endpoint, params=None):
        """GET a /data endpoint, follow the S3 link, resolve chunk_info."""
        url = BASE_URL + endpoint
        for attempt in range(4):
            r = self.session.get(url, params=params, timeout=30)
            if r.status_code == 429:
                self._wait_rate_limit(r)
                continue
            if r.status_code == 401:
                raise FetchError("%s: HTTP 401 — session expired or not "
                                 "authorized for this subsession" % endpoint)
            if r.status_code != 200:
                raise FetchError("%s: HTTP %d: %r" % (endpoint, r.status_code, r.text[:300]))
            body = r.json()
            break
        else:
            raise FetchError("%s: still rate-limited after retries" % endpoint)

        if isinstance(body, dict) and "link" in body:
            # pre-signed URL: fetch with a bare request (no iRacing cookies)
            lr = requests.get(body["link"], timeout=60)
            if lr.status_code != 200:
                raise FetchError("%s: link fetch HTTP %d" % (endpoint, lr.status_code))
            body = lr.json()
        return self._resolve_chunks(body)

    def _resolve_chunks(self, body):
        chunk_info = None
        if isinstance(body, dict):
            chunk_info = body.get("chunk_info")
            if chunk_info is None:
                # some payloads nest it (e.g. under "data")
                for v in body.values():
                    if isinstance(v, dict) and "chunk_info" in v:
                        chunk_info = v["chunk_info"]
                        break
        if not isinstance(chunk_info, dict) or not chunk_info.get("chunk_file_names"):
            return body
        base = chunk_info.get("base_download_url") or ""
        rows = []
        for name in chunk_info["chunk_file_names"]:
            cr = requests.get(base + name, timeout=60)
            if cr.status_code != 200:
                raise FetchError("chunk fetch HTTP %d: %s" % (cr.status_code, name))
            part = cr.json()
            rows.extend(part if isinstance(part, list) else [part])
        return rows


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def load_auth(auth_file):
    """Return (email, password_hash) or None. The file stores only the
    login hash, never the plaintext password."""
    if not os.path.isfile(auth_file):
        return None
    try:
        with open(auth_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print("warning: could not read %s (%s); ignoring" % (auth_file, e))
        return None
    email = data.get("email")
    pw_hash = data.get("password_hash")
    if email and pw_hash:
        return email, pw_hash
    if email and data.get("password"):
        print("warning: %s contains a plaintext password. Re-create it with "
              "--save-auth to store only the login hash." % auth_file)
        return email, encode_password(email, data["password"])
    return None


def prompt_auth():
    email = input("iRacing email: ").strip()
    password = getpass.getpass("iRacing password (not stored): ")
    return email, encode_password(email, password)


def save_auth(auth_file):
    email, pw_hash = prompt_auth()
    with open(auth_file, "w", encoding="utf-8") as f:
        json.dump({"email": email, "password_hash": pw_hash}, f, indent=2)
    try:
        os.chmod(auth_file, stat.S_IRUSR | stat.S_IWUSR)  # 0600 (no-op on Windows ACLs)
    except OSError:
        pass
    print("saved login hash (not the password) to %s" % auth_file)
    print("note: the hash still grants API access — keep the file private.")
    return email, pw_hash


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def dump_raw(raw_dir, name, payload):
    os.makedirs(raw_dir, exist_ok=True)
    path = os.path.join(raw_dir, name + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print("  raw dump: %s" % path)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Fetch an iRacing subsession into a steward-kit/case@1 JSON file.")
    ap.add_argument("subsession_id", nargs="?", type=int,
                    help="subsession id (from the results page URL)")
    ap.add_argument("-o", "--output", default=None,
                    help="output file (default: case_<subsession_id>.json)")
    ap.add_argument("--auth-file", default=DEFAULT_AUTH_FILE,
                    help="credentials file (default: %s)" % DEFAULT_AUTH_FILE)
    ap.add_argument("--save-auth", action="store_true",
                    help="prompt for credentials, store the login hash, and exit")
    ap.add_argument("--simsession", type=int, default=None,
                    help="simsession_number override (default: auto-pick the race)")
    ap.add_argument("--no-event-log", action="store_true",
                    help="skip results/event_log")
    ap.add_argument("--raw-dir", default=None,
                    help="also dump raw API responses into this directory (debugging)")
    args = ap.parse_args(argv)

    if args.save_auth:
        save_auth(args.auth_file)
        return 0
    if args.subsession_id is None:
        ap.error("subsession_id is required (or use --save-auth)")

    auth = load_auth(args.auth_file)
    if auth:
        print("using credentials from %s" % args.auth_file)
    else:
        auth = prompt_auth()
    email, pw_hash = auth

    client = IRacingClient(email, pw_hash)
    try:
        client.login()

        print("fetching results/get for subsession %d ..." % args.subsession_id)
        result = client.get_data("/data/results/get",
                                 {"subsession_id": args.subsession_id,
                                  "include_licenses": "false"})
        if args.raw_dir:
            dump_raw(args.raw_dir, "results_get", result)

        race = pick_race_simsession(result.get("session_results") or [])
        simsession = args.simsession if args.simsession is not None \
            else (race or {}).get("simsession_number", 0)
        print("using simsession_number %s" % simsession)

        print("fetching results/lap_chart_data ...")
        lap_chart = client.get_data("/data/results/lap_chart_data",
                                    {"subsession_id": args.subsession_id,
                                     "simsession_number": simsession})
        if not isinstance(lap_chart, list):
            print("warning: unexpected lap_chart_data shape (%s) — see "
                  "API_NOTES.md; re-run with --raw-dir and report this."
                  % type(lap_chart).__name__)
            lap_chart = lap_chart if isinstance(lap_chart, list) else []
        if args.raw_dir:
            dump_raw(args.raw_dir, "lap_chart_data", lap_chart)

        event_log = None
        if not args.no_event_log:
            print("fetching results/event_log ...")
            try:
                event_log = client.get_data("/data/results/event_log",
                                            {"subsession_id": args.subsession_id,
                                             "simsession_number": simsession})
                if not isinstance(event_log, list):
                    event_log = None
                if args.raw_dir and event_log is not None:
                    dump_raw(args.raw_dir, "event_log", event_log)
            except FetchError as e:
                print("warning: event_log unavailable (%s) — continuing without it" % e)

        case = build_case(result, lap_chart, event_log)
    except FetchError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1

    out = args.output or ("case_%d.json" % args.subsession_id)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(case, f, indent=2)

    n_laps = sum(len(d["laps"]) for d in case["drivers"])
    print("wrote %s: %d drivers, %d laps, %d events" %
          (out, len(case["drivers"]), n_laps, len(case["events"])))
    print("next: open https://oblivionspeak.github.io/steward-kit/ and load the file")
    if not n_laps:
        print("note: 0 laps came back — the lap_chart_data shape may differ "
              "from API_NOTES.md. Re-run with --raw-dir raw/ and open an issue "
              "with the dumps (they contain no credentials).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
