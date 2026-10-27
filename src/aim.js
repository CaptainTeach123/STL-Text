/**
 * Placing a cut that comes apart from the view: what the readout beside the
 * pointer says, the colour the model's section takes, what a suggestion's
 * button reads and the targets a cut snaps to – all from the engine's answers
 * (`split.plan` modes 'probe', 'spots' and 'targets'), with no page or scene,
 * so they can be tested on their own.
 */
import { LIP, seamWords } from './split.js';
import { TEA_LIGHT, offerPercent, roundAngle, roundLift, roundOpening, roundZ, scalePercent, slideWords } from './locks.js';

const AXIS_NAMES = ['X', 'Y', 'Z'];

/** How a hold says its clips hold the top, in the readout and the suggestions: "locks with 4 clips". */
const HELD = Object.freeze({ lock: 'locks', snap: 'clicks on', light: 'clicks on lightly' });

/** Snapping reaches this many pixels on screen, and never more than `SNAP_MAX` mm (looking along the axis, a pixel is any height). */
export const SNAP_PX = 12;
export const SNAP_MAX = 10;

/** A length as the readout shows it: to 0.1 mm, without a trailing ".0" ("190.5", "101"). */
export const mm = (v) => String(Math.round(v * 10) / 10);

/**
 * What the lip found at a place means for the outline: 'full' where a full
 * lip with clips fits – or the twist-lock in their place, on a round wall,
 * with a lip or none – (or a full one, on a hold that has no clips),
 * 'short' where only a shorter or clipless one does, 'none' where no lip
 * does.
 * @param {{ lip: { H: number, clips: number, twist?: object }|null }|null} probe the engine's answer (mode 'probe')
 * @param {string} hold the cut's hold: 'lock', 'snap', 'light' or 'lift'
 */
export function lipVerdict(probe, hold) {
  const lip = probe?.lip;
  // the twist-lock holds where no lip would fit at all, too (a cut through a round lantern's eave)
  if (lip?.twist && hold !== 'lift') return 'full';
  if (!lip || !(lip.H > 0)) return 'none';
  // a tongue in short stretches holds less than a whole one
  if (lip.broken) return 'short';
  return lip.H >= LIP.heights[0] && (lip.clips > 0 || hold === 'lift') ? 'full' : 'short';
}

/**
 * The collar twist-lock a cut takes in place of clips, in a few words: "twist-lock, 3 lugs, 6 clicks – turn 10°".
 * @param {{ theta: number, tabs: number }} twist the probe's `lip.twist`
 */
export function twistWords(twist) {
  return `twist-lock, 3 lugs, ${twist.tabs} ${twist.tabs === 1 ? 'click' : 'clicks'} – turn ${Math.round(twist.theta)}°`;
}

/** Where to move a cut for a better lip: "move down to 190.5" along Z, "move to 12.5" across. */
function moveWords(axis, at, to) {
  if (axis !== 2) return `move to ${mm(to)}`;
  return `move ${to < at ? 'down' : 'up'} to ${mm(to)}`;
}

/**
 * The piece that comes off at a cut, in a few words: "top 101 mm comes off"
 * along Z, "55 mm on the +X side comes off" across; empty when nothing does
 * (the cut is not in the model).
 * @param {number} axis 0, 1 or 2
 * @param {{ side: -1|1, length: number }|null} off the probe's `comesOff`
 */
export function offWords(axis, off) {
  if (!off) return '';
  if (axis === 2) return `${off.side > 0 ? 'top' : 'bottom'} ${mm(off.length)} mm comes off`;
  return `${mm(off.length)} mm on the ${off.side > 0 ? '+' : '−'}${AXIS_NAMES[axis]} side comes off`;
}

/**
 * Why a cut has no lip, in the readout's words: a face too small for one is
 * the windows' posts or a handle's legs where it runs through several parts
 * ("cuts through 8 small parts"), and a spike's tip or a handle's top where
 * it runs through one – never "openings" the shape may not have.
 * @param {object} probe the engine's answer (mode 'probe')
 */
function noLipWords(probe) {
  if (probe.noLip === 'small') return probe.islands > 1 ? `cuts through ${probe.islands} small parts – no room for a lip` : 'face too small for a lip';
  return { miss: 'misses the model', thin: 'walls too thin for a lip', room: 'no room for a lip' }[probe.noLip] ?? 'no lip';
}

/**
 * The lip a cut would get, as the readout says it: "locks with 4 clips",
 * "4.5 mm lip without clips – lifts off – move down to 190.5 for clips", "no
 * room for a lip – move down to 190.5" (the move where the layout gives the
 * cut a full lip). A move is said to be for clips only where the lip there
 * has them (`suggestedLip`): on a round wall, where no clip fits, it is for
 * the twist-lock the cut takes there instead, or for a taller lip. Where
 * the cut takes the twist-lock, that is what it gets, whatever the hold
 * that asked for clips: "twist-lock, 3 lugs, 6 clicks – turn 10°". A lip
 * whose tongue comes in short stretches says so, and the half step where it
 * is whole: "6 mm lip in short stretches, no clips – lifts off – move up to
 * 125.5, where it is whole".
 * @param {object} probe the engine's answer (mode 'probe')
 * @param {string} hold
 * @param {number} axis
 */
