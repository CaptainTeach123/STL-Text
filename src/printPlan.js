// The print plan: about how much plastic and time a piece and the whole job take, and a few suggestions for the
// slicer. Plain numbers only – no Manifold, no three.js – so the engine (for the sheet in the zip) and the page (for
// the pieces list) work it out with the same code and cannot disagree. Every figure is an estimate: weights and
// lengths are given as a range, and the time only very roughly. The slicer's own figures are the real ones.

import { PRINT_CHECK, areaWords } from './printCheck.js';

/**
 * The materials to choose from: the name shown, the density in g/cm³, and how fast it is usually printed next to
 * PLA (`pace`: a soft filament is fed slowly).
 */
export const MATERIALS = Object.freeze({
  pla: Object.freeze({ name: 'PLA', density: 1.24, pace: 1 }),
  petg: Object.freeze({ name: 'PETG', density: 1.27, pace: 0.8 }),
  abs: Object.freeze({ name: 'ABS / ASA', density: 1.05, pace: 1 }),
  tpu: Object.freeze({ name: 'TPU', density: 1.21, pace: 0.4 }),
});

/** What the plan is worked out for until the user says otherwise. */
export const PLAN_DEFAULTS = Object.freeze({ material: 'pla', infill: 15 });

/**
 * The rules of the plan, in one place.
 * - `walls`: how many walls the estimate takes a slicer to print: its usual default. Not a setting.
 * - `line`: a printed line is this many times as wide as the nozzle.
 * - `filament`: the filament's diameter, mm.
 * - `low`, `high`: the weight and the length are given from `low` to `high` times what the sum comes to: a slicer's
 *   top and bottom are a little thicker than its walls, corners overlap, and its infill is never exactly the share
 *   asked for. The top of the range is never more than the solid itself: no print holds more plastic than that.
 * - `speed`, `speedFast`: how fast a printer lays its lines, mm a second, at its slowest and fastest taken over a
 *   whole print (corners, small moves and first layers included): an ordinary printer, and a fast one. The plastic
 *   it lays down a second is a line's width times the layer height times this – so finer layers and a smaller
 *   nozzle take longer, as they do on a printer. Rules of thumb, not measured – which is why the time is said only
 *   very roughly.
 * - `melt`, `meltFast`: the most plastic the hot end melts, mm³ a second, at the two ends of the band: however wide
 *   the nozzle and thick the layers, a printer lays down no more.
 * - `layerTime`: the seconds every layer costs besides (moves, a seam, cooling), least and most.
 * - `walled`: a piece whose skin is this share of it or more is mostly walls, and the infill changes it little.
 * - `pegWalls`: the most walls suggested for built-in pegs: more would make the whole piece much heavier.
 * - `days`: a time of this many hours or more at the least is said in days.
 * - `spool`: a spool of filament, g.
 */
export const PRINT_PLAN = Object.freeze({
  walls: 2,
  line: 1.05,
  filament: 1.75,
  low: 0.9,
  high: 1.15,
  speed: Object.freeze([30, 60]),
  speedFast: Object.freeze([75, 165]),
  melt: Object.freeze([8, 11]),
  meltFast: Object.freeze([20, 28]),
  layerTime: Object.freeze([1, 4]),
  walled: 0.85,
  pegWalls: 4,
  days: 48,
  spool: 1000,
});

/**
 * What a plan is worked out for, made whole: the material by its key (an unknown one is PLA), the infill within
 * 0–100 %, the nozzle and the layer height, and whether the printer is a fast one.
 * @param {{ material?: string, infill?: number, nozzle?: number, layerHeight?: number, fast?: boolean }} [given]
 * @returns {{ material: string, name: string, density: number, pace: number, infill: number, walls: number,
 *   nozzle: number, layer: number, fast: boolean }}
 */
