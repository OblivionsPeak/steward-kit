// case.js — steward-kit/case@1 loader, validator, timestamp math, and
// incident extraction. Pure logic, no DOM: shared between the browser app
// and the Node test suite (docs/tests/run-tests.mjs).

export const CASE_FORMAT = "steward-kit/case@1";

// Flags on a lap that put it in front of the stewards when no event covers it.
export const REVIEW_FLAGS = ["car_contact", "contact", "off_track", "lost_control", "black_flag"];

// Same-lap car_contact flags whose session-time estimates fall within this
// window are grouped into one incident (mirrors the SPEC event derivation).
export const CONTACT_GROUP_WINDOW_S = 30;

// ---------------------------------------------------------------------------
// validation

function isFiniteNum(x) { return typeof x === "number" && Number.isFinite(x); }

/**
 * Validate a parsed JSON document as steward-kit/case@1.
 * Returns { ok, errors, warnings }. OPT fields (league_name, config,
 * simulated_start, events, laps[].session_time_s, laps[].flags, ...) may be
 * absent or null — those only produce warnings, never errors.
 */
export function validateCase(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["not a JSON object"], warnings };
  }
  if (doc.format !== CASE_FORMAT) {
    errors.push(`format is ${JSON.stringify(doc.format)}, expected "${CASE_FORMAT}"`);
  }
  const s = doc.session;
  if (!s || typeof s !== "object") {
    errors.push("missing session object");
  } else {
    if (!isFiniteNum(s.subsession_id)) warnings.push("session.subsession_id missing");
    if (typeof s.track !== "string" || !s.track) warnings.push("session.track missing");
    if (typeof s.session_name !== "string" || !s.session_name) warnings.push("session.session_name missing");
  }
  if (!Array.isArray(doc.drivers)) {
    errors.push("missing drivers array");
  } else {
    if (doc.drivers.length === 0) warnings.push("drivers array is empty");
    doc.drivers.forEach((d, i) => {
      if (!d || typeof d !== "object") { errors.push(`drivers[${i}] is not an object`); return; }
      if (!isFiniteNum(d.car_idx)) errors.push(`drivers[${i}].car_idx missing`);
      if (typeof d.name !== "string" || !d.name) warnings.push(`drivers[${i}].name missing`);
      if (!Array.isArray(d.laps)) {
        warnings.push(`drivers[${i}].laps missing (no per-lap evidence for ${d.name || "car " + d.car_idx})`);
      } else {
        d.laps.forEach((l, j) => {
          if (!l || typeof l !== "object") { errors.push(`drivers[${i}].laps[${j}] is not an object`); return; }
          if (!isFiniteNum(l.lap)) errors.push(`drivers[${i}].laps[${j}].lap missing`);
        });
      }
    });
  }
  if (doc.events == null) {
    warnings.push("events missing — review queue built from lap flags only");
  } else if (!Array.isArray(doc.events)) {
    errors.push("events is not an array");
  } else {
    doc.events.forEach((e, i) => {
      if (!e || typeof e !== "object") { errors.push(`events[${i}] is not an object`); return; }
      if (typeof e.type !== "string" || !e.type) errors.push(`events[${i}].type missing`);
      if (!Array.isArray(e.car_idx)) warnings.push(`events[${i}].car_idx missing`);
      if (!isFiniteNum(e.session_time_s)) warnings.push(`events[${i}].session_time_s missing (no replay jump time)`);
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Parse a JSON string and validate. Returns { ok, doc, errors, warnings }. */
export function loadCase(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (err) { return { ok: false, doc: null, errors: [`not valid JSON: ${err.message}`], warnings: [] }; }
  const v = validateCase(doc);
  return { ok: v.ok, doc: v.ok ? doc : null, errors: v.errors, warnings: v.warnings };
}

// ---------------------------------------------------------------------------
// timestamp math (must match the Python fetcher to 1e-6)

/**
 * Derive per-lap session_time_s (session time at the START of each lap) from
 * lap times: cumulative sum of prior lap times anchored to `anchor` (session
 * time at the start of the driver's first lap; default 0 = race session start).
 *
 * Missing lap times (towed laps: time_s null/absent/non-positive) are filled
 * by linear interpolation between the nearest valid neighbours — a single
 * missing lap gets the neighbour average; a run of k missing laps ramps
 * linearly between the bracketing valid times. Leading/trailing runs clamp to
 * the nearest valid time. Laps whose start time depends on an interpolated
 * value are marked discontinuity.
 *
 * Input: laps array (any order; sorted by lap number internally).
 * Returns array aligned to the *sorted* laps:
 *   { lap, time_s, filled_time_s, session_time_s, interpolated, discontinuity }
 * If no lap has a valid time, all session_time_s are null.
 */
export function deriveSessionTimes(laps, anchor = 0) {
  const sorted = [...laps].sort((a, b) => a.lap - b.lap);
  const n = sorted.length;
  const valid = sorted.map((l) => isFiniteNum(l.time_s) && l.time_s > 0);
  const filled = sorted.map((l, i) => (valid[i] ? l.time_s : null));

  if (!valid.some(Boolean)) {
    return sorted.map((l) => ({
      lap: l.lap, time_s: null, filled_time_s: null,
      session_time_s: null, interpolated: !!(n), discontinuity: true,
    }));
  }

  // fill gaps: linear ramp between bracketing valid lap times
  let i = 0;
  while (i < n) {
    if (valid[i]) { i++; continue; }
    let j = i;
    while (j < n && !valid[j]) j++;
    const prev = i > 0 ? filled[i - 1] : null;        // valid by construction
    const next = j < n ? filled[j] : null;
    const k = j - i;
    for (let m = 0; m < k; m++) {
      if (prev != null && next != null) filled[i + m] = prev + ((next - prev) * (m + 1)) / (k + 1);
      else filled[i + m] = prev != null ? prev : next;
    }
    i = j;
  }

  const out = [];
  let t = anchor;
  let tainted = false; // start time depends on an interpolated lap time
  for (let idx = 0; idx < n; idx++) {
    const l = sorted[idx];
    const interpolated = !valid[idx];
    out.push({
      lap: l.lap,
      time_s: valid[idx] ? l.time_s : null,
      filled_time_s: filled[idx],
      session_time_s: t,
      interpolated,
      discontinuity: interpolated || tainted,
    });
    if (interpolated) tainted = true;
    t += filled[idx];
  }
  return out;
}

/**
 * Session time for every driver: prefers laps[].session_time_s from the case
 * file; falls back to deriveSessionTimes when the field is absent.
 * Returns Map(car_idx -> Map(lap -> session_time_s|null)).
 */
export function sessionTimeIndex(caseDoc) {
  const index = new Map();
  for (const d of caseDoc.drivers || []) {
    const perLap = new Map();
    const laps = Array.isArray(d.laps) ? d.laps : [];
    const hasTimes = laps.some((l) => isFiniteNum(l.session_time_s));
    if (hasTimes) {
      for (const l of laps) perLap.set(l.lap, isFiniteNum(l.session_time_s) ? l.session_time_s : null);
    } else if (laps.length) {
      for (const r of deriveSessionTimes(laps)) perLap.set(r.lap, r.session_time_s);
    }
    index.set(d.car_idx, perLap);
  }
  return index;
}

/** 812.4 -> "0:13:32 into session"; null/invalid -> "time unknown". */
export function formatSessionTime(sessionTimeS) {
  const c = formatClock(sessionTimeS);
  return c == null ? "time unknown" : `${c} into session`;
}

/** 812.4 -> "0:13:32" (H:MM:SS, hours unpadded); null/invalid -> null. */
export function formatClock(sessionTimeS) {
  if (!isFiniteNum(sessionTimeS) || sessionTimeS < 0) return null;
  const total = Math.floor(sessionTimeS);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// incident extraction — the review queue

/** Deterministic, content-derived incident id (stable across reloads). */
export function incidentId(type, lap, cars, sessionTimeS) {
  const c = [...cars].sort((a, b) => a - b).join("-");
  const t = isFiniteNum(sessionTimeS) ? String(Math.round(sessionTimeS)) : "x";
  return `${type}:L${lap == null ? "x" : lap}:${c}:${t}`;
}

/**
 * Build the review queue: every entry of events[] plus one incident per
 * review-worthy flagged lap not covered by an event. Same-lap car_contact
 * flags within CONTACT_GROUP_WINDOW_S collapse into one multi-car incident.
 *
 * Returns incidents sorted by session time (unknown times last), each:
 *   { id, type, lap, car_idx[], session_time_s, description, source }
 */
export function extractIncidents(caseDoc) {
  const times = sessionTimeIndex(caseDoc);
  const incidents = [];

  // 1. events[] pass through
  const covered = new Set(); // "car|lap|type" handled by an event
  for (const e of caseDoc.events || []) {
    const cars = Array.isArray(e.car_idx) ? [...e.car_idx].sort((a, b) => a - b) : [];
    const lap = isFiniteNum(e.lap) ? e.lap : null;
    let t = isFiniteNum(e.session_time_s) ? e.session_time_s : null;
    if (t == null && lap != null && cars.length) {
      const perLap = times.get(cars[0]);
      const lt = perLap ? perLap.get(lap) : null;
      if (isFiniteNum(lt)) t = lt;
    }
    incidents.push({
      id: incidentId(e.type, lap, cars, t),
      type: e.type, lap, car_idx: cars, session_time_s: t,
      description: typeof e.description === "string" ? e.description : "",
      source: e.source === "api" ? "api" : "derived",
    });
    if (lap != null) for (const c of cars) covered.add(`${c}|${lap}|${e.type}`);
  }

  // 2. flagged laps not covered by events
  const flagged = []; // { car_idx, lap, type, session_time_s }
  for (const d of caseDoc.drivers || []) {
    const perLap = times.get(d.car_idx);
    for (const l of d.laps || []) {
      const flags = Array.isArray(l.flags) ? l.flags : [];
      for (const f of flags) {
        if (!REVIEW_FLAGS.includes(f)) continue;
        if (covered.has(`${d.car_idx}|${l.lap}|${f}`)) continue;
        // a car_contact event also covers plain "contact" on the same lap/car
        if (f === "contact" && covered.has(`${d.car_idx}|${l.lap}|car_contact`)) continue;
        const t = perLap ? perLap.get(l.lap) : null;
        flagged.push({ car_idx: d.car_idx, lap: l.lap, type: f, session_time_s: isFiniteNum(t) ? t : null });
      }
    }
  }

  // group same-lap car_contact within the window; everything else 1:1
  const contacts = flagged.filter((f) => f.type === "car_contact");
  const rest = flagged.filter((f) => f.type !== "car_contact");

  const byLap = new Map();
  for (const c of contacts) {
    if (!byLap.has(c.lap)) byLap.set(c.lap, []);
    byLap.get(c.lap).push(c);
  }
  for (const [lap, group] of byLap) {
    group.sort((a, b) => (a.session_time_s ?? Infinity) - (b.session_time_s ?? Infinity));
    let cluster = [];
    const flush = () => {
      if (!cluster.length) return;
      const cars = [...new Set(cluster.map((c) => c.car_idx))].sort((a, b) => a - b);
      const known = cluster.map((c) => c.session_time_s).filter(isFiniteNum);
      const t = known.length ? Math.min(...known) : null;
      incidents.push({
        id: incidentId("car_contact", lap, cars, t),
        type: "car_contact", lap, car_idx: cars, session_time_s: t,
        description: cars.length > 1 ? `Car-to-car contact, lap ${lap}` : `Car contact flagged, lap ${lap}`,
        source: "derived",
      });
      cluster = [];
    };
    for (const c of group) {
      if (!cluster.length) { cluster.push(c); continue; }
      const anchor = cluster[0].session_time_s;
      const within = anchor == null || c.session_time_s == null
        ? true // unknown times on the same lap: group (best effort)
        : Math.abs(c.session_time_s - anchor) <= CONTACT_GROUP_WINDOW_S;
      if (within) cluster.push(c);
      else { flush(); cluster.push(c); }
    }
    flush();
  }

  for (const f of rest) {
    incidents.push({
      id: incidentId(f.type, f.lap, [f.car_idx], f.session_time_s),
      type: f.type, lap: f.lap, car_idx: [f.car_idx], session_time_s: f.session_time_s,
      description: `${f.type.replace(/_/g, " ")} flagged, lap ${f.lap}`,
      source: "derived",
    });
  }

  incidents.sort((a, b) => {
    const ta = a.session_time_s ?? Infinity;
    const tb = b.session_time_s ?? Infinity;
    if (ta !== tb) return ta - tb;
    return (a.lap ?? Infinity) - (b.lap ?? Infinity);
  });
  return incidents;
}

// ---------------------------------------------------------------------------
// evidence helpers

/** Driver lookup by car_idx. */
export function driverByIdx(caseDoc, carIdx) {
  return (caseDoc.drivers || []).find((d) => d.car_idx === carIdx) || null;
}

/** "#33 J. Doe" — compact car label for chips and rulings. */
export function carLabel(caseDoc, carIdx) {
  const d = driverByIdx(caseDoc, carIdx);
  if (!d) return `car ${carIdx}`;
  const num = d.car_number != null ? `#${d.car_number}` : `car ${carIdx}`;
  return d.name ? `${num} ${d.name}` : num;
}

/**
 * Laps around an incident for each involved car: window of ±`span` laps.
 * Returns [{ car_idx, laps: [lapRecord...] }] (laps sorted by lap number).
 */
export function lapsAround(caseDoc, incident, span = 3) {
  if (incident.lap == null) return [];
  const lo = incident.lap - span, hi = incident.lap + span;
  const out = [];
  for (const carIdx of incident.car_idx) {
    const d = driverByIdx(caseDoc, carIdx);
    if (!d || !Array.isArray(d.laps)) continue;
    const laps = d.laps.filter((l) => l.lap >= lo && l.lap <= hi).sort((a, b) => a.lap - b.lap);
    out.push({ car_idx: carIdx, laps });
  }
  return out;
}