export function lipWords(probe, hold, axis) {
  if (!probe) return '';
  const lip = probe.lip;
  const move = Number.isFinite(probe.suggestedAt) ? moveWords(axis, probe.at, probe.suggestedAt) : '';
  if (lip?.twist && hold !== 'lift') return twistWords(lip.twist);
  if (!lip || !(lip.H > 0)) {
    const why = noLipWords(probe);
    return move ? `${why} – ${move}` : why;
  }
  // a tongue in short stretches (an opening's edge in its foot cuts it): said so, and the half step where it is whole
  if (lip.broken) {
    const whole = move ? ` – ${move}, where it is whole` : '';
    if (hold === 'lift') return `${mm(lip.H)} mm lip in short stretches – lifts off${whole}`;
    if (lip.clips > 0) return `${HELD[hold] ?? HELD.snap} with ${lip.clips} ${lip.clips === 1 ? 'clip' : 'clips'} – its lip in short stretches${whole}`;
    return `${mm(lip.H)} mm lip in short stretches, no clips – lifts off${whole}`;
  }
  const full = lip.H >= LIP.heights[0];
  if (hold === 'lift') return full ? `${mm(lip.H)} mm lip – lifts off` : `${mm(lip.H)} mm lip – lifts off${move ? ` – ${move} for a full one` : ''}`;
  if (lip.clips > 0) return `${HELD[hold] ?? HELD.snap} with ${lip.clips} ${lip.clips === 1 ? 'clip' : 'clips'}`;
  const bare = `${mm(lip.H)} mm lip without clips – lifts off`;
  if (!move) return bare;
  const there = probe.suggestedLip;
  if (there?.twist) return `${bare} – ${move} for a twist-lock`;
  return there && !(there.clips > 0) ? `${bare} – ${move} for a ${mm(there.H)} mm lip` : `${bare} – ${move} for clips`;
}

/** The letters a cut runs through, by the names the page gives them: "through “LIGHT”", empty for none. */
export const throughWords = (names = []) => (names.length ? `through ${names.map((n) => `“${n}”`).join(', ')}` : '');

/**
 * What the engine found at a place for a cut that comes apart: "locks with 4
 * clips · top 101 mm comes off", or "no room for a lip – move down to 190.5"
 * (what comes off is only said where it has a lip to sit on).
 * @param {number} axis
 * @param {object} probe the engine's answer for the place
 * @param {string} hold
 */
export function lipLine(axis, probe, hold) {
  const off = lipVerdict(probe, hold) !== 'none' ? offWords(axis, probe.comesOff) : '';
  return [lipWords(probe, hold, axis), off].filter(Boolean).join(' · ');
}

/**
 * The readout's first line for a cut placed at `at`: "Z 190.5 mm · locks
 * with 4 clips · top 101 mm comes off", "Z 196 mm · no room for a lip – move
 * down to 190.5"; just "Z 190.5 mm" until the engine has answered, or for a
 * glued cut (no probe). It names the letters the cut would run through
 * (`through`, the names of the probe's `crosses`).
 * @param {number} axis
 * @param {number} at
 * @param {object|null} probe the engine's answer for this place, or null
 * @param {string} hold
 * @param {{ through?: string[] }} [options]
 */
export function aimLine(axis, at, probe, hold, { through = [] } = {}) {
  const where = `${AXIS_NAMES[axis]} ${mm(at)} mm`;
  return probe ? [where, lipLine(axis, probe, hold), throughWords(through)].filter(Boolean).join(' · ') : where;
}

/**
 * What a cut snapped to, for the readout: "snapped to the ledge at 200 mm",
 * "snapped to a good spot at 190.5 mm – under a ledge where the shape
 * widens", "snapped to where a full lip fits, at 190.5 mm" – or, where the
 * lip the move gives is short of that (no clips on a round wall), "snapped
 * to where a 6 mm lip fits", and where the twist-lock takes their place,
 * "snapped to where a twist-lock fits".
 * @param {{ at: number, kind: 'seam'|'spot'|'lip', what?: string, why?: string, full?: boolean, H?: number, twist?: boolean }|null} target
 *   from `aimTargets`
 * @param {number} axis
 */
export function snappedWords(target, axis) {
  if (!target) return '';
  if (target.kind === 'spot') return `snapped to a good spot at ${mm(target.at)} mm${target.why ? ` – ${target.why}` : ''}`;
  if (target.kind === 'lip' && target.twist) return `snapped to where a twist-lock fits, at ${mm(target.at)} mm`;
  if (target.kind === 'lip' && target.whole) return `snapped to where the lip is whole, at ${mm(target.at)} mm`;
  if (target.kind === 'lip') return `snapped to where a ${target.full === false && target.H > 0 ? `${mm(target.H)} mm` : 'full'} lip fits, at ${mm(target.at)} mm`;
  return `snapped to ${seamWords(target.what, axis)} at ${mm(target.at)} mm`;
}

