// synthetic.js — deterministic sample steward-kit/case@1 fixture, built to
// the SPEC fixture recipe: 2 classes, 6 drivers, 20 laps, contact events,
// and a tow with a discontinuity. Used by the "Load demo case" button and as
// the provisional fixture for the Node test suite (until/alongside agent A's
// python/tests/fixtures/sample_case.json).

import { CASE_FORMAT, deriveSessionTimes } from "./case.js";

// tiny deterministic PRNG (mulberry32) — same case every time, same seed
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROSTER = [
  { car_idx: 3,  cust_id: 100003, name: "A. Vance",    car: "BMW M4 GT3",       car_number: "33", car_class: "GT3", base: 92.4 },
  { car_idx: 7,  cust_id: 100007, name: "R. Okafor",   car: "Ferrari 296 GT3",  car_number: "7",  car_class: "GT3", base: 92.7 },
  { car_idx: 11, cust_id: 100011, name: "M. Castillo", car: "Porsche 992 GT3 R", car_number: "911", car_class: "GT3", base: 93.1 },
  { car_idx: 14, cust_id: 100014, name: "S. Brandt",   car: "Porsche 718 GT4",  car_number: "41", car_class: "GT4", base: 99.2 },
  { car_idx: 18, cust_id: 100018, name: "K. Ellery",   car: "McLaren 570S GT4", car_number: "58", car_class: "GT4", base: 99.6 },
  { car_idx: 22, cust_id: 100022, name: "T. Ngata",    car: "Aston Martin GT4", car_number: "77", car_class: "GT4", base: 100.1 },
];

const N_LAPS = 20;
export const SYNTH_TOW = { car_idx: 11, lap: 9 };            // towed lap: time_s null + discontinuity
export const SYNTH_CONTACT = { lap: 12, cars: [3, 7] };      // grouped car_contact event
export const SYNTH_OFFTRACK = { car_idx: 18, lap: 5 };       // flagged lap NOT covered by events
export const SYNTH_SOLO_CONTACT = { car_idx: 22, lap: 15 };  // wall contact event

export function makeSampleCase() {
  const rand = rng(0x5715);

  // raw lap times per driver (before the tow hole is punched)
  const rawTimes = new Map();
  for (const d of ROSTER) {
    const times = [];
    for (let lap = 1; lap <= N_LAPS; lap++) {
      let t = d.base + (rand() - 0.5) * 1.6 + lap * 0.015; // noise + light wear
      if (lap === 1) t += 4.0;                             // standing start
      if (d.car_idx === SYNTH_CONTACT.cars[0] && lap === SYNTH_CONTACT.lap) t += 6.5;
      if (d.car_idx === SYNTH_CONTACT.cars[1] && lap === SYNTH_CONTACT.lap) t += 9.0;
      if (d.car_idx === SYNTH_OFFTRACK.car_idx && lap === SYNTH_OFFTRACK.lap) t += 3.2;
      if (d.car_idx === SYNTH_SOLO_CONTACT.car_idx && lap === SYNTH_SOLO_CONTACT.lap) t += 11.0;
      if (d.car_idx === SYNTH_TOW.car_idx && lap === SYNTH_TOW.lap) t += 140.0; // the tow (true time, then hidden)
      times.push(Math.round(t * 1000) / 1000);
    }
    rawTimes.set(d.car_idx, times);
  }

  // positions per lap from cumulative *true* time (overall classification)
  const cum = new Map(ROSTER.map((d) => [d.car_idx, 0]));
  const positions = new Map(ROSTER.map((d) => [d.car_idx, []]));
  for (let lap = 1; lap <= N_LAPS; lap++) {
    for (const d of ROSTER) cum.set(d.car_idx, cum.get(d.car_idx) + rawTimes.get(d.car_idx)[lap - 1]);
    const order = [...ROSTER].sort((a, b) => cum.get(a.car_idx) - cum.get(b.car_idx));
    order.forEach((d, i) => positions.get(d.car_idx).push(i + 1));
  }

  const drivers = ROSTER.map((d) => {
    // punch the tow hole: time_s null for the towed lap
    const laps = [];
    for (let lap = 1; lap <= N_LAPS; lap++) {
      const towed = d.car_idx === SYNTH_TOW.car_idx && lap === SYNTH_TOW.lap;
      const flags = [];
      if (towed) flags.push("discontinuity");
      if (d.car_idx === SYNTH_CONTACT.cars[0] && lap === SYNTH_CONTACT.lap) flags.push("car_contact");
      if (d.car_idx === SYNTH_CONTACT.cars[1] && lap === SYNTH_CONTACT.lap) flags.push("car_contact", "lost_control");
      if (d.car_idx === SYNTH_OFFTRACK.car_idx && lap === SYNTH_OFFTRACK.lap) flags.push("off_track");
      if (d.car_idx === SYNTH_SOLO_CONTACT.car_idx && lap === SYNTH_SOLO_CONTACT.lap) flags.push("contact", "off_track");
      laps.push({
        lap,
        time_s: towed ? null : rawTimes.get(d.car_idx)[lap - 1],
        position: positions.get(d.car_idx)[lap - 1],
        flags,
      });
    }
    // session_time_s exactly as the SPEC math produces it (anchor 0 = race start)
    const derived = deriveSessionTimes(laps, 0);
    for (const r of derived) {
      const l = laps.find((x) => x.lap === r.lap);
      l.session_time_s = r.session_time_s;
      if (r.discontinuity && !l.flags.includes("discontinuity")) l.flags.push("discontinuity");
    }
    const finishOrder = [...ROSTER].sort((a, b) => cum.get(a.car_idx) - cum.get(b.car_idx));
    return {
      car_idx: d.car_idx, cust_id: d.cust_id, name: d.name,
      car: d.car, car_number: d.car_number, car_class: d.car_class,
      finish_pos: finishOrder.findIndex((x) => x.car_idx === d.car_idx) + 1,
      laps_complete: N_LAPS,
      incidents: laps.reduce((s, l) => s + (l.flags.some((f) => f !== "discontinuity") ? 1 : 0), 0),
      laps,
    };
  });

  const timeOf = (carIdx, lap) =>
    drivers.find((x) => x.car_idx === carIdx).laps.find((l) => l.lap === lap).session_time_s;

  const events = [
    {
      type: "car_contact",
      session_time_s: timeOf(SYNTH_CONTACT.cars[0], SYNTH_CONTACT.lap),
      lap: SYNTH_CONTACT.lap,
      car_idx: [...SYNTH_CONTACT.cars],
      description: "Car-to-car contact between #33 and #7 in the braking zone",
      source: "derived",
    },
    {
      type: "contact",
      session_time_s: timeOf(SYNTH_SOLO_CONTACT.car_idx, SYNTH_SOLO_CONTACT.lap),
      lap: SYNTH_SOLO_CONTACT.lap,
      car_idx: [SYNTH_SOLO_CONTACT.car_idx],
      description: "#77 contact with the wall, rejoined",
      source: "derived",
    },
    // note: the off_track on #58 lap 5 is deliberately NOT covered by an
    // event — the review queue must pick it up from lap flags.
  ];

  return {
    format: CASE_FORMAT,
    fetched_at: "2026-07-01T18:00:00Z",
    session: {
      subsession_id: 71234567,
      session_name: "OpMo Endurance Round 4",
      league_name: "Operation Motorsport eMotorsport League",
      track: "Road Atlanta",
      config: "Full Course",
      start_time: "2026-06-28T19:00:00Z",
      simulated_start: "14:00",
      session_types: ["PRACTICE", "QUALIFY", "RACE"],
    },
    drivers,
    events,
  };
}
