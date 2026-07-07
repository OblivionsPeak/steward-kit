"""Tests for the steward-kit transform layer (no network required)."""

import json
import os

import pytest

import fetch_case
import make_sample

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "sample_case.json")

TOL = 1e-6


# ---------------------------------------------------------------------------
# flag mapping
# ---------------------------------------------------------------------------

def test_known_flags_normalized():
    raw = ["Car Contact", "off track", "LOST CONTROL", "pitted",
           "black flag", "invalid", "discontinuity", "contact", "towed"]
    assert fetch_case.normalize_lap_events(raw) == [
        "car_contact", "off_track", "lost_control", "pitted",
        "black_flag", "invalid", "discontinuity", "contact", "tow"]


def test_unknown_flags_pass_through_verbatim():
    assert fetch_case.normalize_lap_events(["some new thing"]) == ["some new thing"]


def test_flag_dedup_and_junk_tolerance():
    assert fetch_case.normalize_lap_events(
        ["car contact", "Car Contact", None, 42]) == ["car_contact"]
    assert fetch_case.normalize_lap_events(None) == []


# ---------------------------------------------------------------------------
# session_time_s accumulation (exact values)
# ---------------------------------------------------------------------------

def _laps(times):
    return [{"lap": i + 1, "time_s": t, "flags": []} for i, t in enumerate(times)]


def test_accumulation_exact():
    laps = fetch_case.accumulate_session_times(_laps([92.0, 92.5, 91.75]),
                                               anchor_s=0.0)
    assert laps[0]["session_time_s"] == pytest.approx(0.0, abs=TOL)
    assert laps[1]["session_time_s"] == pytest.approx(92.0, abs=TOL)
    assert laps[2]["session_time_s"] == pytest.approx(184.5, abs=TOL)


def test_accumulation_with_anchor():
    laps = fetch_case.accumulate_session_times(_laps([100.0, 100.0]),
                                               anchor_s=120.5)
    assert laps[0]["session_time_s"] == pytest.approx(120.5, abs=TOL)
    assert laps[1]["session_time_s"] == pytest.approx(220.5, abs=TOL)


# ---------------------------------------------------------------------------
# interpolation of missing lap times (tow)
# ---------------------------------------------------------------------------

def test_interpolation_mid_gap():
    laps = fetch_case.fill_missing_lap_times(_laps([93.0, None, None, 96.0]))
    # gap of 2 between 93 and 96: 93 + 3*(1/3) = 94, 93 + 3*(2/3) = 95
    assert laps[1]["time_s"] == pytest.approx(94.0, abs=TOL)
    assert laps[2]["time_s"] == pytest.approx(95.0, abs=TOL)
    assert "discontinuity" in laps[1]["flags"]
    assert "discontinuity" in laps[2]["flags"]
    assert "discontinuity" not in laps[0]["flags"]
    assert "discontinuity" not in laps[3]["flags"]


def test_interpolation_leading_and_trailing_gaps():
    laps = fetch_case.fill_missing_lap_times(_laps([None, 90.0, None]))
    assert laps[0]["time_s"] == pytest.approx(90.0, abs=TOL)  # nearest valid
    assert laps[2]["time_s"] == pytest.approx(90.0, abs=TOL)
    assert "discontinuity" in laps[0]["flags"]
    assert "discontinuity" in laps[2]["flags"]


def test_interpolation_no_valid_laps():
    laps = fetch_case.fill_missing_lap_times(_laps([None, None]))
    assert laps[0]["time_s"] == 0.0
    assert "discontinuity" in laps[1]["flags"]


def test_accumulation_through_interpolated_gap():
    laps = _laps([93.0] * 7 + [None, None, 96.0] + [93.0] * 10)
    fetch_case.fill_missing_lap_times(laps)
    fetch_case.accumulate_session_times(laps)
    assert laps[7]["session_time_s"] == pytest.approx(651.0, abs=TOL)   # lap 8
    assert laps[8]["session_time_s"] == pytest.approx(745.0, abs=TOL)   # lap 9
    assert laps[9]["session_time_s"] == pytest.approx(840.0, abs=TOL)   # lap 10
    assert laps[10]["session_time_s"] == pytest.approx(936.0, abs=TOL)  # lap 11