/**
 * A suggestion's button: "Z 190.5 mm – top 100.5 mm comes off · locks with
 * 4 clips · under a ledge where the shape widens", and the letters it runs
 * through ("· through “LIGHT”", `through` the names of its `crosses`) or the
 * cut already there (`taken`, its letter: "· cut A is here").
 * @param {{ axis: string, at: number, why: string, lip: { H: number, clips: number, twist?: object }, comesOff: object }} spot from mode 'spots'
 * @param {string} hold the hold the spots were found for
 * @param {{ through?: string[], taken?: string|null }} [options]
 */
export function spotLabel(spot, hold, { through = [], taken = null, handles = [] } = {}) {
  const axis = AXIS_NAMES.indexOf(String(spot.axis).toUpperCase());
  const lip = lipWords({ at: spot.at, lip: spot.lip, suggestedAt: null }, hold, axis);
  const off = offWords(axis, spot.comesOff);
  const here = taken ? `cut ${taken} is here` : '';
  const label = `${AXIS_NAMES[axis]} ${mm(spot.at)} mm – ${[off, lip, spot.why, throughWords(through), here].filter(Boolean).join(' · ')}`;
  return takesHandle(spot, handles) ? `${label} – takes the handle with the top` : label;
}

/**
 * Whether the top a cut across Z takes off holds some of a handle the parts table traced (`handles`, each `{ foot,
 * top }`): its top is over the cut, so a lantern's handle goes with its lid – which a part inside the handle avoids.
 */
export function takesHandle(spot, handles = []) {
  if (String(spot.axis).toLowerCase() !== 'z' || !(spot.comesOff?.side > 0)) return false;
  return handles.some((h) => h.top > spot.at);
}

/* ------------------------------------------------- parts that come off */

/** A least scale (a factor on the size now) as the texts give it: a whole 5 % of the model as loaded. */
export const percentOf = (q, scale = 1) => (q == null ? null : scalePercent(q * scale));

/** "Dome and cap" → "dome and cap", what a sentence calls a part; a generic part is "part". */
const calledOf = (name) => (!name || /^Part\b/.test(name) ? 'part' : String(name).toLowerCase());

/** Whether a part's name is more than one thing: the dome and cap come off. */
const manyOf = (name) => / and /.test(name ?? '');

/** The opening a lock leaves, and whether a tea light goes through it: "Ø 44 mm opening, takes a 38 mm tea light". */
const openingWords = (lock, join = ', ') => `Ø ${roundOpening(lock.opening)} mm opening${lock.teaLight ? `${join}takes a ${TEA_LIGHT} mm tea light` : ''}`;

/** What happens to a lantern's handle when a lid comes off: it stays, it goes with it, or there is none. */
const handleWords = (entry) => (entry.takesHandle ? 'takes the handle with it' : entry.handle ? 'the handle stays' : '');

/**
 * Why no lock fits a lid at this size, as the card says it: its roof too thin (and how thin), no room for the click
 * tabs, or nothing under it to carry one.
 */
function smallWords(entry) {
  if (entry.why === 'tabs') return 'there is no room round it for the click tabs';
  if (entry.why === 'collar') return 'nothing under it is deep enough to carry one';
  if (entry.wall) return `its roof is ${mm(entry.wall.t)} mm thick`;
  return 'there is no room for one';
}

/**
 * From what size a lock fits, as the card and the notes say it: "A twist-lock fits from 275 % (a 24 mm opening); a 38
 * mm tea light fits through it from 365 %." – or, when none does as far as the finder looks, that none fits up to
 * that size.
 */
function leastWords(entry, table) {
  const scale = table.scale ?? 1;
  const lock = percentOf(entry.least?.lock, scale);
  if (lock == null) return Number.isFinite(table.most) ? `No twist-lock fits it up to ${Math.round(table.most * scale * 100)} %.` : '';
  const at = Number.isFinite(entry.least.opening) ? ` (a ${roundOpening(entry.least.opening)} mm opening)` : '';
  const tea = percentOf(entry.least.tea, scale);
  if (tea != null && tea > lock) return `A twist-lock fits from ${lock} %${at}; a ${TEA_LIGHT} mm tea light fits through it from ${tea} %.`;
  if (tea === lock) return `A twist-lock fits from ${lock} %${at}, and takes a ${TEA_LIGHT} mm tea light.`;
  return `A twist-lock fits from ${lock} %${at}.`;
}

/**
 * Why a base has no lock at this size, as the card says it: how wide its bottom is now (the ring the body keeps round
 * it, `ringOut`), against how wide it is at the least size its lock fits – the lugs, slots and click tabs and the wall
 * behind them are as big at any size. Where no lock fits at any size the finder looks at, what stops one (`limit`).
 */