export function planOptions(given = {}) {
  const material = Object.hasOwn(MATERIALS, given?.material) ? given.material : PLAN_DEFAULTS.material;
  const infill = Number.isFinite(given?.infill) ? Math.min(100, Math.max(0, Math.round(given.infill))) : PLAN_DEFAULTS.infill;
  return {
    material,
    ...MATERIALS[material],
    infill,
    walls: PRINT_PLAN.walls,
    nozzle: given?.nozzle > 0 ? given.nozzle : 0.4,
    layer: given?.layerHeight > 0 ? given.layerHeight : 0.2,
    fast: Boolean(given?.fast),
  };
}

/**
 * How much plastic the plan's printer lays down, mm³ a second, at the slow and the quick end of its band: a line as
 * wide as the nozzle makes it and as thick as a layer, drawn at the printer's speed – and never more than its hot
 * end melts – slowed for a material that is printed slowly.
 * @param {object} o from `planOptions`
 * @returns {number[]} [slow, quick]
 */
export function flowOf(o) {
  const speed = o.fast ? PRINT_PLAN.speedFast : PRINT_PLAN.speed;
  const melt = o.fast ? PRINT_PLAN.meltFast : PRINT_PLAN.melt;
  const bead = PRINT_PLAN.line * o.nozzle * o.layer;
  return speed.map((v, i) => Math.min(bead * v, melt[i]) * o.pace);
}

/**
 * From so much plastic (mm³) in so many layers: its weight, its length of filament and its time, each as a range.
 * `solid` is the volume of the solid itself: the top of the range is never more than that.
 */
function fromPlastic(plastic, layers, o, solid) {
  const { low, high, filament, layerTime } = PRINT_PLAN;
  const [slow, quick] = flowOf(o);
  const strand = Math.PI * (filament / 2) ** 2;
  const ends = [low * plastic, Math.min(high * plastic, solid)];
  return {
    plastic,
    grams: ends.map((v) => (v * o.density) / 1000),
    metres: ends.map((v) => v / strand / 1000),
    hours: [ends[0] / quick + layers * layerTime[0], ends[1] / slow + layers * layerTime[1]].map((s) => s / 3600),
  };
}

/**
 * About how much plastic and time one solid takes, printed with the plan's walls and infill. The file is a solid
 * model; the slicer prints a skin round it – walls at the sides, as thick again at top and bottom – and fills the
 * rest with a light pattern. So the plastic is the skin (the surface times its thickness, and never more than the
 * solid itself) plus the infill's share of what is inside.
 * @param {{ volume: number, area?: number|null, height?: number }} solid mm³, mm² and mm as it prints; without an
 *   `area` the solid is counted as printed solid, which is the most it can weigh (`atMost`)
 * @param {object} o from `planOptions`
 * @returns {{ plastic: number, grams: number[], metres: number[], hours: number[], atMost?: boolean, skin?: number }|null}
 *   null for a solid with no volume to speak of; `skin` the share of the solid that is its skin, 0–1
 */
export function estimatePiece(solid, o) {
  const volume = solid?.volume;
  if (!(volume > 0)) return null;
  const layers = Math.ceil(Math.max(0, solid.height ?? 0) / o.layer);
  if (!(solid.area > 0)) return { ...fromPlastic(volume, layers, o, volume), atMost: true };
  const skin = Math.min(volume, solid.area * o.walls * PRINT_PLAN.line * o.nozzle);
  return { ...fromPlastic(skin + (o.infill / 100) * (volume - skin), layers, o, volume), skin: skin / volume };
}

/** The same for something printed solid: pins. */
export function estimateSolid(volume, height, o) {
  return volume > 0 ? fromPlastic(volume, Math.ceil(Math.max(0, height) / o.layer), o, volume) : null;
}

const add = (p, q) => [p[0] + q[0], p[1] + q[1]];