# ---------------------------------------------------------------------------
# event derivation and 30s car_contact grouping
# ---------------------------------------------------------------------------

def _driver(idx, num, laps):
    return {"car_idx": idx, "car_number": num, "name": "Driver %d" % idx,
            "laps": laps}


def _contact_lap(lap, st):
    return {"lap": lap, "time_s": 90.0, "flags": ["car_contact"],
            "session_time_s": st}


def test_same_lap_contacts_within_30s_grouped():
    drivers = [_driver(0, "11", [_contact_lap(5, 368.0)]),
               _driver(1, "22", [_contact_lap(5, 369.6)])]
    events = fetch_case.derive_events(drivers)
    assert len(events) == 1
    ev = events[0]
    assert ev["type"] == "car_contact"
    assert ev["lap"] == 5
    assert ev["car_idx"] == [0, 1]
    assert ev["session_time_s"] == pytest.approx(368.0, abs=TOL)
    assert ev["source"] == "derived"


def test_same_lap_contacts_beyond_30s_split():
    drivers = [_driver(0, "11", [_contact_lap(5, 368.0)]),
               _driver(1, "71", [_contact_lap(5, 404.0)])]  # 36s apart
    events = fetch_case.derive_events(drivers)
    assert len(events) == 2
    assert events[0]["car_idx"] == [0]
    assert events[1]["car_idx"] == [1]


def test_grouping_window_anchored_to_earliest_member():
    # 0, 20, 40: 20 joins group(min 0); 40 is 40s past the group min -> split
    drivers = [_driver(0, "1", [_contact_lap(3, 0.0)]),
               _driver(1, "2", [_contact_lap(3, 20.0)]),
               _driver(2, "3", [_contact_lap(3, 40.0)])]
    events = fetch_case.derive_events(drivers)
    assert len(events) == 2
    assert events[0]["car_idx"] == [0, 1]
    assert events[1]["car_idx"] == [2]


def test_different_lap_contacts_never_grouped():
    drivers = [_driver(0, "11", [_contact_lap(5, 368.0)]),
               _driver(1, "22", [_contact_lap(6, 369.0)])]
    events = fetch_case.derive_events(drivers)
    assert len(events) == 2


def test_non_contact_flags_one_event_each():
    laps = [{"lap": 8, "time_s": 90.0, "flags": ["off_track", "lost_control"],
             "session_time_s": 651.0}]
    events = fetch_case.derive_events([_driver(2, "44", laps)])
    types = sorted(e["type"] for e in events)
    assert types == ["lost_control", "off_track"]
    for ev in events:
        assert ev["car_idx"] == [2]
        assert ev["session_time_s"] == pytest.approx(651.0, abs=TOL)


def test_pitted_and_unknown_flags_do_not_create_events():
    laps = [{"lap": 3, "time_s": 90.0, "flags": ["pitted", "some new thing"],
             "session_time_s": 180.0}]
    assert fetch_case.derive_events([_driver(0, "88", laps)]) == []


def test_event_log_conversion():
    items = [{"session_time": 3680000, "event_code": 4, "cust_id": 1001,
              "lap_number": 5, "description": "Car contact",
              "message": "A and B made contact"}]
    events = fetch_case.convert_event_log(items, {1001: 0})
    assert len(events) == 1
    ev = events[0]
    assert ev["session_time_s"] == pytest.approx(368.0, abs=TOL)
    assert ev["source"] == "api"
    assert ev["car_idx"] == [0]
    assert ev["description"] == "A and B made contact"


# ---------------------------------------------------------------------------
# fixture: build determinism + exact spot checks
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def case():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


def test_fixture_matches_generator(case):
    assert make_sample.build_sample_case() == case


def test_fixture_shape(case):
    assert case["format"] == "steward-kit/case@1"
    assert len(case["drivers"]) == 6
    assert len({d["car_class"] for d in case["drivers"]}) == 2
    for d in case["drivers"]:
        assert len(d["laps"]) == 20