function plugSmallWords(entry) {
  if (entry.least?.lock == null) {
    if (entry.limit === 'under') return "Raised text or a foot under its bottom is where the lock's slots and the floor that holds its lugs go: engrave the text, or move it off the bottom.";
    if (entry.limit === 'floor') return 'Its bottom is too thin to hold one.';
    if (entry.limit === 'tabs') return 'There is no room inside it for the click tabs.';
    if (entry.limit === 'wall' || entry.limit === 'cam') return 'The wall round its bottom is too thin to hold one.';
    return '';
  }
  if (!(entry.ringOut > 0)) return 'Too small for its twist-lock at this size.';
  const now = 2 * entry.ringOut;
  const need = now * entry.least.lock;
  // whole millimetres, or tenths where the two would read alike
  const whole = roundOpening(need) > roundOpening(now);
  const d = (v, round) => (whole ? roundOpening(v) : (round(v * 10) / 10).toFixed(1));
  return `Too small for its twist-lock at this size: its bottom is Ø ${d(now, Math.floor)} mm across, and the lock needs Ø ${d(need, Math.ceil)} mm.`;
}

/**
 * From what size a base twists off, and what the size its [Make it N %] offers (`offer`) gives it: "A 38 mm tea light
 * fits through it from 275 %; at 300 % it gets both."
 */
function plugLeastWords(from, tea, offer) {
  const light = tea != null && tea > from ? `A ${TEA_LIGHT} mm tea light fits through it from ${tea} %` : tea === from ? `From ${from} % a ${TEA_LIGHT} mm tea light fits through it too` : '';
  if (offer == null || offer === from) return light ? `${light}.` : '';
  const gets = light && tea <= offer ? 'it twists off and takes a tea light' : 'it twists off';
  return `${light ? `${light}; at` : 'At'} ${offer} % ${gets}.`;
}

/**
 * One part in the card "Parts that come off", from the engine's parts table (`split.plan` mode 'parts'): what it is
 * and the lock it gets at this size, or why none fits and from what size one does; the print badge; the sizes its
 * [Make it N %] buttons offer (the least scale of a lock, and of a tea light through it, each up to a whole 100 % of
 * the model as loaded); and how [Use] puts it on – 'lock' (it twist-locks), 'lift' ("Use – it just lifts off", a lid
 * too small for a lock) or null (a base too small for one, which would just drop out).
 * @param {object} entry one of the table's `parts`
 * @param {{ scale?: number, most?: number, parts?: object[] }} table the table it is from
 * @returns {{ kind: string, name: string, lock: boolean, title: string, detail: string, badge: string, offers: number[], use: 'lock'|'lift'|null }}
 */
export function partCard(entry, table) {
  const scale = table.scale ?? 1;
  const { name, lock } = entry;
  const offers = [...new Set([entry.least?.lock, entry.kind === 'lid' ? entry.least?.tea : null].filter((q) => q != null).map((q) => offerPercent(q * scale)))];
  if (entry.kind === 'plug') {
    // a tea light stands in a seat on its top where one fits, [Use] giving it one; where none does, the card says why
    const seat = lock?.teaLight ? cardSeatWords(entry.seat) : '';
    if (lock) return { kind: 'plug', name, lock: true, title: `${name} – twists off underneath · twist-lock · ${openingWords(lock)}${seat}`, detail: '', badge: 'no extra support', offers: [], use: 'lock' };
    // too small for its lock at this size: it would just drop out, so it has no [Use] – but it is offered all the same,
    // as what it gets once the model is big enough, why not now, and the size that gives it its lock (and a tea light)
    const from = percentOf(entry.least?.lock, scale);
    const tea = percentOf(entry.least?.tea, scale);
    const most = Number.isFinite(table.most) ? ` up to ${Math.round(table.most * scale * 100)} %` : '';
    const title = entry.limit === 'under'
      ? `${name} – no twist-lock fits it underneath while something stands under its bottom.`
      : from == null ? `${name} – no twist-lock fits it underneath${most}.` : `${name} – twists off underneath once the model is ${from} % or bigger.`;
    const detail = [plugSmallWords(entry), from == null ? '' : plugLeastWords(from, tea, offers[0])].filter(Boolean).join(' ');
    return { kind: 'plug', name, lock: false, title, detail, badge: '', offers: offers.slice(0, 1), use: null };
  }
  if (lock) {
    // a lid whose opening is too small for a tea light, on a lantern whose base takes one
    const base = (table.parts ?? []).find((e) => e.kind === 'plug' && e.lock?.teaLight);
    const elsewhere = !lock.teaLight && base ? `a ${TEA_LIGHT} mm tea light fits through the base, not the lid` : '';
    const title = `${name} – ${['twist-lock', openingWords(lock), handleWords(entry), elsewhere].filter(Boolean).join(' · ')}`;
    return { kind: 'lid', name, lock: true, title, detail: '', badge: collarBadge(name, lock.slope), offers: [], use: 'lock' };
  }
  const where = entry.takesHandle ? 'comes off, and takes the handle with it.' : entry.handle ? 'comes off inside the handle; the handle stays on the lantern.' : 'comes off.';
  const detail = [`Too small for a lock at this size: ${smallWords(entry)}.`, leastWords(entry, table)].filter(Boolean).join(' ');
  return { kind: 'lid', name, lock: false, title: `${name} – ${where}`, detail, badge: '', offers, use: 'lift' };
}

/**
 * The print badge of a lid that locks: what its collar needs. The collar is the lantern's, under the joint, and slopes
 * out as the model beside it does (`slope`, run over rise, as the download builds it and PART_PRINT says it): no
 * steeper than 45°, it needs nothing; steeper, the support the model round it needs.
 */