/**
 * The plan of a whole job: every piece, the printed pins and the separately printed parts, and all of them together.
 * @param {{ pieces?: object[], pins?: object[], parts?: object[] }} job `pieces` the piece rows of a split (index,
 *   size as laid, volume, area, unrepaired); `pins` its pin groups (d, length, count, spares, own, volume of one
 *   pin, and `strip`: the volume of the strips that hold them to the bed, when they get them); `parts` the parts printed separately (name, volume, area, height)
 * @param {object} o from `planOptions`
 * @param {number[]|null} [bed] the room on the bed, mm [x, y]
 * @returns {{ pieces: { index: number, estimate: object|null, unrepaired: boolean }[],
 *   pins: { count: number, estimate: object, strip: boolean }|null, parts: { name: string, estimate: object|null }[],
 *   total: { grams: number[], metres: number[], hours: number[] }, counted: number, left: number, unrepaired: boolean,
 *   tallest: { index: number, height: number }|null, widest: { index: number, size: number[] }|null, beds: number|null }}
 *   `left` how many pieces and parts could not be measured and are not in the total; `beds` how many times the bed
 *   the pieces' outlines cover, laid side by side
 */
export function estimateJob({ pieces = [], pins = [], parts = [] } = {}, o, bed = null) {
  const rows = pieces.map((p) => ({
    index: p.index,
    estimate: estimatePiece({ volume: p.volume, area: p.area, height: p.size?.[2] ?? 0 }, o),
    unrepaired: p.unrepaired > 0,
  }));
  const printed = pins.filter((g) => !g.own && g.volume > 0 && g.count > 0);
  const pinCount = printed.reduce((n, g) => n + g.count + (g.spares ?? 0), 0);
  const pinEstimates = printed.map((g) => estimateSolid(g.volume * (g.count + (g.spares ?? 0)) + (g.strip > 0 ? g.strip : 0), g.d, o));
  const pinRow = printed.length
    ? { count: pinCount, strip: printed.some((g) => g.strip > 0), estimate: pinEstimates.reduce((sum, e) => ({ plastic: sum.plastic + e.plastic, grams: add(sum.grams, e.grams), metres: add(sum.metres, e.metres), hours: add(sum.hours, e.hours) })) }
    : null;
  const partRows = parts.map((p) => ({ name: p.name, estimate: estimatePiece(p, o) }));
  const all = [...rows, ...partRows, ...(pinRow ? [pinRow] : [])].map((r) => r.estimate);
  const known = all.filter(Boolean);
  const total = known.reduce((sum, e) => ({ grams: add(sum.grams, e.grams), metres: add(sum.metres, e.metres), hours: add(sum.hours, e.hours) }), { grams: [0, 0], metres: [0, 0], hours: [0, 0] });
  const sized = pieces.filter((p) => p.size);
  const tallest = sized.reduce((best, p) => (!best || p.size[2] > best.size[2] ? p : best), null);
  const widest = sized.reduce((best, p) => (!best || p.size[0] * p.size[1] > best.size[0] * best.size[1] ? p : best), null);
  const room = bed && bed[0] > 0 && bed[1] > 0 ? bed[0] * bed[1] : 0;
  return {
    pieces: rows,
    pins: pinRow,
    parts: partRows,
    total,
    counted: known.length,
    left: all.length - known.length,
    unrepaired: rows.some((r) => r.unrepaired),
    tallest: tallest ? { index: tallest.index, height: tallest.size[2] } : null,
    widest: widest ? { index: widest.index, size: [widest.size[0], widest.size[1]] } : null,
    beds: room && sized.length ? sized.reduce((sum, p) => sum + p.size[0] * p.size[1], 0) / room : null,
  };
}

/* ------------------------------------------------------------------ words */

/** A number to two figures, as it is said: 38, 480, 1.2. */
const two = (v) => String(Number(v.toPrecision(2)));
/** A range to two figures: "38–48", or "5" where both ends round to the same. */
const span = (lo, hi) => (two(lo) === two(hi) ? two(hi) : `${two(lo)}–${two(hi)}`);
const whole = (v) => String(Math.round(v));

