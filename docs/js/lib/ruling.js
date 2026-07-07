// ruling.js — deterministic ruling-post generator (Discord-ready markdown)
// and the full-session stewards report digest. No AI, no randomness, no
// timestamps injected at render time: same inputs -> same text, always.

import { carLabel, formatSessionTime } from "./case.js";
import { findPenalty } from "./rubric.js";

/**
 * Decision object (as stored per incident id in localStorage):
 *   {
 *     status: "decided" | "dismissed",
 *     finding: "free text",
 *     code: "AC2" | null,        // rubric code (null for dismissed/no-action)
 *     cars: [car_idx, ...],      // penalized/involved cars per the stewards
 *     protest_ref: "free text"   // OPT
 *   }
 */

function sessionLine(caseDoc) {
  const s = caseDoc.session || {};
  const bits = [];
  if (s.session_name) bits.push(s.session_name);
  if (s.track) bits.push(s.config ? `${s.track} (${s.config})` : s.track);
  if (s.start_time) bits.push(s.start_time);
  return bits.join(" · ") || "unknown session";
}

function carsLine(caseDoc, cars) {
  if (!cars || !cars.length) return "—";
  return [...cars].sort((a, b) => a - b).map((c) => carLabel(caseDoc, c)).join(", ");
}

function incidentLine(incident) {
  const lap = incident.lap != null ? `Lap ${incident.lap}` : "Lap unknown";
  return `${lap} · ${formatSessionTime(incident.session_time_s)}`;
}

function rulingLine(decision, rubric) {
  if (decision.status === "dismissed") {
    return "No further action — incident reviewed and dismissed.";
  }
  if (!decision.code) return "No penalty applied.";
  const p = findPenalty(rubric, decision.code);
  if (!p) return `${decision.code} (code not in current rubric)`;
  return `${p.code} — ${p.label} → ${p.action}`;
}

/**
 * One Discord-paste-ready markdown block for a decided/dismissed incident.
 */
export function rulingPost(caseDoc, incident, decision, rubric) {
  const league = caseDoc.session?.league_name || rubric.league || null;
  const lines = [];
  lines.push(`**STEWARDS DECISION${league ? " — " + league : ""}**`);
  lines.push(`**Session:** ${sessionLine(caseDoc)}`);
  lines.push(`**Incident:** ${incidentLine(incident)}`);
  lines.push(`**Cars involved:** ${carsLine(caseDoc, decision.cars?.length ? decision.cars : incident.car_idx)}`);
  if (decision.finding && decision.finding.trim()) {
    lines.push(`**Finding:** ${decision.finding.trim()}`);
  }
  lines.push(`**Ruling:** ${rulingLine(decision, rubric)}`);
  if (decision.protest_ref && decision.protest_ref.trim()) {
    lines.push(`**Protest ref:** ${decision.protest_ref.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Full-session digest: every decided/dismissed incident in one post,
 * in review-queue order. `decisions` is a map/object keyed by incident id.
 */
export function stewardsReport(caseDoc, incidents, decisions, rubric) {
  const league = caseDoc.session?.league_name || rubric.league || null;
  const get = (id) => (decisions instanceof Map ? decisions.get(id) : decisions[id]);
  const done = incidents.filter((inc) => {
    const d = get(inc.id);
    return d && (d.status === "decided" || d.status === "dismissed");
  });

  const lines = [];
  lines.push(`**STEWARDS REPORT${league ? " — " + league : ""}**`);
  lines.push(`**Session:** ${sessionLine(caseDoc)}`);
  lines.push(`**Incidents reviewed:** ${done.length} of ${incidents.length}`);
  if (!done.length) {
    lines.push("");
    lines.push("_No decisions recorded yet._");
    return lines.join("\n");
  }
  let n = 0;
  for (const inc of done) {
    const d = get(inc.id);
    n++;
    lines.push("");
    lines.push(`**${n}. ${incidentLine(inc)}** — ${carsLine(caseDoc, d.cars?.length ? d.cars : inc.car_idx)}`);
    if (d.finding && d.finding.trim()) lines.push(`> ${d.finding.trim()}`);
    lines.push(`> **Ruling:** ${rulingLine(d, rubric)}`);
    if (d.protest_ref && d.protest_ref.trim()) lines.push(`> Protest ref: ${d.protest_ref.trim()}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// decisions import/export — so a case can be reopened later

export const DECISIONS_FORMAT = "steward-kit/decisions@1";

export function exportDecisions(subsessionId, decisions) {
  const obj = decisions instanceof Map ? Object.fromEntries(decisions) : decisions;
  return JSON.stringify(
    { format: DECISIONS_FORMAT, subsession_id: subsessionId ?? null, decisions: obj },
    null, 2,
  ) + "\n";
}

/** Parse + validate exported decisions. Returns { ok, subsession_id, decisions, errors }. */
export function importDecisions(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (err) { return { ok: false, decisions: null, errors: [`not valid JSON: ${err.message}`] }; }
  const errors = [];
  if (!doc || typeof doc !== "object") errors.push("not a JSON object");
  else {
    if (doc.format !== DECISIONS_FORMAT) errors.push(`format is ${JSON.stringify(doc.format)}, expected "${DECISIONS_FORMAT}"`);
    if (!doc.decisions || typeof doc.decisions !== "object" || Array.isArray(doc.decisions)) {
      errors.push("decisions must be an object keyed by incident id");
    }
  }
  if (errors.length) return { ok: false, decisions: null, errors };
  return { ok: true, subsession_id: doc.subsession_id ?? null, decisions: doc.decisions, errors: [] };
}