function collarBadge(name, slope) {
  if (!(slope > 1 + 1e-6)) return 'no extra support';
  return name === 'Dome and cap' ? "the lantern's collar needs the dome's support" : "the collar under it needs the model's support";
}

/**
 * Whether the card offers anything for a part: to use it, or a size that fits its lock. A base no lock fits at any size
 * the finder looks at is listed with neither.
 */
export const partOffered = (entry, table) => {
  const w = partCard(entry, table);
  return !!w.use || w.offers.length > 0;
};

/**
 * What Download fit test says when there is nothing to try because the split's only cuts take out parts that come off
 * with nothing holding them (a lid's twist-lock is tried on two rings, a base's on a ring and a plug): each part, and
 * from what size its twist-lock fits where none does at this size.
 * @param {{ name: string, kind?: 'lid'|'plug', hold: string, least?: number|null }[]} parts
 */
export function noFitTestWords(parts) {
  const each = parts.map(({ name, kind = 'lid', hold, least = null }) => {
    const many = manyOf(name);
    const off = `the ${calledOf(name)} ${kind === 'plug' ? 'lifts out' : many ? 'lift off' : 'lifts off'}`;
    if (hold === 'lift') return `${off} with nothing holding ${many ? 'them' : 'it'}`;
    return `${off} at this size – ${least != null ? `a twist-lock fits from ${least} %` : 'no twist-lock fits'}`;
  });
  return `Nothing to try: ${each.join('; ')}.`;
}

/**
 * What the card says when it lists no part: the model is solid all through, already open, or has no part that comes
 * off cleanly – where a cut is being placed, to click the model where it should open; or null when it lists some. A
 * model turned since it was loaded (`tipped`: its own up no longer up) may lie on its side, where the parts – a top, a
 * base – are looked for along Z, as it stands: said too, with how to stand it up again.
 * @param {{ solid?: boolean, open?: { d: number }|null, parts?: object[] }} table
 * @param {{ aiming?: boolean, tipped?: boolean }} [options]
 */
export function partsNote(table, { aiming = true, tipped = false } = {}) {
  if (table.solid) return "This model is solid all through – there's no inside to open.";
  if (table.open) return `The top is already open (Ø ${roundOpening(table.open.d)} mm).`;
  // a click on the model only places a cut while one is being placed: else it would move the text
  if (!table.parts?.length) {
    const side = tipped ? ' Parts come off along Z, the model standing on its bottom: it was turned since it was loaded – if it lies on its side now, Undo the turn (or turn it back) and its top and base are looked for again.' : '';
    return `No part comes off cleanly here${aiming ? ' – click the model where it should open' : ''}.${side}`;
  }
  return null;
}

/**
 * What the readout says over a part the pointer picks (`pickPart`): the lid and its lock, or why none fits; the handle
 * the lid leaves on the lantern; the base and its lock. Null when it picks none.
 * @param {{ part: object|null, on: 'lid'|'handle'|'under'|'base'|null }} pick
 * @param {{ scale?: number }} table
 */
export function partReadout({ part, on }, table) {
  if (!part) return null;
  const scale = table.scale ?? 1;
  const { name, lock } = part;
  if (on === 'handle') return `The handle stays on the lantern – click to take off the ${calledOf(name)} under it`;
  if (part.kind === 'plug') {
    if (lock) return `${name} twists off underneath · Ø ${roundOpening(lock.opening)} mm opening · twist-lock, 3 lugs, turn ${roundAngle(lock.theta)}°`;
    const from = percentOf(part.least?.lock, scale);
    return `${name} · too small for a lock at this size${from != null ? ` – twists off from ${from} %` : ''}`;
  }
  const comes = `${name} ${manyOf(name) ? 'come' : 'comes'} off`;
  if (lock) return [comes, `twist-lock, 3 lugs, turn ${roundAngle(lock.theta)}°`, openingWords(lock, ' – '), handleWords(part)].filter(Boolean).join(' · ');
  const from = percentOf(part.least?.lock, scale);
  const roof = part.wall && part.why === 'room' ? ` (roof ${mm(part.wall.t)} mm)` : '';
  return `${comes} · too small for a lock at this size${roof}${from != null ? ` – a twist-lock fits from ${from} %` : ''}`;
}

/**
 * How low on the model, as a share of its height, a cut across would take most of it off as its "top": there, on a
 * model whose handle such a cut would take with it, a click that picks a part takes out the base – where its lock fits
 * – rather than placing such a cut.
 */
export const BASE_LOW = 0.2;

/**
 * Which part a point on the model picks, from the table alone (each pointer move, so no slicing): a lid when the
 * point is on it; the lid under a handle when it is on the handle the lid leaves on the body; the lid when it is
 * just under its face, on the shell it sits in; the base when it is on the model's solid bottom, on what stands on it
 * inside its circle (a cup on a lantern's floor, seen through a window), or – where its lock fits, on a model with a
 * handle – anywhere on its lowest `BASE_LOW` round it: the walls over its bottom, where a cut across would take the
 * rest of the model off as its top, handle and all. A model with no handle, or a base too small to lock, keeps the
 * low cuts across there (a band below the openings). `on` says which.
 * @returns {{ part: object|null, index: number, on: 'lid'|'handle'|'under'|'base'|null }}
 */