/** A weight as a range: "about 38–48 g", "about 1.1–1.4 kg", "under 1 g". */
export function gramsWords([lo, hi]) {
  if (hi < 1) return 'under 1 g';
  return hi >= 1000 ? `about ${span(lo / 1000, hi / 1000)} kg` : `about ${span(Math.max(lo, 0.1), hi)} g`;
}

/** A length of filament as a range: "about 13–16 m", "under 1 m". */
export function metresWords([lo, hi]) {
  return hi < 1 ? 'under 1 m' : `about ${span(Math.max(lo, 0.1), hi)} m`;
}

/**
 * A time, said only very roughly and in whole hours: "very roughly 1–3 hours", "very roughly up to 2 hours",
 * "under an hour". A long one is said in whole days of printing, to two figures: "very roughly 4–11 days".
 */
export function hoursWords([lo, hi]) {
  if (Math.ceil(hi - 1e-9) <= 1) return 'under an hour';
  const [per, unit] = lo >= PRINT_PLAN.days ? [24, 'days'] : [1, 'hours'];
  const most = Number(Math.ceil(hi / per - 1e-9).toPrecision(2));
  const least = Math.min(most, Number(Math.floor(lo / per + 1e-9).toPrecision(2)));
  if (least < 1) return `very roughly up to ${most} ${unit}`;
  return least === most ? `very roughly ${most} ${unit}` : `very roughly ${least}–${most} ${unit}`;
}

/** A share to the nearest 5 %: "about 45 %", and "under 5 %" for one too small to round to that. */
const shareWords = (share) => (share < 0.025 ? 'under 5 %' : `about ${Math.round(share * 20) * 5} %`);

/**
 * How much of a spool a weight is, from the middle of its range: "about 45 % of a 1 kg spool", "under 5 % of a 1 kg
 * spool", "about 1 spool of 1 kg", "about 1.3 spools of 1 kg".
 */
export function spoolWords([lo, hi]) {
  const share = (lo + hi) / 2 / PRINT_PLAN.spool;
  if (share < 0.975) return `${shareWords(share)} of a 1 kg spool`;
  return share < 1.05 ? 'about 1 spool of 1 kg' : `about ${share.toFixed(1)} spools of 1 kg`;
}

/** One solid's estimate in a few clauses: its weight, its filament and its time. */
export function estimateWords(estimate) {
  if (!estimate) return [];
  // the top of the range of a solid counted solid is the solid's own weight
  if (estimate.atMost) return [`at most ${gramsWords([estimate.grams[1], estimate.grams[1]]).replace(/^about /, '')}, printed solid`];
  return [gramsWords(estimate.grams), `${metresWords(estimate.metres)} of filament`, hoursWords(estimate.hours)];
}

/** What the estimate is worked out for: "PLA, 15 % infill, 2 walls, 0.2 mm layers, 0.4 mm nozzle". */
export const settingsWords = (o) => `${o.name}, ${o.infill} % infill, ${o.walls} walls, ${o.layer} mm layers, ${o.nozzle} mm nozzle`;

/** That the files are solid and the slicer is what makes the print mostly hollow. */
export const SOLID_WORDS = 'The files are solid models. Your slicer prints them mostly hollow: a few walls outside and a light pattern (the infill) inside.';

/** What no estimate counts, and whose figures to trust. */
const NOT_COUNTED = "Not counted: supports, a brim, and waste from colour changes. Your slicer's figures are the real ones.";

const paceWords = (o) => `The time is for ${o.fast ? 'a fast printer' : 'an ordinary printer'}${o.pace < 1 ? `, slowed for ${o.name}` : ''}, and is the least sure of these figures.`;

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mm = (v) => String(Math.round(v));

/** "1", "1 and 2", "1, 2 and 3". */
function listOf(items) {
  const all = items.map(String);
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0] ?? '';
}
/** "Piece 3", "Pieces 3 and 8": the pieces by their numbers, in order. */
const piecesWords = (indices) => `${indices.length === 1 ? 'Piece' : 'Pieces'} ${listOf([...indices].sort((p, q) => p - q))}`;

