// app.js — Steward Kit UI: case ingestion, incident queue, decision workflow,
// rubric editor, report/export. All pure logic lives in js/lib/ (shared with
// the Node test suite). Everything is client-side: the case file and every
// decision live in localStorage only — nothing uploads.

import {
  loadCase, extractIncidents, formatSessionTime, formatClock,
  driverByIdx, carLabel, lapsAround,
} from "./lib/case.js";
import {
  loadRubric, saveRubric, defaultRubric, validateRubric, importRubric,
  exportRubric, findPenalty,
} from "./lib/rubric.js";
import {
  rulingPost, stewardsReport, exportDecisions, importDecisions,
} from "./lib/ruling.js";
import { makeSampleCase } from "./lib/synthetic.js";

const LS_CASE = "steward-kit.case.v1";
const LS_DECISIONS = (sid) => `steward-kit.decisions.${sid ?? "unknown"}`;
const $ = (id) => document.getElementById(id);

const CAR_COLORS = ["#ffb84d", "#4aa8ff", "#e05555", "#4fc47f", "#c792ea", "#7fd8d8"];

const state = {
  doc: null,          // steward-kit/case@1
  incidents: [],      // review queue from extractIncidents
  decisions: {},      // incident id -> decision
  rubric: loadRubric(),
  selectedId: null,
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// tabs

for (const btn of document.querySelectorAll("nav.tabs button")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === `panel-${btn.dataset.tab}`));
    if (btn.dataset.tab === "report") renderReport();
    if (btn.dataset.tab === "rubric") renderRubric();
  });
}

// ---------------------------------------------------------------------------
// case ingestion

const dropzone = $("dropzone");
const fileInput = $("file-input");
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) ingestCaseFile(fileInput.files[0]);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragging"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragging");
  if (e.dataTransfer.files[0]) ingestCaseFile(e.dataTransfer.files[0]);
});

function status(lines) {
  $("file-status").innerHTML = lines
    .map((l) => `<span class="${l.cls || ""}">${esc(l.text)}</span>`)
    .join("\n");
}

async function ingestCaseFile(file) {
  const text = await file.text();
  const r = loadCase(text);
  if (!r.ok) {
    status([{ text: `${file.name}: not a steward-kit/case@1 file`, cls: "err" },
            ...r.errors.map((e) => ({ text: `  - ${e}`, cls: "err" }))]);
    return;
  }
  const lines = [{ text: `${file.name}: loaded` }];
  for (const w of r.warnings.slice(0, 6)) lines.push({ text: `  note: ${w}`, cls: "warn" });
  status(lines);
  setCase(r.doc, { persist: true });
}

function setCase(doc, { persist = false } = {}) {
  state.doc = doc;
  state.incidents = extractIncidents(doc);
  state.decisions = loadDecisions(doc.session?.subsession_id);
  state.selectedId = null;
  if (persist) {
    try { localStorage.setItem(LS_CASE, JSON.stringify(doc)); } catch { /* quota — case too big to persist */ }
  }
  renderAll();
}

$("btn-demo").addEventListener("click", () => {
  status([{ text: "demo case: synthetic OpMo endurance round (6 drivers, 20 laps, contact + tow)" }]);
  setCase(makeSampleCase(), { persist: true });
});

$("btn-clear").addEventListener("click", () => {
  if (state.doc && !confirm("Clear the loaded case? Decisions stay saved and reload with the same case file.")) return;
  localStorage.removeItem(LS_CASE);
  state.doc = null; state.incidents = []; state.decisions = {}; state.selectedId = null;
  status([]);
  $("restore-note").textContent = "";
  renderAll();
});

function loadDecisions(sid) {
  try {
    const raw = localStorage.getItem(LS_DECISIONS(sid));
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") return obj;
    }
  } catch { /* ignore */ }
  return {};
}

function saveDecisions() {
  const sid = state.doc?.session?.subsession_id;
  try { localStorage.setItem(LS_DECISIONS(sid), JSON.stringify(state.decisions)); } catch { /* ignore */ }
}

// restore previous session
(() => {
  try {
    const raw = localStorage.getItem(LS_CASE);
    if (!raw) return;
    const r = loadCase(raw);
    if (r.ok) {
      setCase(r.doc);
      $("restore-note").textContent = "restored previous case from this browser";
    }
  } catch { /* ignore */ }
})();

// ---------------------------------------------------------------------------
// render — session header

