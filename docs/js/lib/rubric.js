// rubric.js — steward-kit/rubric@1 model: default endurance rubric, editing
// operations, JSON import/export, localStorage persistence. Pure logic; the
// localStorage helpers no-op cleanly under Node.

export const RUBRIC_FORMAT = "steward-kit/rubric@1";
export const RUBRIC_LS_KEY = "steward-kit.rubric.v1";

/** OpMo-flavored endurance league defaults — clearly editable in the UI. */
export function defaultRubric() {
  return {
    format: RUBRIC_FORMAT,
    league: "Operation Motorsport eMotorsport League",
    penalties: [
      { code: "NFA", label: "No further action", action: "Incident reviewed — racing incident / no penalty" },
      { code: "W1", label: "Official warning", action: "Warning (recorded; escalates on repeat)" },
      { code: "AC1", label: "Avoidable contact, minor (no position or race impact)", action: "Warning" },
      { code: "AC2", label: "Avoidable contact, position lost or race compromised", action: "Drive-through (next race) / 30s post-race" },
      { code: "AC3", label: "Avoidable contact, car retired or major damage", action: "60s post-race + stewards review before next round" },
      { code: "TR1", label: "Track limits abuse", action: "Lap deletion / warning" },
      { code: "TR2", label: "Persistent track limits after warning", action: "15s post-race" },
      { code: "PL1", label: "Pit lane infraction (speeding, wrong entry/exit line)", action: "Warning / 10s post-race" },
      { code: "PL2", label: "Unsafe release", action: "Drive-through (next race) / 20s post-race" },
      { code: "US1", label: "Unsporting driving (blocking, brake-check, forcing off)", action: "30s post-race + warning" },
      { code: "US2", label: "Deliberate contact or retaliation", action: "Disqualification + review of league membership" },
    ],
  };
}

/** Validate a parsed document as rubric@1. Returns { ok, errors }. */
export function validateRubric(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: ["not a JSON object"] };
  if (doc.format !== RUBRIC_FORMAT) errors.push(`format is ${JSON.stringify(doc.format)}, expected "${RUBRIC_FORMAT}"`);
  if (typeof doc.league !== "string") errors.push("league must be a string");
  if (!Array.isArray(doc.penalties)) {
    errors.push("penalties must be an array");
  } else {
    const seen = new Set();
    doc.penalties.forEach((p, i) => {
      if (!p || typeof p !== "object") { errors.push(`penalties[${i}] is not an object`); return; }
      if (typeof p.code !== "string" || !p.code.trim()) errors.push(`penalties[${i}].code missing`);
      else if (seen.has(p.code)) errors.push(`duplicate code "${p.code}"`);
      else seen.add(p.code);
      if (typeof p.label !== "string" || !p.label.trim()) errors.push(`penalties[${i}].label missing`);
      if (typeof p.action !== "string" || !p.action.trim()) errors.push(`penalties[${i}].action missing`);
    });
  }
  return { ok: errors.length === 0, errors };
}

/** Parse + validate a JSON string. Returns { ok, rubric, errors }. */
export function importRubric(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (err) { return { ok: false, rubric: null, errors: [`not valid JSON: ${err.message}`] }; }
  const v = validateRubric(doc);
  return { ok: v.ok, rubric: v.ok ? doc : null, errors: v.errors };
}

/** Deterministic pretty-printed JSON for export. */
export function exportRubric(rubric) {
  return JSON.stringify(rubric, null, 2) + "\n";
}

export function findPenalty(rubric, code) {
  return (rubric.penalties || []).find((p) => p.code === code) || null;
}

/** Add or replace a penalty by code; returns a new rubric (no mutation). */
export function upsertPenalty(rubric, penalty) {
  const penalties = [...rubric.penalties];
  const i = penalties.findIndex((p) => p.code === penalty.code);
  if (i >= 0) penalties[i] = { ...penalty };
  else penalties.push({ ...penalty });
  return { ...rubric, penalties };
}

/** Remove a penalty by code; returns a new rubric. */
export function removePenalty(rubric, code) {
  return { ...rubric, penalties: rubric.penalties.filter((p) => p.code !== code) };
}

// ---------------------------------------------------------------------------
// persistence (browser only — silently unavailable under Node)

function storage() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; }
  catch { return null; }
}

/** Load saved rubric, or the default when nothing (valid) is stored. */
export function loadRubric() {
  const ls = storage();
  if (ls) {
    const raw = ls.getItem(RUBRIC_LS_KEY);
    if (raw) {
      const r = importRubric(raw);
      if (r.ok) return r.rubric;
    }
  }
  return defaultRubric();
}

export function saveRubric(rubric) {
  const ls = storage();
  if (ls) ls.setItem(RUBRIC_LS_KEY, JSON.stringify(rubric));
}