/**
 * The whole job in a few sentences: what it weighs and takes, the tallest piece and the room on the bed, and what
 * the figures assume and leave out.
 * @param {object} job from `estimateJob`
 * @param {object} o from `planOptions`
 * @returns {string[]} empty when nothing could be measured
 */
export function jobWords(job, o) {
  if (!job.counted) return [];
  const things = [count(job.pieces.length, 'piece'), job.pins ? count(job.pins.count, 'pin') : '', job.parts.length ? count(job.parts.length, 'separate part') : ''].filter(Boolean);
  const out = [
    `Whole job (${listOf(things)}): ${gramsWords(job.total.grams)} of ${o.name}, ${metresWords(job.total.metres)} of filament (${spoolWords(job.total.grams)}), ${hoursWords(job.total.hours)} of printing in all.`,
  ];
  const room = [];
  if (job.tallest) room.push(`Tallest piece: ${mm(job.tallest.height)} mm${job.pieces.length > 1 ? ` (piece ${job.tallest.index})` : ''}.`);
  if (job.widest) room.push(`Largest on the bed: ${job.widest.size.map(mm).join(' × ')} mm${job.pieces.length > 1 ? ` (piece ${job.widest.index})` : ''}.`);
  if (job.beds != null && job.pieces.length > 1) {
    room.push(job.beds >= 1.05 ? `Side by side the pieces would cover about ${job.beds.toFixed(1)} times your bed.` : `Side by side the pieces would cover ${shareWords(job.beds)} of your bed.`);
  }
  if (room.length) out.push(room.join(' '));
  if (job.left) out.push(`${count(job.left, 'file')} could not be measured and ${job.left === 1 ? 'is' : 'are'} left out.`);
  if (job.unrepaired) out.push('The parts of the model that could not be repaired are left out.');
  out.push(`Worked out for ${settingsWords(o)}. ${paceWords(o)}`);
  out.push(NOT_COUNTED);
  return out;
}

/**
 * The estimate of a model printed whole, in a sentence or two; '' when it has no solid to measure.
 * @param {{ volume: number, area: number, size: number[], partial?: boolean }|null} measure the model as the engine
 *   measured it; `partial` where some of it could not be repaired and is not counted
 * @param {object} o from `planOptions`
 * @param {{ name: string, volume: number, area: number, height: number }[]} [parts] its separately printed parts
 */
export function wholeWords(measure, o, parts = []) {
  const estimate = measure ? estimatePiece({ volume: measure.volume, area: measure.area, height: measure.size?.[2] ?? 0 }, o) : null;
  if (!estimate) return '';
  const extra = parts.map((p) => estimatePiece(p, o)).filter(Boolean);
  const all = extra.reduce((sum, e) => ({ grams: add(sum.grams, e.grams), metres: add(sum.metres, e.metres), hours: add(sum.hours, e.hours) }), estimate);
  return [
    `Print estimate (${settingsWords(o)}): ${gramsWords(all.grams)}, ${metresWords(all.metres)} of filament, ${hoursWords(all.hours)}; ${mm(measure.size[2])} mm tall.`,
    extra.length ? `Its ${count(extra.length, 'separate part')} ${extra.length === 1 ? 'is' : 'are'} counted in.` : '',
    measure.partial ? 'The parts that could not be repaired are left out.' : '',
    NOT_COUNTED,
  ].filter(Boolean).join(' ');
}

