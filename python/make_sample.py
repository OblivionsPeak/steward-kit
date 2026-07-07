#!/usr/bin/env python3
"""make_sample.py — build the synthetic test fixture (SPEC: Fixtures).

Generates fake-but-shape-faithful raw API payloads (matching API_NOTES.md),
runs them through the real transform in fetch_case.py, and writes
tests/fixtures/sample_case.json.

2 classes, 6 drivers, 20 laps, two car-contact clusters on lap 5 (one per
class, far enough apart in session time to stay separate events), a tow on
laps 8-9 with interpolated times, one unknown lap_events string, and one
event_log item.

Deterministic: fixed lap times, fixed fetched_at.

Usage: python make_sample.py
"""

import json
import os

import fetch_case

FETCHED_AT = "2026-01-01T00:00:00+00:00"
SUBSESSION_ID = 99999999

# cust_id, name, car_number, class, car, base lap seconds
DRIVERS = [
    (1001, "Alex Vance",   "11", "GT3", "Ferrari 296 GT3",   92.0),
    (1002, "Riley Chen",   "22", "GT3", "BMW M4 GT3",        92.4),
    (1003, "Sam Ortiz",    "44", "GT3", "Porsche 992 GT3 R", 93.0),
    (2001, "Jordan Blake", "71", "GT4", "Aston Martin GT4",  101.0),
    (2002, "Casey Munn",   "72", "GT4", "McLaren 570S GT4",  101.5),
    (2003, "Devon Reyes",  "88", "GT4", "Porsche 718 GT4",   102.0),
]

N_LAPS = 20

# per-driver lap overrides: cust_id -> {lap_number: (lap_time_s or None, [lap_events])}
OVERRIDES = {
    1001: {5: (92.0, ["car contact"]),
           10: (92.0, ["some new thing"])},      # unknown flag: verbatim passthrough
    1002: {5: (92.4, ["car contact"])},
    1003: {8: (None, ["off track", "tow"]),      # towed: no lap time
           9: (None, ["tow"]),
           10: (96.0, [])},
    2001: {5: (101.0, ["car contact"]),
           12: (101.0, ["lost control"])},
    2002: {5: (101.5, ["car contact"])},
    2003: {3: (102.0, ["pitted"]),
           15: (102.0, ["black flag"])},
}


def build_raw_payloads():
    """Return (result_payload, lap_chart_rows, event_log_items) in the raw
    shapes documented in API_NOTES.md."""
    results = []
    for pos, (cust_id, name, num, cls, car, _base) in enumerate(DRIVERS):
        in_class = pos if cls == "GT3" else pos - 3
        results.append({
            "cust_id": cust_id,
            "display_name": name,
            "finish_position": pos,
            "finish_position_in_class": in_class,
            "laps_complete": N_LAPS,
            "incidents": 4 if cust_id in (1001, 1002, 2001, 2002) else 1,
            "car_id": 100 + pos,
            "car_name": car,
            "car_class_id": 1 if cls == "GT3" else 2,
            "car_class_name": cls + " Class",
            "car_class_short_name": cls,
            "livery": {"car_number": num},
        })

    result_payload = {
        "subsession_id": SUBSESSION_ID,
        "session_name": "OpMo Enduro Test at Watkins Glen",
        "league_name": "Operation Motorsport eMotorsport League",
        "start_time": "2026-01-01T19:00:00Z",
        "track": {"track_id": 106, "track_name": "Watkins Glen International",
                  "config_name": "Boot"},
        "weather": {"simulated_start_time": "2026-01-01T14:00:00"},
        "session_results": [
            {"simsession_number": -2, "simsession_type_name": "Open Practice",
             "results": []},
            {"simsession_number": -1, "simsession_type_name": "Lone Qualifying",
             "results": []},
            {"simsession_number": 0, "simsession_type_name": "Race",
             "results": results},
        ],
    }

    lap_chart_rows = []
    for pos, (cust_id, name, _num, _cls, _car, base) in enumerate(DRIVERS):
        for lap_no in range(1, N_LAPS + 1):
            time_s, events = OVERRIDES.get(cust_id, {}).get(lap_no, (base, []))
            lap_chart_rows.append({
                "group_id": cust_id,
                "cust_id": cust_id,
                "display_name": name,
                "lap_number": lap_no,
                "lap_time": -1 if time_s is None else int(round(time_s * 10000)),
                "lap_events": list(events),
                "incident": bool(events),
                "flags": 0,
                "session_start_time": None,
                "session_time": 0,
                "lap_position": pos + 1,
                "interval": 0,
                "interval_units": "ms",
                "fastest_lap": False,
                "personal_best_lap": False,
                "ai": False,
            })

    event_log_items = [
        {"subsession_id": SUBSESSION_ID, "simsession_number": 0,
         "session_time": 3680000, "event_seq": 1, "event_code": 4,
         "group_id": 1001, "cust_id": 1001, "lap_number": 5,
         "description": "Car contact",
         "message": "Alex Vance and Riley Chen made contact",
         "display_name": "Alex Vance"},
    ]

    return result_payload, lap_chart_rows, event_log_items


def build_sample_case():
    result_payload, lap_chart_rows, event_log_items = build_raw_payloads()
    return fetch_case.build_case(result_payload, lap_chart_rows,
                                 event_log_items, fetched_at=FETCHED_AT)


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "tests", "fixtures", "sample_case.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    case = build_sample_case()
    with open(out, "w", encoding="utf-8") as f:
        json.dump(case, f, indent=2)
        f.write("\n")
    print("wrote %s (%d drivers, %d events)"
          % (out, len(case["drivers"]), len(case["events"])))


if __name__ == "__main__":
    main()