def _driver_by_number(case, num):
    return next(d for d in case["drivers"] if d["car_number"] == num)


def test_fixture_timestamps_exact(case):
    alex = _driver_by_number(case, "11")
    assert alex["laps"][0]["session_time_s"] == pytest.approx(0.0, abs=TOL)
    assert alex["laps"][4]["session_time_s"] == pytest.approx(368.0, abs=TOL)
    assert alex["laps"][19]["session_time_s"] == pytest.approx(1748.0, abs=TOL)


def test_fixture_tow_interpolation(case):
    sam = _driver_by_number(case, "44")
    lap8, lap9 = sam["laps"][7], sam["laps"][8]
    assert lap8["time_s"] == pytest.approx(94.0, abs=TOL)
    assert lap9["time_s"] == pytest.approx(95.0, abs=TOL)
    assert "discontinuity" in lap8["flags"]
    assert "discontinuity" in lap9["flags"]
    assert "tow" in lap8["flags"]
    assert lap8["session_time_s"] == pytest.approx(651.0, abs=TOL)
    assert lap9["session_time_s"] == pytest.approx(745.0, abs=TOL)
    assert sam["laps"][9]["session_time_s"] == pytest.approx(840.0, abs=TOL)


def test_fixture_unknown_flag_passthrough(case):
    alex = _driver_by_number(case, "11")
    assert "some new thing" in alex["laps"][9]["flags"]


def test_fixture_events(case):
    derived = [e for e in case["events"] if e["source"] == "derived"]
    api = [e for e in case["events"] if e["source"] == "api"]
    contacts = [e for e in derived if e["type"] == "car_contact"]

    # two same-lap contact clusters (per class), >30s apart -> two events
    assert len(contacts) == 2
    gt3, gt4 = sorted(contacts, key=lambda e: e["session_time_s"])
    assert gt3["session_time_s"] == pytest.approx(368.0, abs=TOL)
    assert gt3["car_idx"] == [0, 1]
    assert gt4["session_time_s"] == pytest.approx(404.0, abs=TOL)
    assert gt4["car_idx"] == [3, 4]

    types = sorted(e["type"] for e in derived)
    assert types == ["black_flag", "car_contact", "car_contact",
                     "lost_control", "off_track"]

    assert len(api) == 1
    assert api[0]["session_time_s"] == pytest.approx(368.0, abs=TOL)

    # events sorted by session_time_s
    times = [e["session_time_s"] for e in case["events"]]
    assert times == sorted(times)


# ---------------------------------------------------------------------------
# case@1 schema validation
# ---------------------------------------------------------------------------

def test_case_schema(case):
    assert set(case) == {"format", "fetched_at", "session", "drivers", "events"}
    assert isinstance(case["fetched_at"], str)

    s = case["session"]
    for key in ("subsession_id", "session_name", "league_name", "track",
                "config", "start_time", "simulated_start", "session_types"):
        assert key in s, key
    assert isinstance(s["subsession_id"], int)
    assert isinstance(s["session_types"], list)
    assert set(s["session_types"]) <= {"PRACTICE", "QUALIFY", "RACE"}

    for d in case["drivers"]:
        for key in ("car_idx", "cust_id", "name", "car", "car_number",
                    "car_class", "finish_pos", "laps_complete", "incidents",
                    "laps"):
            assert key in d, key
        assert isinstance(d["car_idx"], int)
        assert isinstance(d["cust_id"], int)
        prev_st = None
        for lap in d["laps"]:
            assert isinstance(lap["lap"], int)
            assert isinstance(lap["time_s"], (int, float))
            assert isinstance(lap["flags"], list)
            assert isinstance(lap["session_time_s"], (int, float))
            if prev_st is not None:
                assert lap["session_time_s"] >= prev_st  # monotonic
            prev_st = lap["session_time_s"]

    idxs = {d["car_idx"] for d in case["drivers"]}
    for e in case["events"]:
        for key in ("type", "session_time_s", "lap", "car_idx",
                    "description", "source"):
            assert key in e, key
        assert e["source"] in ("api", "derived")
        assert isinstance(e["car_idx"], list)
        assert set(e["car_idx"]) <= idxs