/**
 * A few suggestions for the slicer, each a sentence: the walls and infill that are plenty, the pieces that are
 * mostly walls anyway, the pegs that more walls make stronger, the pieces that want a brim and those that may need
 * supports – the last two from the print check of each piece (printCheck.js), so the plan and the piece's own line
 * say the same. Suggestions only: nothing here changes a file.
 * @param {object[]} pieces the piece rows of a split (index, size, volume, area, pegs, dowels, sockets, lips, check)
 * @param {object} o from `planOptions`
 * @param {{ pins?: object[], pegSize?: number|null, clearance?: number|null }} [more] the pin groups, for the line
 *   about printing them; the size of the built-in pegs, mm; the split's Clearance, mm
 * @returns {string[]}
 */
export function adviseJob(pieces, o, { pins = [], pegSize = null, clearance = null } = {}) {
  const out = [
    `For a model that sits on a shelf, ${o.walls} walls and 10–15 % infill is plenty: more infill adds weight and time, and little strength. For one that will be handled a lot, 3 walls does more than extra infill.`,
  ];
  const of = (test) => pieces.filter(test).map((p) => p.index);
  const they = (list, one, many) => (list.length === 1 ? one : many);

  // mostly walls: by the skin's share of the piece, as the estimate itself counts it – so it follows the nozzle
  const walled = of((p) => (estimatePiece({ volume: p.volume, area: p.area }, o)?.skin ?? 0) >= PRINT_PLAN.walled);
  if (walled.length) out.push(`${piecesWords(walled)} ${they(walled, 'is', 'are')} mostly walls, so the infill changes ${they(walled, 'its', 'their')} weight little.`);

  const pegged = of((p) => p.pegs > 0);
  if (pegged.length && pegSize > 0) {
    const solid = Math.ceil(pegSize / 2 / (PRINT_PLAN.line * o.nozzle) - 1e-9);
    if (solid > o.walls) {
      const walls = Math.min(solid, PRINT_PLAN.pegWalls);
      const there = they(pegged, 'that piece', 'those pieces');
      out.push(
        `${piecesWords(pegged)} ${they(pegged, 'carries', 'carry')} built-in pegs ${Number(pegSize.toFixed(1))} mm across: ` +
        (solid <= PRINT_PLAN.pegWalls ? `with ${walls} walls on ${there} the pegs print solid, which makes them stronger.` : `${walls} walls on ${there} makes the pegs stronger.`) +
        ` Walls are set for a whole piece, so ${they(pegged, 'it comes', 'they come')} out a little heavier and slower than the estimate says.`,
      );
    }
  }

  // a piece's foot, as its print check found it: the brim its line asks for
  const brims = new Map();
  for (const p of pieces) {
    const brim = p.check?.foot.flat ? p.check.foot.brim : 0;
    if (brim > 0) brims.set(brim, [...(brims.get(brim) ?? []), p.index]);
  }
  for (const [brim, list] of [...brims].sort((p, q) => p[0] - q[0])) {
    out.push(`${piecesWords(list)}: add a brim about ${brim} mm wide – ${they(list, 'it stands', 'they stand')} on little and may come loose.`);
  }

  // supports, by the same figure as each piece's line: where they would stand says which kind is enough
  const checked = pieces.filter((p) => p.check);
  const needing = checked.filter((p) => p.check.supports.area >= PRINT_CHECK.none);
  const onBed = needing.filter((p) => p.check.supports.piece < 0.1 * p.check.supports.area);
  const onPiece = needing.filter((p) => !onBed.includes(p));
  const about = (list) => areaWords(list.reduce((sum, p) => sum + p.check.supports.area, 0));
  if (onBed.length) out.push(`${piecesWords(onBed.map((p) => p.index))} may need supports (${about(onBed)} of faces in all): supports "on the build plate only" should be enough.`);
  if (onPiece.length) out.push(`${piecesWords(onPiece.map((p) => p.index))} may need supports (${about(onPiece)} of faces in all), some standing on the piece itself: allow them everywhere on ${they(onPiece, 'that piece', 'those pieces')}.`);
  if (checked.length && checked.length === pieces.length) {
    // what the check found, not a fact about the shape: small patches and short level spans are left out of it
    const spans = checked.some((p) => p.check.supports.span > 0);
    if (!needing.length) out.push(`The print check found nothing that needs supports, so they can be left off.${spans ? ' Level spans are left to bridging, as the lines of the pieces say.' : ''}`);
    else if (needing.length < pieces.length) out.push(`The other ${they(pieces.filter((p) => !needing.includes(p)), 'piece', 'pieces')} should print without supports.`);
  }

  if (pins.some((g) => !g.own && g.count > 0)) out.push('Pins: print them solid – 4 or more walls, or 100 % infill – lying as their file lies.');

  const jointed = pieces.some((p) => p.dowels > 0 || p.pegs > 0 || p.sockets > 0 || p.lips?.length > 0);
  // PETG: only where the Clearance set is less than it wants (or is not known)
  if (o.material === 'petg' && jointed && !(clearance >= 0.2 - 1e-9)) {
    out.push(`PETG wants a little more room in the joints than PLA: a Clearance of at least 0.20 mm${clearance != null && clearance >= 0 ? `, where this split has ${clearance.toFixed(2)}` : ', where PLA takes 0.15'}.`);
  }
  if (o.material === 'abs') out.push('ABS and ASA shrink as they cool, so big flat pieces may lift at the corners: a closed printer and a brim help.');
  if (o.material === 'tpu') out.push(`TPU is soft${jointed ? ': pins, pegs and clips made of it bend rather than hold, so it suits a model printed in one piece better' : ''}. It prints slowly, which the time above allows for.`);
  return out;
}