export function pickPart(table, p) {
  const { h } = table;
  const dist = (e) => Math.hypot(p[0] - e.centre[0], p[1] - e.centre[1]);
  const handled = (table.handles ?? []).some((hd) => hd.top > p[2]);
  const low = handled && Number.isFinite(table.zmin) && Number.isFinite(table.zmax) ? table.zmin + BASE_LOW * (table.zmax - table.zmin) : -Infinity;
  const round = (table.width ?? 0) * 0.05 + 2 * h;
  const rules = [
    ['lid', (e) => e.kind === 'lid' && p[2] >= e.face - 1e-6 && p[2] <= e.cap + 1e-6 && dist(e) <= e.r],
    ['handle', (e) => e.kind === 'lid' && !!e.handle && onTrace(e.handle, p, 1.5 * h)],
    ['under', (e) => e.kind === 'lid' && p[2] < e.face && p[2] >= e.from - 2 * h && dist(e) <= e.window[1] + 2 * h],
    ['base', (e) => e.kind === 'plug' && (
      (p[2] <= e.solidTop + 1e-6 && dist(e) <= e.reach + 1e-6)
      || (p[2] <= (e.top ?? -Infinity) + 1e-6 && dist(e) <= e.r)
      || (!!e.lock && p[2] <= low && dist(e) <= (e.reach ?? e.r) + round)
    )],
  ];
  for (const [on, test] of rules) {
    const index = table.parts.findIndex(test);
    if (index >= 0) return { part: table.parts[index], index, on };
  }
  return { part: null, index: -1, on: null };
}

/** Whether p is on a traced handle: inside one of its islands' boxes, grown by tol, at a level within tol of it. */
function onTrace(handle, p, tol) {
  return handle.levels.some(({ z, boxes }) => Math.abs(z - p[2]) <= tol
    && boxes.some((b) => p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol));
}

/** The readout's words over a plane whose top would take a traced handle with it, where a part inside the handle would not. */
export const HANDLE_PLANE = 'A cut here would take the handle with the top – click the dome to take off just the lid';

/**
 * The readout's line over a place where a cut across Z at `at` would take a lantern's handle off with its top – a
 * handle the parts table traced reaches over it – while a lid inside the handle comes off on its own and leaves it on
 * the lantern (HANDLE_PLANE); null anywhere else.
 * @param {{ handles?: { top: number }[], parts?: object[] }|null} table the parts table
 * @param {number} at
 */
export function handlePlaneWords(table, at) {
  if (!table?.handles?.some((h) => h.top > at)) return null;
  // low down the top a cut takes is most of the model, handle and all: that it takes the handle is no news there
  if (Number.isFinite(table.zmin) && Number.isFinite(table.zmax) && at < (table.zmin + table.zmax) / 2) return null;
  return table.parts?.some((e) => e.kind === 'lid' && e.handle && !e.takesHandle) ? HANDLE_PLANE : null;
}

/**
 * Where a part's face typed in or nudged goes: onto the printer's layers of the piece it comes out of – every `hl`
 * from `from`, the model's bottom or the cut under it – as the split puts it, which then moves it up a layer or two
 * where it would not print apart (the engine's mode 'part' says).
 * @param {number} z the face asked for
 * @param {{ from: number, hl: number }} layers
 */
export function partFace(z, { from, hl }) {
  if (!(hl > 0) || !Number.isFinite(from)) return z;
  return +(from + Math.round((z - from) / hl) * hl).toFixed(6);
}

/**
 * The free band round a part's centre at its face that its circle is kept in: the one it lies in, else the nearest,
 * from the bands the engine found there (`windows`, each [lo, hi] in radii); null when none is known.
 * @param {number[][]} windows
 * @param {number} r
 */
export function bandOf(windows, r) {
  if (!windows?.length) return null;
  const off = ([lo, hi]) => (r < lo ? lo - r : r > hi ? r - hi : 0);
  const [lo, hi] = windows.reduce((best, w) => (off(w) < off(best) ? w : best));
  return { lo, hi };
}

/**
 * How wide a part's circle typed in or dragged goes (its radius): in the free band round it at its face (`lo`–`hi`),
 * never nearer either edge than half the gap a face needs to print apart (`gmin`), and onto the band's middle – the
 * finder's own pick – from within `tol` of it. `edge` says which edge held it back ('wide' or 'narrow'), for
 * `widthWords`; null when none did, or no band is known.
 * @param {number} r
 * @param {{ lo?: number|null, hi?: number|null, gmin: number, tol?: number }} band
 * @returns {{ r: number, edge: 'wide'|'narrow'|null }}
 */