function renderSession() {
  const panel = $("session-panel");
  if (!state.doc) { panel.hidden = true; return; }
  const s = state.doc.session || {};
  const cells = [
    ["Session", s.session_name || "—"],
    ["League", s.league_name || "—"],
    ["Track", s.config ? `${s.track} — ${s.config}` : (s.track || "—")],
    ["Start", s.start_time || "—", true],
    ["Subsession", s.subsession_id ?? "—", true],
    ["Sessions", Array.isArray(s.session_types) ? s.session_types.join(" · ") : "—"],
    ["Drivers", (state.doc.drivers || []).length, true],
    ["Fetched", state.doc.fetched_at || "—", true],
  ];
  $("session-grid").innerHTML = cells.map(([k, v, mono]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v${mono ? " mono" : ""}">${esc(v)}</div></div>`).join("");
  panel.hidden = false;
}

// ---------------------------------------------------------------------------
// render — incident queue

function decisionOf(id) { return state.decisions[id] || null; }
function decidedCount() {
  return state.incidents.filter((i) => decisionOf(i.id)?.status).length;
}

function typeChipClass(type) {
  return /contact/.test(type) ? "chip type contact" : "chip type";
}

function renderQueue() {
  const grid = $("review-grid");
  if (!state.doc) { grid.hidden = true; return; }
  grid.hidden = false;

  $("progress").textContent = `${decidedCount()} / ${state.incidents.length} reviewed`;

  if (!state.incidents.length) {
    $("queue").innerHTML = `<div class="queue-empty">No events or review-worthy lap flags in this case — clean session.</div>`;
    return;
  }
  $("queue").innerHTML = state.incidents.map((inc) => {
    const d = decisionOf(inc.id);
    const statusChip = d?.status === "decided"
      ? `<span class="chip status-decided">${esc(d.code || "decided")}</span>`
      : d?.status === "dismissed" ? `<span class="chip status-dismissed">dismissed</span>` : "";
    const cars = inc.car_idx.map((c) => {
      const drv = driverByIdx(state.doc, c);
      return drv?.car_number != null ? `#${drv.car_number}` : `car ${c}`;
    }).join(" ");
    const t = formatClock(inc.session_time_s);
    return `<div class="inc${state.selectedId === inc.id ? " selected" : ""}${d?.status ? " done" : ""}" data-id="${esc(inc.id)}">
      <div class="chips">
        <span class="${typeChipClass(inc.type)}">${esc(inc.type.replace(/_/g, " "))}</span>
        ${cars ? `<span class="chip cars">${esc(cars)}</span>` : ""}
        <span class="chip">${inc.lap != null ? "Lap " + inc.lap : "lap ?"}</span>
        <span class="chip time">${t ? esc(t) : "t ?"}</span>
        ${statusChip}
      </div>
      ${inc.description ? `<div class="desc">${esc(inc.description)}</div>` : ""}
    </div>`;
  }).join("");

  for (const el of document.querySelectorAll("#queue .inc")) {
    el.addEventListener("click", () => selectIncident(el.dataset.id));
  }
}

// ---------------------------------------------------------------------------
// render — incident detail

function selectedIncident() {
  return state.incidents.find((i) => i.id === state.selectedId) || null;
}

function selectIncident(id) {
  state.selectedId = id;
  renderQueue();
  renderDetail();
}

function renderDetail() {
  const inc = selectedIncident();
  $("detail-empty").hidden = !!inc;
  $("detail").hidden = !inc;
  if (!inc) return;

  const d = decisionOf(inc.id);
  const carNames = inc.car_idx.map((c) => carLabel(state.doc, c)).join(", ") || "no cars listed";
  $("detail-head").innerHTML = `
    <div class="headline">${esc(inc.type.replace(/_/g, " "))} — ${inc.lap != null ? "Lap " + inc.lap : "lap unknown"}</div>
    <div class="sub">${esc(carNames)}${inc.description ? " · " + esc(inc.description) : ""} · source: ${esc(inc.source)}</div>
    <div class="replay">${esc(formatSessionTime(inc.session_time_s))}${inc.session_time_s != null ? " — jump replay here (estimate)" : ""}</div>`;

  renderPositionChart(inc);
  renderDetailLaps(inc);
  renderDecisionForm(inc, d);
  renderPostPreview(inc);
}

function flagBadge(f) {
  const cls = /contact|black_flag|lost_control/.test(f) ? "bad"
    : /off_track|invalid/.test(f) ? "warn" : "dim";
  return `<span class="badge ${cls}">${esc(f.replace(/_/g, " "))}</span>`;
}

function renderDetailLaps(inc) {
  const around = lapsAround(state.doc, inc, 3);
  if (!around.length) {
    $("detail-laps").innerHTML = `<div class="queue-empty">No per-lap data for the involved cars.</div>`;
    return;
  }
  $("detail-laps").innerHTML = around.map(({ car_idx, laps }) => {
    const drv = driverByIdx(state.doc, car_idx);
    const rows = laps.map((l) => `
      <tr class="${l.lap === inc.lap ? "inc-lap" : ""}">
        <td>${l.lap}</td>
        <td>${l.time_s != null ? l.time_s.toFixed(3) : "—"}</td>
        <td>${l.position ?? "—"}</td>
        <td>${formatClock(l.session_time_s) ?? "—"}</td>
        <td class="flags">${(l.flags || []).map(flagBadge).join("") || ""}</td>
      </tr>`).join("");
    return `<div class="car-block">
      <h4>${esc(carLabel(state.doc, car_idx))}<span class="meta">${esc(drv?.car || "")}${drv?.car_class ? " · " + esc(drv.car_class) : ""}</span></h4>
      <div class="table-scroll"><table class="laps">
        <thead><tr><th>Lap</th><th>Time</th><th>Pos</th><th>Session</th><th>Flags</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }).join("");
}

// lap-position mini-chart: position traces of involved cars around the incident
function renderPositionChart(inc) {
  const canvas = $("pos-chart");
  const legend = $("pos-legend");
  const ctx = canvas.getContext("2d");
  const cssW = canvas.clientWidth || 600;
  const cssH = 150;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const span = 5;
  const series = [];
  if (inc.lap != null) {
    for (const carIdx of inc.car_idx) {
      const drv = driverByIdx(state.doc, carIdx);
      if (!drv || !Array.isArray(drv.laps)) continue;
      const pts = drv.laps
        .filter((l) => l.lap >= inc.lap - span && l.lap <= inc.lap + span && typeof l.position === "number")
        .sort((a, b) => a.lap - b.lap)
        .map((l) => ({ lap: l.lap, pos: l.position }));
      if (pts.length) series.push({ carIdx, pts });
    }
  }
  if (!series.length) {
    ctx.fillStyle = "#5f5f6b";
    ctx.font = "13px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("no position data for the involved cars", cssW / 2, cssH / 2);
    legend.innerHTML = "";
    return;
  }

  const laps = series.flatMap((s) => s.pts.map((p) => p.lap));
  const poss = series.flatMap((s) => s.pts.map((p) => p.pos));
  const minLap = Math.min(...laps), maxLap = Math.max(...laps);
  const minPos = Math.max(1, Math.min(...poss) - 1);
  const maxPos = Math.max(...poss) + 1;
  const pad = { l: 30, r: 12, t: 10, b: 22 };
  const x = (lap) => pad.l + ((lap - minLap) / Math.max(1, maxLap - minLap)) * (cssW - pad.l - pad.r);
  const y = (pos) => pad.t + ((pos - minPos) / Math.max(1, maxPos - minPos)) * (cssH - pad.t - pad.b);

  // grid + axis labels
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.fillStyle = "#5f5f6b";
  ctx.font = "10.5px Consolas, monospace";
  ctx.lineWidth = 1;
  for (let p = minPos; p <= maxPos; p++) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(p) + 0.5); ctx.lineTo(cssW - pad.r, y(p) + 0.5); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(`P${p}`, pad.l - 5, y(p) + 3.5);
  }
  for (let lap = minLap; lap <= maxLap; lap++) {
    ctx.textAlign = "center";
    ctx.fillText(String(lap), x(lap), cssH - 7);
  }

  // incident lap marker
  if (inc.lap >= minLap && inc.lap <= maxLap) {
    ctx.strokeStyle = "rgba(255,184,77,0.55)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(inc.lap) + 0.5, pad.t); ctx.lineTo(x(inc.lap) + 0.5, cssH - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }

  series.forEach((s, i) => {
    const color = CAR_COLORS[i % CAR_COLORS.length];
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath();
    s.pts.forEach((p, j) => { j ? ctx.lineTo(x(p.lap), y(p.pos)) : ctx.moveTo(x(p.lap), y(p.pos)); });
    ctx.stroke();
    for (const p of s.pts) { ctx.beginPath(); ctx.arc(x(p.lap), y(p.pos), 2.6, 0, Math.PI * 2); ctx.fill(); }
  });

  legend.innerHTML = series.map((s, i) =>
    `<span><span class="sw" style="background:${CAR_COLORS[i % CAR_COLORS.length]}"></span>${esc(carLabel(state.doc, s.carIdx))}</span>`
  ).join("") + `<span><span class="sw" style="background:rgba(255,184,77,0.55)"></span>incident lap</span>`;
}

// ---------------------------------------------------------------------------
// decision form

function renderDecisionForm(inc, d) {
  // rubric code picker
  const sel = $("dec-code");
  sel.innerHTML = `<option value="">— no penalty / not selected —</option>` +
    state.rubric.penalties.map((p) =>
      `<option value="${esc(p.code)}">${esc(p.code)} — ${esc(p.label)}</option>`).join("");
  sel.value = d?.code || "";

  $("dec-finding").value = d?.finding || "";
  $("dec-protest").value = d?.protest_ref || "";

  // involved-cars multi-select over the full driver list, incident cars first
  const drivers = [...(state.doc.drivers || [])].sort((a, b) => {
    const ai = inc.car_idx.includes(a.car_idx) ? 0 : 1;
    const bi = inc.car_idx.includes(b.car_idx) ? 0 : 1;
    return ai - bi || (a.finish_pos ?? 99) - (b.finish_pos ?? 99);
  });
  const picked = new Set(d?.cars?.length ? d.cars : inc.car_idx);
  $("dec-cars").innerHTML = drivers.map((drv) =>
    `<label><input type="checkbox" value="${drv.car_idx}" ${picked.has(drv.car_idx) ? "checked" : ""}>
     ${esc(carLabel(state.doc, drv.car_idx))}</label>`).join("");

  const decided = !!d?.status;
  $("btn-decide").textContent = d?.status === "decided" ? "Update decision" : "Save decision";
  $("btn-reopen").hidden = !decided;
}

function formDecision(status) {
  const cars = [...document.querySelectorAll("#dec-cars input:checked")].map((el) => Number(el.value));
  return {
    status,
    finding: $("dec-finding").value.trim(),
    code: status === "dismissed" ? null : ($("dec-code").value || null),
    cars,
    protest_ref: $("dec-protest").value.trim(),
  };
}

$("btn-decide").addEventListener("click", () => {
  const inc = selectedIncident();
  if (!inc) return;
  state.decisions[inc.id] = formDecision("decided");
  saveDecisions();
  renderQueue(); renderDetail();
});

$("btn-dismiss").addEventListener("click", () => {
  const inc = selectedIncident();
  if (!inc) return;
  state.decisions[inc.id] = formDecision("dismissed");
  saveDecisions();
  renderQueue(); renderDetail();
});

$("btn-reopen").addEventListener("click", () => {
  const inc = selectedIncident();
  if (!inc) return;
  delete state.decisions[inc.id];
  saveDecisions();
  renderQueue(); renderDetail();
});

function renderPostPreview(inc) {
  const d = decisionOf(inc.id);
  const box = $("post-preview-box");
  if (!d?.status) { box.hidden = true; return; }
  box.hidden = false;
  $("post-preview").textContent = rulingPost(state.doc, inc, d, state.rubric);
}

$("btn-copy-post").addEventListener("click", () => copyText($("post-preview").textContent, $("btn-copy-post")));

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch {
    alert("Clipboard blocked — select the text and copy manually.");
  }
}

// ---------------------------------------------------------------------------
// rubric tab

function renderRubric() {
  $("rubric-league").value = state.rubric.league || "";
  const tbody = document.querySelector("#rubric-table tbody");
  tbody.innerHTML = state.rubric.penalties.map((p, i) => `
    <tr data-i="${i}">
      <td class="code-col"><input type="text" class="r-code" value="${esc(p.code)}"></td>
      <td><input type="text" class="r-label" value="${esc(p.label)}"></td>
      <td><input type="text" class="r-action" value="${esc(p.action)}"></td>
      <td class="del-col"><button class="del" title="Remove">✕</button></td>
    </tr>`).join("");

  for (const tr of tbody.querySelectorAll("tr")) {
    const i = Number(tr.dataset.i);
    for (const input of tr.querySelectorAll("input")) {
      input.addEventListener("change", () => {
        const p = state.rubric.penalties[i];
        p.code = tr.querySelector(".r-code").value.trim();
        p.label = tr.querySelector(".r-label").value.trim();
        p.action = tr.querySelector(".r-action").value.trim();
        saveRubric(state.rubric);
        rubricStatus("saved");
      });
    }
    tr.querySelector(".del").addEventListener("click", () => {
      state.rubric.penalties.splice(i, 1);
      saveRubric(state.rubric);
      renderRubric();
      rubricStatus("removed");
    });
  }
}

function rubricStatus(msg) {
  $("rubric-status").textContent = msg;
  setTimeout(() => { if ($("rubric-status").textContent === msg) $("rubric-status").textContent = ""; }, 1800);
}

$("rubric-league").addEventListener("change", () => {
  state.rubric.league = $("rubric-league").value.trim();
  saveRubric(state.rubric);
  rubricStatus("saved");
});

$("btn-rubric-add").addEventListener("click", () => {
  state.rubric.penalties.push({ code: "NEW", label: "New infraction", action: "Action" });
  saveRubric(state.rubric);
  renderRubric();
});

$("btn-rubric-reset").addEventListener("click", () => {
  if (!confirm("Replace the current rubric with the built-in endurance defaults?")) return;
  state.rubric = defaultRubric();
  saveRubric(state.rubric);
  renderRubric();
  rubricStatus("reset to defaults");
});

$("btn-rubric-export").addEventListener("click", () => {
  const v = validateRubric(state.rubric);
  if (!v.ok) { rubricStatus(`fix first: ${v.errors[0]}`); return; }
  download("rubric.json", exportRubric(state.rubric));
});

$("btn-rubric-import").addEventListener("click", () => $("rubric-file").click());
$("rubric-file").addEventListener("change", async () => {
  const file = $("rubric-file").files[0];
  $("rubric-file").value = "";
  if (!file) return;
  const r = importRubric(await file.text());
  if (!r.ok) { rubricStatus(`import failed: ${r.errors[0]}`); return; }
  state.rubric = r.rubric;
  saveRubric(state.rubric);
  renderRubric();
  rubricStatus(`imported "${r.rubric.league}"`);
});

// ---------------------------------------------------------------------------
// report tab

function renderReport() {
  const has = !!state.doc;
  $("report-progress").textContent = has ? `${decidedCount()} / ${state.incidents.length} reviewed` : "";
  if (!has) {
    $("report-text").textContent = "Load a case on the Review tab first.";
    $("report-posts").innerHTML = "";
    return;
  }
  $("report-text").textContent = stewardsReport(state.doc, state.incidents, state.decisions, state.rubric);

  const done = state.incidents.filter((i) => decisionOf(i.id)?.status);
  $("report-posts").innerHTML = done.map((inc) => {
    const d = decisionOf(inc.id);
    const who = inc.car_idx.map((c) => carLabel(state.doc, c)).join(", ") || inc.type;
    return `<div class="panel report-post" data-id="${esc(inc.id)}">
      <div class="row">
        <span class="who">${inc.lap != null ? "Lap " + inc.lap : "?"} — ${esc(who)}</span>
        <button class="btn small copy-one">Copy post</button>
      </div>
      <pre class="post">${esc(rulingPost(state.doc, inc, d, state.rubric))}</pre>
    </div>`;
  }).join("");

  for (const el of document.querySelectorAll("#report-posts .copy-one")) {
    el.addEventListener("click", () => {
      copyText(el.closest(".report-post").querySelector("pre").textContent, el);
    });
  }
}

$("btn-copy-report").addEventListener("click", () => copyText($("report-text").textContent, $("btn-copy-report")));

$("btn-export-decisions").addEventListener("click", () => {
  if (!state.doc) return;
  const sid = state.doc.session?.subsession_id;
  download(`decisions-${sid ?? "case"}.json`, exportDecisions(sid, state.decisions));
});

$("btn-import-decisions").addEventListener("click", () => $("decisions-file").click());
$("decisions-file").addEventListener("change", async () => {
  const file = $("decisions-file").files[0];
  $("decisions-file").value = "";
  if (!file || !state.doc) return;
  const r = importDecisions(await file.text());
  const st = $("report-status");
  if (!r.ok) { st.textContent = `import failed: ${r.errors[0]}`; return; }
  const sid = state.doc.session?.subsession_id;
  if (r.subsession_id != null && sid != null && r.subsession_id !== sid) {
    st.textContent = `subsession mismatch (file: ${r.subsession_id}, loaded case: ${sid}) — not imported`;
    return;
  }
  state.decisions = r.decisions;
  saveDecisions();
  st.textContent = `imported ${Object.keys(r.decisions).length} decision(s)`;
  renderAll();
  renderReport();
});

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------

function renderAll() {
  renderSession();
  renderQueue();
  renderDetail();
}

renderRubric();
renderAll();
