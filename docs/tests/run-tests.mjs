#!/usr/bin/env node
// run-tests.mjs — Steward Kit web app test suite (plain Node, no framework).
//
//   node docs/tests/run-tests.mjs
//
// Covers: case@1 validation (minimal vs full, OPT-field degradation),
// session-time math to 1e-6 including tow interpolation, incident
// extraction/grouping, ruling golden texts, rubric round-trip, and — when
// agent A's python/tests/fixtures/sample_case.json exists — a cross-check
// that shared timestamp math derives identical values (skips with a message
// when the fixture is absent).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CASE_FORMAT, validateCase, loadCase, deriveSessionTimes, sessionTimeIndex,
  formatSessionTime, formatClock, extractIncidents, incidentId, carLabel, lapsAround,
} from "../js/lib/case.js";
import {
  RUBRIC_FORMAT, defaultRubric, validateRubric, importRubric, exportRubric,
  findPenalty, upsertPenalty, removePenalty,
} from "../js/lib/rubric.js";
import {
  rulingPost, stewardsReport, exportDecisions, importDecisions, DECISIONS_FORMAT,
} from "../js/lib/ruling.js";
import { makeSampleCase, SYNTH_TOW, SYNTH_CONTACT, SYNTH_OFFTRACK, SYNTH_SOLO_CONTACT } from "../js/lib/synthetic.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = join(HERE, "..", "..", "python", "tests", "fixtures", "sample_case.json");
let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks++;
  if (cond) console.log(`  ok    ${msg}`);
  else { failures++; console.log(`  FAIL  ${msg}`); }
}
function eq(a, b, msg) { ok(a === b, `${msg}${a === b ? "" : ` (${JSON.stringify(a)} vs ${JSON.stringify(b)})`}`); }
function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b}, tol ${tol})`); }

// ---------------------------------------------------------------------------
console.log("[1/7] case@1 validation — minimal vs full, OPT degradation");
{
  const full = makeSampleCase();
  const vFull = validateCase(full);
  ok(vFull.ok, "synthetic full case validates");
  eq(vFull.errors.length, 0, "full case has no errors");

  // minimal case: only REQUIRED fields — every OPT field absent
  const minimal = {
    format: CASE_FORMAT,
    fetched_at: "2026-07-01T00:00:00Z",
    session: { subsession_id: 1, session_name: "S", track: "T", start_time: "2026-07-01T00:00:00Z", session_types: ["RACE"] },
    drivers: [{ car_idx: 0, cust_id: 1, name: "D", car: "C", car_number: "1", finish_pos: 1, laps_complete: 2,
      incidents: 0, laps: [{ lap: 1, time_s: 90 }, { lap: 2, time_s: 91 }] }],
  };
  const vMin = validateCase(minimal);
  ok(vMin.ok, "minimal case (no events, no OPT fields) validates");
  ok(vMin.warnings.some((w) => w.includes("events missing")), "missing events produces a warning, not an error");

  ok(!validateCase(null).ok, "null rejected");
  ok(!validateCase({ format: "other/format@1", session: {}, drivers: [] }).ok, "wrong format rejected");
  ok(!validateCase({ format: CASE_FORMAT, session: {}, drivers: "nope" }).ok, "non-array drivers rejected");
  ok(!validateCase({ format: CASE_FORMAT, drivers: [] }).ok, "missing session rejected");
  ok(!loadCase("{ not json").ok, "loadCase on broken JSON -> ok:false");
  ok(loadCase(JSON.stringify(minimal)).ok, "loadCase round-trips a valid case");

  // graceful: laps without session_time_s, events without car_idx
  const degraded = JSON.parse(JSON.stringify(minimal));
  degraded.events = [{ type: "off_track", session_time_s: 95, lap: 2, description: "x", source: "api" }];
  const vDeg = validateCase(degraded);
  ok(vDeg.ok, "event without car_idx is a warning, not an error");
  const incs = extractIncidents(degraded);
  eq(incs.length, 1, "degraded case still yields its event as an incident");
  eq(incs[0].car_idx.length, 0, "incident survives with empty car list");
}

// ---------------------------------------------------------------------------
console.log("[2/7] session-time math — cumulative anchoring to 1e-6");
{
  const laps = [
    { lap: 1, time_s: 100.123456 },
    { lap: 2, time_s: 99.000001 },
    { lap: 3, time_s: 101.5 },
    { lap: 4, time_s: 98.376543 },
  ];
  const d = deriveSessionTimes(laps, 0);
  approx(d[0].session_time_s, 0, 1e-9, "lap 1 starts at anchor");
  approx(d[1].session_time_s, 100.123456, 1e-6, "lap 2 start = t1");
  approx(d[2].session_time_s, 199.123457, 1e-6, "lap 3 start = t1+t2");
  approx(d[3].session_time_s, 300.623457, 1e-6, "lap 4 start = t1+t2+t3");
  ok(d.every((r) => !r.discontinuity), "no discontinuity on clean laps");

  const anchored = deriveSessionTimes(laps, 812.4);
  approx(anchored[0].session_time_s, 812.4, 1e-9, "anchor offsets lap 1");
  approx(anchored[3].session_time_s, 812.4 + 300.623457, 1e-6, "anchor propagates");

  // unsorted input is sorted by lap number
  const shuffled = deriveSessionTimes([laps[2], laps[0], laps[3], laps[1]], 0);
  approx(shuffled[2].session_time_s, 199.123457, 1e-6, "unsorted input handled");
}

// ---------------------------------------------------------------------------
console.log("[3/7] session-time math — tow interpolation + discontinuity");
{
  // single missing lap: linear interpolation == neighbour average
  const laps = [
    { lap: 1, time_s: 100 },
    { lap: 2, time_s: null },   // towed
    { lap: 3, time_s: 104 },
    { lap: 4, time_s: 100 },
  ];
  const d = deriveSessionTimes(laps, 0);
  approx(d[1].session_time_s, 100, 1e-9, "towed lap start uses prior valid times");
  approx(d[1].filled_time_s, 102, 1e-9, "single gap fills to neighbour average");
  approx(d[2].session_time_s, 202, 1e-6, "lap after tow uses interpolated time");
  approx(d[3].session_time_s, 306, 1e-6, "cumsum continues after tow");
  ok(d[1].interpolated && d[1].discontinuity, "towed lap flagged interpolated + discontinuity");
  ok(!d[0].discontinuity, "laps before tow are clean");
  ok(d[2].discontinuity && d[3].discontinuity, "laps after tow carry discontinuity (estimates)");

  // run of two missing laps: linear ramp between 90 and 96 -> 92, 94
  const run = deriveSessionTimes([
    { lap: 1, time_s: 90 }, { lap: 2, time_s: null }, { lap: 3, time_s: null }, { lap: 4, time_s: 96 },
  ], 0);
  approx(run[1].filled_time_s, 92, 1e-9, "gap run fills linearly (1/2)");
  approx(run[2].filled_time_s, 94, 1e-9, "gap run fills linearly (2/2)");
  approx(run[3].session_time_s, 276, 1e-6, "cumsum across the run");

  // leading + trailing gaps clamp to nearest valid
  const edges = deriveSessionTimes([
    { lap: 1, time_s: null }, { lap: 2, time_s: 100 }, { lap: 3, time_s: null },
  ], 0);
  approx(edges[0].filled_time_s, 100, 1e-9, "leading gap clamps to next valid");
  approx(edges[2].filled_time_s, 100, 1e-9, "trailing gap clamps to prior valid");

  // all missing -> null times, no crash
  const none = deriveSessionTimes([{ lap: 1, time_s: null }, { lap: 2 }], 0);
  ok(none.every((r) => r.session_time_s === null), "all-missing lap times -> null session times");

  // zero / negative lap times treated as missing
  const zero = deriveSessionTimes([{ lap: 1, time_s: 100 }, { lap: 2, time_s: 0 }, { lap: 3, time_s: 100 }], 0);
  ok(zero[1].interpolated, "time_s = 0 treated as missing");
}

// ---------------------------------------------------------------------------
console.log("[4/7] replay-time formatting");
{
  eq(formatClock(812.4), "0:13:32", "812.4 -> 0:13:32");
  eq(formatSessionTime(812.4), "0:13:32 into session", "formatSessionTime wording");
  eq(formatClock(0), "0:00:00", "zero");
  eq(formatClock(59.999), "0:00:59", "floors, never rounds up");
  eq(formatClock(3600), "1:00:00", "hour boundary");
  eq(formatClock(7325), "2:02:05", "H:MM:SS padding");
  eq(formatClock(90061), "25:01:01", "past 24h stays H:MM:SS");
  eq(formatClock(null), null, "null -> null");
  eq(formatClock(-5), null, "negative -> null");
  eq(formatSessionTime(undefined), "time unknown", "unknown time wording");
}

// ---------------------------------------------------------------------------
console.log("[5/7] incident extraction — queue, grouping, flag fallback");
{
  const doc = makeSampleCase();
  const incs = extractIncidents(doc);

  // events pass through: grouped contact (2 cars) + solo wall contact
  const contact = incs.find((i) => i.type === "car_contact" && i.lap === SYNTH_CONTACT.lap);
  ok(contact, "car_contact event in queue");
  eq(JSON.stringify(contact.car_idx), JSON.stringify([...SYNTH_CONTACT.cars].sort((a, b) => a - b)),
    "grouped contact carries both cars");
  eq(contact.source, "derived", "event source preserved");

  const solo = incs.find((i) => i.type === "contact" && i.lap === SYNTH_SOLO_CONTACT.lap);
  ok(solo, "solo contact event in queue");
  // its lap flags (contact + off_track on #77 L15) — contact covered by the
  // event; off_track on the same lap is NOT covered and appears separately
  const soloOff = incs.find((i) => i.type === "off_track" && i.lap === SYNTH_SOLO_CONTACT.lap);
  ok(soloOff, "uncovered off_track flag on an event lap still queued");

  // the deliberately-uncovered off_track flag becomes an incident
  const off = incs.find((i) => i.type === "off_track" && i.lap === SYNTH_OFFTRACK.lap);
  ok(off, "flagged lap not covered by events is queued");
  eq(JSON.stringify(off.car_idx), JSON.stringify([SYNTH_OFFTRACK.car_idx]), "flag incident carries its car");
  eq(off.source, "derived", "flag incident marked derived");

  // no duplicate for lap flags already covered by events
  const contactFlagDupes = incs.filter((i) => i.type === "car_contact" && i.lap === SYNTH_CONTACT.lap);
  eq(contactFlagDupes.length, 1, "covered car_contact flags don't duplicate the event");
  // lost_control on #7 L12 is a different flag type -> queued as evidence
  ok(incs.some((i) => i.type === "lost_control" && i.lap === SYNTH_CONTACT.lap), "distinct flag types on event laps still surface");

  // sorted by session time
  const times = incs.map((i) => i.session_time_s ?? Infinity);
  ok(times.every((t, i) => i === 0 || t >= times[i - 1]), "queue sorted by session time");

  // ids are stable and unique
  const ids = incs.map((i) => i.id);
  eq(new Set(ids).size, ids.length, "incident ids unique");
  const again = extractIncidents(makeSampleCase());
  eq(JSON.stringify(again.map((i) => i.id)), JSON.stringify(ids), "extraction fully deterministic");

  // grouping window: same-lap car_contact >30s apart stays separate
  const twoCrash = {
    format: CASE_FORMAT, fetched_at: "x",
    session: { subsession_id: 2, session_name: "S", track: "T", start_time: "x", session_types: ["RACE"] },
    drivers: [
      { car_idx: 1, name: "A", laps: [{ lap: 5, time_s: 90, session_time_s: 400, flags: ["car_contact"] }] },
      { car_idx: 2, name: "B", laps: [{ lap: 5, time_s: 90, session_time_s: 415, flags: ["car_contact"] }] },
      { car_idx: 3, name: "C", laps: [{ lap: 5, time_s: 90, session_time_s: 470, flags: ["car_contact"] }] },
    ],
  };
  const grouped = extractIncidents(twoCrash);
  eq(grouped.length, 2, "30s window: cars at 400/415 group, 470 separate");
  eq(JSON.stringify(grouped[0].car_idx), JSON.stringify([1, 2]), "first cluster cars");
  eq(JSON.stringify(grouped[1].car_idx), JSON.stringify([3]), "second cluster car");

  // fallback: no session_time_s anywhere -> derived from lap times
  const noTimes = JSON.parse(JSON.stringify(twoCrash));
  for (const d of noTimes.drivers) {
    d.laps = [{ lap: 1, time_s: 100, flags: [] }, { lap: 2, time_s: 101, flags: d.car_idx === 1 ? ["off_track"] : [] }];
  }
  const derived = extractIncidents(noTimes);
  approx(derived[0].session_time_s, 100, 1e-6, "incident time re-derived from lap times when absent");

  // evidence helpers
  eq(carLabel(doc, 3), "#33 A. Vance", "carLabel");
  const around = lapsAround(doc, contact, 3);
  eq(around.length, 2, "lapsAround returns both involved cars");
  ok(around[0].laps.length >= 4 && around[0].laps[0].lap === SYNTH_CONTACT.lap - 3, "lap window spans ±3");

  // id determinism contract
  eq(incidentId("car_contact", 12, [7, 3], 1130.2), "car_contact:L12:3-7:1130", "incidentId format");
}

// ---------------------------------------------------------------------------
console.log("[6/7] rubric round-trip + ruling golden texts");
{
  const rub = defaultRubric();
  ok(validateRubric(rub).ok, "default rubric validates");
  ok(rub.penalties.length >= 8, "default rubric covers warnings/contact/track-limits/pit/unsporting");
  for (const code of ["W1", "AC1", "AC2", "AC3", "TR1", "PL1", "US1", "NFA"]) {
    ok(!!findPenalty(rub, code), `default rubric has ${code}`);
  }

  const round = importRubric(exportRubric(rub));
  ok(round.ok, "export -> import round-trips");
  eq(JSON.stringify(round.rubric), JSON.stringify(rub), "round-trip is lossless");

  const edited = upsertPenalty(rub, { code: "AC2", label: "changed", action: "changed action" });
  eq(findPenalty(edited, "AC2").label, "changed", "upsert replaces by code");
  eq(findPenalty(rub, "AC2").label.slice(0, 9), "Avoidable", "upsert does not mutate source");
  const added = upsertPenalty(rub, { code: "ZZ9", label: "new", action: "act" });
  eq(added.penalties.length, rub.penalties.length + 1, "upsert appends new code");
  const removed = removePenalty(added, "ZZ9");
  eq(removed.penalties.length, rub.penalties.length, "removePenalty");

  ok(!validateRubric({ format: RUBRIC_FORMAT, league: "L", penalties: [{ code: "A", label: "l", action: "a" }, { code: "A", label: "l", action: "a" }] }).ok,
    "duplicate codes rejected");
  ok(!importRubric("{").ok, "broken JSON rejected");

  // --- ruling golden tests (deterministic template) ---
  const doc = makeSampleCase();
  const incs = extractIncidents(doc);
  const contact = incs.find((i) => i.type === "car_contact" && i.lap === SYNTH_CONTACT.lap);
  const t = formatClock(contact.session_time_s);

  const post = rulingPost(doc, contact, {
    status: "decided",
    finding: "Car #7 misjudged braking into T10a and made avoidable contact with #33, which lost two positions.",
    code: "AC2",
    cars: [3, 7],
    protest_ref: "Protest P-04 (Team Vance)",
  }, rub);
  const golden = [
    "**STEWARDS DECISION — Operation Motorsport eMotorsport League**",
    "**Session:** OpMo Endurance Round 4 · Road Atlanta (Full Course) · 2026-06-28T19:00:00Z",
    `**Incident:** Lap 12 · ${t} into session`,
    "**Cars involved:** #33 A. Vance, #7 R. Okafor",
    "**Finding:** Car #7 misjudged braking into T10a and made avoidable contact with #33, which lost two positions.",
    "**Ruling:** AC2 — Avoidable contact, position lost or race compromised → Drive-through (next race) / 30s post-race",
    "**Protest ref:** Protest P-04 (Team Vance)",
  ].join("\n");
  eq(post, golden, "decided ruling post matches golden text");

  const dismissed = rulingPost(doc, contact, { status: "dismissed", finding: "Racing incident.", code: null, cars: [] }, rub);
  ok(dismissed.includes("**Ruling:** No further action — incident reviewed and dismissed."), "dismissed wording");
  ok(dismissed.includes("**Cars involved:** #33 A. Vance, #7 R. Okafor"), "dismissed falls back to incident cars");
  ok(!dismissed.includes("Protest ref"), "protest line omitted when absent");

  const unknownCode = rulingPost(doc, contact, { status: "decided", finding: "f", code: "NOPE", cars: [3] }, rub);
  ok(unknownCode.includes("NOPE (code not in current rubric)"), "unknown rubric code degrades gracefully");

  // stewards report digest
  const decisions = {
    [contact.id]: { status: "decided", finding: "Avoidable contact.", code: "AC2", cars: [3, 7], protest_ref: "P-04" },
    [incs.find((i) => i.type === "off_track" && i.lap === SYNTH_OFFTRACK.lap).id]:
      { status: "dismissed", finding: "Single-car off, no advantage.", code: null, cars: [] },
  };
  const report = stewardsReport(doc, incs, decisions, rub);
  ok(report.startsWith("**STEWARDS REPORT — Operation Motorsport eMotorsport League**"), "report header");
  ok(report.includes(`**Incidents reviewed:** 2 of ${incs.length}`), "report progress line");
  ok(report.includes("> **Ruling:** AC2 —"), "report includes decided ruling");
  ok(report.includes("No further action"), "report includes dismissed ruling");
  const report2 = stewardsReport(doc, incs, new Map(Object.entries(decisions)), rub);
  eq(report2, report, "report accepts Map or object decisions");
  ok(stewardsReport(doc, incs, {}, rub).includes("_No decisions recorded yet._"), "empty report wording");

  // decisions export/import round-trip
  const exported = exportDecisions(doc.session.subsession_id, decisions);
  const imp = importDecisions(exported);
  ok(imp.ok, "decisions import ok");
  eq(imp.subsession_id, doc.session.subsession_id, "subsession id preserved");
  eq(JSON.stringify(imp.decisions), JSON.stringify(decisions), "decisions round-trip lossless");
  ok(JSON.parse(exported).format === DECISIONS_FORMAT, "decisions format tag");
  ok(!importDecisions('{"format":"nope"}').ok, "wrong decisions format rejected");
}

// ---------------------------------------------------------------------------
console.log("[7/7] cross-check against agent A's Python fixture");
if (!existsSync(PY_FIXTURE)) {
  console.log("  skip  python/tests/fixtures/sample_case.json not present — provisional synthetic fixture used above");
} else {
  const doc = JSON.parse(readFileSync(PY_FIXTURE, "utf8"));
  const v = validateCase(doc);
  ok(v.ok, `Python fixture validates as ${CASE_FORMAT}${v.ok ? "" : ": " + v.errors.join("; ")}`);
  if (v.ok) {
    eq(doc.drivers.length, 6, "fixture has 6 drivers (SPEC recipe)");
    let checkedLaps = 0;
    for (const d of doc.drivers) {
      const laps = (d.laps || []).filter((l) => typeof l.session_time_s === "number");
      if (laps.length < 2) continue;
      const sorted = [...d.laps].sort((a, b) => a.lap - b.lap);
      const anchor = sorted.find((l) => typeof l.session_time_s === "number").session_time_s;
      const derived = deriveSessionTimes(d.laps, anchor);
      for (const r of derived) {
        const given = sorted.find((l) => l.lap === r.lap)?.session_time_s;
        if (typeof given !== "number" || r.session_time_s == null) continue;
        checkedLaps++;
        if (Math.abs(given - r.session_time_s) > 1e-6) {
          failures++; checks++;
          console.log(`  FAIL  ${d.name} lap ${r.lap}: fixture ${given} vs derived ${r.session_time_s}`);
        }
      }
    }
    checks++;
    console.log(`  ok    session_time_s re-derivation matches fixture to 1e-6 (${checkedLaps} laps checked)`);
    const incs = extractIncidents(doc);
    ok(incs.length > 0, `incident extraction yields a queue from the fixture (${incs.length} incidents)`);
    ok(incs.every((i) => typeof i.id === "string" && i.id.length > 0), "fixture incidents all get stable ids");
    const withTow = doc.drivers.some((d) => (d.laps || []).some((l) => (l.flags || []).includes("discontinuity")));
    ok(withTow, "fixture contains the SPEC tow/discontinuity");
  }
}

// ---------------------------------------------------------------------------
console.log("");
console.log(`${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
