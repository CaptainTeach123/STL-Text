/**
 * Placing a cut that comes apart from the view: what the readout beside the
 * pointer says, the colour the model's section takes, what a suggestion's
 * button reads and the targets a cut snaps to – all from the engine's answers
 * (`split.plan` modes 'probe', 'spots' and 'targets'), with no page or scene,
 * so they can be tested on their own.
 */
import { LIP, seamWords } from './split.js';

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
 * lip with clips fits (or a full one, on a hold that has no clips), 'short'
 * where only a shorter or clipless one does, 'none' where no lip does.
 * @param {{ lip: { H: number, clips: number }|null }|null} probe the engine's answer (mode 'probe')
 * @param {string} hold the cut's hold: 'lock', 'snap', 'light' or 'lift'
 */
export function lipVerdict(probe, hold) {
  const lip = probe?.lip;
  if (!lip || !(lip.H > 0)) return 'none';
  return lip.H >= LIP.heights[0] && (lip.clips > 0 || hold === 'lift') ? 'full' : 'short';
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
 * has them (`suggestedLip`): on a round wall, where no clip fits, it is for a
 * taller lip.
 * @param {object} probe the engine's answer (mode 'probe')
 * @param {string} hold
 * @param {number} axis
 */
export function lipWords(probe, hold, axis) {
  if (!probe) return '';
  const lip = probe.lip;
  const move = Number.isFinite(probe.suggestedAt) ? moveWords(axis, probe.at, probe.suggestedAt) : '';
  if (!lip || !(lip.H > 0)) {
    const why = noLipWords(probe);
    return move ? `${why} – ${move}` : why;
  }
  const full = lip.H >= LIP.heights[0];
  if (hold === 'lift') return full ? `${mm(lip.H)} mm lip – lifts off` : `${mm(lip.H)} mm lip – lifts off${move ? ` – ${move} for a full one` : ''}`;
  if (lip.clips > 0) return `${HELD[hold] ?? HELD.snap} with ${lip.clips} ${lip.clips === 1 ? 'clip' : 'clips'}`;
  const bare = `${mm(lip.H)} mm lip without clips – lifts off`;
  if (!move) return bare;
  const there = probe.suggestedLip;
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
 * to where a 6 mm lip fits".
 * @param {{ at: number, kind: 'seam'|'spot'|'lip', what?: string, why?: string, full?: boolean, H?: number }|null} target
 *   from `aimTargets`
 * @param {number} axis
 */
export function snappedWords(target, axis) {
  if (!target) return '';
  if (target.kind === 'spot') return `snapped to a good spot at ${mm(target.at)} mm${target.why ? ` – ${target.why}` : ''}`;
  if (target.kind === 'lip') return `snapped to where a ${target.full === false && target.H > 0 ? `${mm(target.H)} mm` : 'full'} lip fits, at ${mm(target.at)} mm`;
  return `snapped to ${seamWords(target.what, axis)} at ${mm(target.at)} mm`;
}

/**
 * A suggestion's button: "Z 190.5 mm – top 100.5 mm comes off · locks with
 * 4 clips · under a ledge where the shape widens", and the letters it runs
 * through ("· through “LIGHT”", `through` the names of its `crosses`) or the
 * cut already there (`taken`, its letter: "· cut A is here").
 * @param {{ axis: string, at: number, why: string, lip: { H: number, clips: number }, comesOff: object }} spot from mode 'spots'
 * @param {string} hold the hold the spots were found for
 * @param {{ through?: string[], taken?: string|null }} [options]
 */
export function spotLabel(spot, hold, { through = [], taken = null } = {}) {
  const axis = AXIS_NAMES.indexOf(String(spot.axis).toUpperCase());
  const lip = lipWords({ at: spot.at, lip: spot.lip, suggestedAt: null }, hold, axis);
  const off = offWords(axis, spot.comesOff);
  const here = taken ? `cut ${taken} is here` : '';
  return `${AXIS_NAMES[axis]} ${mm(spot.at)} mm – ${[off, lip, spot.why, throughWords(through), here].filter(Boolean).join(' · ')}`;
}

/**
 * What a cut being placed snaps to along one axis: the model's seams, the
 * spots suggested and the nearest place a full lip fits (the probe's
 * `suggestedAt`; with `full` false and its height `H` where the lip there is
 * short of a full one), as `snapTarget` takes them.
 * @param {{ seams?: { at: number, kind: string }[], spots?: { at: number, why: string }[],
 *   lip?: number|{ at: number, full?: boolean, H?: number }|null }} from
 */
export function aimTargets({ seams = [], spots = [], lip = null } = {}) {
  const near = typeof lip === 'number' ? { at: lip } : lip;
  return [
    ...seams.map((s) => ({ at: s.at, kind: 'seam', what: s.kind })),
    ...spots.map((s) => ({ at: s.at, kind: 'spot', why: s.why })),
    ...(Number.isFinite(near?.at) ? [{ at: near.at, kind: 'lip', ...(near.full === false ? { full: false, H: near.H } : {}) }] : []),
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