export function partWidth(r, { lo = null, hi = null, gmin, tol = 0, mid = null }) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { r, edge: null };
  // the finder's own width where it is known: the middle of its band before that was rounded
  const middle = Number.isFinite(mid) ? mid : +((lo + hi) / 2).toFixed(4);
  const [least, most] = [+(lo + gmin / 2).toFixed(4), +(hi - gmin / 2).toFixed(4)];
  // a band too narrow to print apart in at all: the middle, where the split says why
  if (least > most) return { r: middle, edge: null };
  if (Math.abs(r - middle) <= tol) return { r: middle, edge: null };
  if (r > most) return { r: most, edge: 'wide' };
  if (r < least) return { r: least, edge: 'narrow' };
  return { r, edge: null };
}

/**
 * Why a cut that comes apart, asked to lock, gets no lock from the lip it was found to have (`{ H, clips, twist, why }`,
 * or null for none): 'round' where its wall has no straight stretch for a clip – a round wall the twist-lock does not
 * fit either – 'other' for any other reason; null where clips or the twist-lock hold it.
 * @param {{ clips?: number, twist?: object, why?: string[] }|null} lip
 */
export function noLockOf(lip) {
  if (lip?.twist || lip?.clips > 0) return null;
  return lip?.why?.includes('short') ? 'round' : 'other';
}

/** What a cut's struck-through Locks says, for why it gets no lock (`noLockOf`): and that a part inside the wall would. */
export const noLockTitle = (why) =>
  why === 'round' ? 'A round wall takes no clips – try a removable part (+ Removable part)' : 'No clip or twist-lock fits this cut here – try a removable part (+ Removable part)';

/** What the page says when a part's circle met the edge of its band: "Ø 63 is as wide as fits here". */
export const widthWords = (d, edge) => (edge ? `Ø ${mm(d)} is as ${edge === 'wide' ? 'wide' : 'narrow'} as fits here` : '');

/** The readout's words where a part's circle would cross the model on both sides of its plane. */
export const MIXED_PART = 'The circle crosses the model above and around its plane here – use a full cut, or move it to where the circle crosses only air';

/** The readout's words for a part that can't come out, and what holds it in. */
export const stuckWords = (name, over, beside) => `${name} can't come out: ${over} is over it and ${beside} is beside it`;

/** Why a base has no tea-light seat, in a few words: what its row and the card say after "no tea-light seat: ". */
const SEAT_SHORT = Object.freeze({
  room: 'too narrow for one',
  detail: "the model's own detail is in the way",
  level: "its top isn't level",
  thin: 'too near its lock',
  hollow: 'not solid under it',
  low: 'no room over it for a light',
});

/** Why no seat fits a base (`seatFor`'s refusal), in a few words. */
const seatShort = (seat) => (seat.why === 'thin' && !seat.lock ? 'too thin for one' : SEAT_SHORT[seat.why] ?? 'none fits');

/**
 * How a base's row words its tea-light seat (`seat`: `{ d, clears? }` the one it has, and the model's own detail it
 * takes the place of; `{ why }` why none fits where it was asked for; null when it has none and none was asked for):
 * nothing where no tea light goes into the base at all.
 */
export function seatMeta(seat) {
  if (!seat) return '';
  if (seat.d) return `tea-light seat Ø ${mm(seat.d)} mm${seat.clears ? " in place of the model's own detail" : ''}`;
  if (seat.why === 'narrow') return '';
  return `no tea-light seat: ${seatShort(seat)}`;
}

/**
 * What the card says of a base's tea-light seat after the tea light it takes: " · a seat for it on top" (", in place of
 * the model's own detail there" where the seat cuts that away), or why none fits; nothing before the finder has read it.
 */
function cardSeatWords(seat) {
  if (!seat) return '';
  if (seat.d) return ` · a seat for it on top${seat.clears ? ", in place of the model's own detail there" : ''}`;
  return seat.why === 'narrow' ? '' : ` · no seat for it on top: ${seatShort(seat)}`;
}

/**
 * What a part's row says under its name: its twist-lock and turn, the handle it leaves on; that it lifts off, chosen
 * or too small for a lock (and from what size one fits); or what the split said of it – moved up the layers, refused,
 * stuck. `lock` is what it gets – the built seam's when the pieces are worked out, else the parts table's while the
 * part's face is the finder's – with `least` the least scale (%) a lock needs; null until either is known.
 * `known` that no lock fits it at this size (or, with `why` 'pieces', that one would leave it in pieces). A base's
 * tea-light seat (`seat`, `seatMeta`) follows what holds it.
 * @param {{ hold: string, kind?: 'lid'|'plug', lock?: object|null, least?: number|null, handle?: boolean, note?: object|null,
 *   known?: boolean, why?: string|null, seat?: object|null }} part
 */
export function partMeta(part) {
  const said = holdMeta(part);
  const seat = part.kind === 'plug' && !part.note ? seatMeta(part.seat) : '';
  return seat ? `${said} · ${seat}` : said;
}