const pad = (s, n) => (s.length >= n ? `${s} ` : s.padEnd(n));

/**
 * The PRINT PLAN block of the sheet in the zip: a line a piece, the pins and the parts, the whole job, and the
 * suggestions. Plain text, to be read in any editor.
 * The suggestion to print the pins solid is the one left out: the sheet's own pins line, in the PRINT list just above
 * this block, already says so ("lying on a flat side, solid (4+ walls)"), and the block's pins row says it again.
 * @param {{ pieces?: object[], pins?: object[], parts?: object[], pegSize?: number|null, clearance?: number|null }} job
 *   as `estimateJob` takes it, with the size of the built-in pegs and the split's Clearance for the suggestions
 * @param {object} given what the plan is for, as `planOptions` takes it
 * @param {number[]|null} [bed] the room on the bed, mm
 * @returns {string[]} the block's lines, without a blank line after; empty when nothing could be measured
 */
export function planSheetLines(job, given, bed = null) {
  const o = planOptions(given);
  const plan = estimateJob(job, o, bed);
  if (!plan.counted) return [];
  const n = plan.pieces.length;
  const out = ['PRINT PLAN (estimates only)', `  ${SOLID_WORDS}`];
  const line = (name, estimate, more = '') => {
    const words = estimateWords(estimate);
    out.push(`  ${pad(name, 15)}${words.length ? words.map((w, i) => (i < words.length - 1 ? pad(w, i ? 28 : 18) : w)).join('') : 'not measured'}${more}`);
  };
  for (const r of [...plan.pieces].sort((p, q) => p.index - q.index)) line(`piece ${r.index} of ${n}`, r.estimate);
  if (plan.pins) out.push(`  ${pad('pins', 15)}${gramsWords(plan.pins.estimate.grams)} for ${count(plan.pins.count, 'pin')}${plan.pins.strip ? ' and their holding strip' : ''}, printed solid`);
  plan.parts.forEach((p, i) => line(`part ${i + 1}`, p.estimate));
  const [total, ...rest] = jobWords(plan, o);
  out.push(`  ${total.replace(/^Whole job/, 'WHOLE JOB')}`);
  for (const sentence of rest) out.push(`  ${sentence}`);
  out.push('  Suggestions for your slicer:');
  for (const advice of adviseJob(job.pieces ?? [], o, { pegSize: job.pegSize ?? null, clearance: job.clearance ?? null })) out.push(`  - ${advice}`);
  return out;
}