function holdMeta({ hold, kind = 'lid', lock = null, least = null, handle = false, note = null, known = false, why = null }) {
  if (note?.code === 'PART_STUCK') return "can't come out – see the note";
  if (note?.code === 'PART_GAP') {
    // its face in several pieces (through a ring of columns), or its edge too near what stands beside it
    const pieces = note.islands > 1;
    const where = pieces ? `its face at Z ${roundZ(note.z)} is in ${note.islands} pieces` : `the circle runs too close to ${note.by ?? 'the model beside it'} at Z ${roundZ(note.z)}`;
    if (Number.isFinite(note.movedTo)) return `${where} – moved to Z ${roundZ(note.movedTo)}`;
    return pieces ? `${where} – no face near here is one piece` : `${where} – no face here leaves ${note.need} mm`;
  }
  if (note) return 'left out – see the note';
  if (hold === 'lift') return kind === 'plug' ? 'lifts out – nothing holds it' : 'lifts off – sits on its cut face';
  if (lock?.mech === 'plug') return `twist-lock, 3 lugs – turn ${roundAngle(lock.theta)}° · coin slot`;
  if (lock?.mech === 'twist') {
    return `twist-lock, 3 lugs, ${lock.tabs} ${lock.tabs === 1 ? 'click' : 'clicks'} – turn ${roundAngle(lock.theta)}°${handle ? ' · the handle stays' : ''}`;
  }
  if (known && why === 'pieces') return 'lifts off – a twist-lock would leave it in pieces';
  if (known && why === 'under') return 'lifts out – something under its bottom is where its twist-lock goes';
  if (known) return `lifts off – too small for a lock here${least != null ? ` (twist-lock from ${least} %)` : ''}`;
  return 'comes off – Show pieces works out its lock';
}

/**
 * What the view says while a part comes out along its way (`wayStep`): its name, the step's number of how many, and
 * what to do – turn it free (a base seen from underneath, as it is fitted), lift it, slide it out – the lift and the
 * turn as the notes give them; going on (`on`, Shift+▶), the steps the other way round, counted as they are done –
 * slide it in, lower it, turn it right until it clicks shut. Null when it is seated or out.
 * @param {{ name: string, kind?: 'lid'|'plug', way: object, span?: number[]|null }} part a part seam's: its `part`
 * @param {{ step: string, n: number, of: number }|null} at `wayStep`'s
 * @param {{ on?: boolean }} [options]
 */
export function wayCaption({ name, kind = 'lid', way, span = null }, at, { on = false } = {}) {
  if (!at) return null;
  const plug = kind === 'plug';
  const under = plug ? ', seen from underneath' : '';
  // going on (Shift+▶), the same steps the other way round: slid in, lowered, turned back until it clicks shut
  const words = on
    ? {
      turn: `Turn it ${roundAngle(way.turn)}° to the right${under} – it clicks shut`,
      lift: plug ? 'Push it in' : at.of > at.n ? `Lower it ${roundLift(way.lift)} mm into place` : `Set it on${way.turn ? `, turned ${roundAngle(way.turn)}° to the left` : ''}`,
      slide: `Slide it in ${slideWords(way.dir ?? [1, 0], span)}`,
    }[at.step]
    : {
      turn: `Turn it ${roundAngle(way.turn)}° to the left${under} – it clicks free`,
      lift: plug ? 'Lower it out' : at.of > at.n ? `Lift it ${roundLift(way.lift)} mm` : 'Lift it off',
      slide: `Slide it out ${slideWords(way.dir ?? [1, 0], span)}`,
    }[at.step];
  // counted in the order they are done
  const n = on ? at.of - at.n + 1 : at.n;
  return `${name}: ${n} of ${at.of} · ${words}`;
}

/**
 * What a cut being placed snaps to along one axis: the model's seams, the
 * spots suggested and the nearest place a full lip fits (the probe's
 * `suggestedAt`; with `full` false and its height `H` where the lip there is
 * short of a full one, `twist` where the twist-lock takes the clips' place,
 * `whole` where the lip is whole a half step from one in short stretches),
 * as `snapTarget` takes them.
 * @param {{ seams?: { at: number, kind: string }[], spots?: { at: number, why: string }[],
 *   lip?: number|{ at: number, full?: boolean, H?: number, twist?: boolean, whole?: boolean }|null }} from
 */
export function aimTargets({ seams = [], spots = [], lip = null } = {}) {
  const near = typeof lip === 'number' ? { at: lip } : lip;
  const what = near?.twist ? { twist: true } : near?.whole ? { whole: true } : near?.full === false ? { full: false, H: near.H } : {};
  return [
    ...seams.map((s) => ({ at: s.at, kind: 'seam', what: s.kind })),
    ...spots.map((s) => ({ at: s.at, kind: 'spot', why: s.why })),
    ...(Number.isFinite(near?.at) ? [{ at: near.at, kind: 'lip', ...what }] : []),
  ];
}

/**
 * How near (mm) a target pulls a cut being placed: `SNAP_PX` pixels at the
 * scale the axis is drawn at where the pointer is (`pxPerMm`), at most
 * `SNAP_MAX` mm; `snapTarget` takes 3 mm when this is less.
 */
export function snapTolerance(pxPerMm) {
  return pxPerMm > 0 ? Math.min(SNAP_MAX, SNAP_PX / pxPerMm) : SNAP_MAX;
}

/** Where a cut placed at `raw` goes: on the target it snapped to, else at `raw` to 0.1 mm. */
export const placedAt = (raw, target) => (target ? target.at : Math.round(raw * 10) / 10);
