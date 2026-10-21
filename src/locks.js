/**
 * Twist-locks, the pure half: the sizes, the layouts and the sums of the
 * locks a removable part gets, in plain JavaScript on plain data, so the
 * finder, the engine, the texts and the tests share one copy of them.
 *
 * There are two builds of one lock, a bayonet with a click:
 *  - the collar twist-lock holds a lid (a dome, a roof, a cap) on a planar
 *    face: the body gets a collar under the face, a neck and three lugs; the
 *    lid gets a socket with L-slots and click tabs;
 *  - the plug twist-lock holds a base in a solid bottom, every face it adds
 *    45° or kinder: the body gets L-slots and grooves in its bore; the plug
 *    gets the lugs, the click tabs and a coin slot.
 * Whatever flexes and wears is on the piece that comes off, so a worn click
 * means printing that piece again, not the model.
 *
 * Conventions used throughout:
 *  - lengths are in mm of the model as scaled; angles are in degrees, turning
 *    anticlockwise seen from +z unless a comment says otherwise;
 *  - n is the nozzle, hl the layer height, c the clearance per side;
 *  - the collar's frame: z = 0 is the joint face, the body below it and the
 *    lid above (the lid prints on that face), r from the circle's centre;
 *  - the plug's frame: z = 0 is the bed (the model's bottom), the plug inside
 *    r = R, coming out along −z;
 *  - an outside profile is `[[r, z], …]` by rising z: the least outside
 *    radius of the piece at each height.
 */

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const deg = (rad) => (rad * 180) / Math.PI;
/** v rounded up to whole layers of hl (a hair over a whole layer is not another layer). */
const up = (v, hl) => r6(Math.ceil(v / hl - 1e-9) * hl);

// ---------- printers and materials ----------

/**
 * What a printer does to a part's outline (mm), from a careful one to a
 * sloppy one: `delta` how far each wall prints out of place (outsides out,
 * holes in), `ef` the elephant's foot on the bed layer and `droop` how far a
 * layer hanging over air sags. They are assumptions, not measurements – the
 * fit test is the user's check.
 */
export const PRINTERS = Object.freeze({
  tuned: Object.freeze({ delta: 0.05, ef: 0.1, droop: 0.1 }),
  typical: Object.freeze({ delta: 0.1, ef: 0.2, droop: 0.2 }),
  petg: Object.freeze({ delta: 0.12, ef: 0.25, droop: 0.3 }),
  sloppy: Object.freeze({ delta: 0.15, ef: 0.3, droop: 0.3 }),
});

/**
 * The plastics the holds are worked out for: stiffness E (MPa) and friction
 * μ, `weak` for a poorly bonded print and `nominal` for a good one; the
 * strength in bending and across the layers (`sigma`, `tau`, MPa); and the
 * strain a part can take over and over (`strain`, %). Assumptions, as above.
 */
export const MATERIALS = Object.freeze({
  PLA: Object.freeze({ weak: Object.freeze({ E: 2500, mu: 0.2 }), nominal: Object.freeze({ E: 3500, mu: 0.3 }), sigma: 40, tau: 20, strain: 1.5 }),
  PETG: Object.freeze({ weak: Object.freeze({ E: 1700, mu: 0.2 }), nominal: Object.freeze({ E: 2100, mu: 0.3 }), sigma: 40, tau: 20, strain: 2.5 }),
});

/** A tea light's diameter (mm): the light most lanterns are made for. */
export const TEA_LIGHT = 38;

/** Whether a tea light goes through an opening of diameter d with the clearance c either side. */
export const takesTeaLight = (d, c = 0.15) => d >= TEA_LIGHT + 2 * c - 1e-9;

/**
 * The tea-light seat a base gets on its top (mm): a round pocket a tea light stands in, centred, so it can't slide
 * about while the lantern is carried. `light` the widest common tea light – a wax one in its aluminium cup is 38–39
 * across, an LED one 38 – and `tall` the tallest it makes room for over it: an LED one is 35–45 with its flame, and
 * the notes say to use one, as a flame's heat softens the plastic over it (a wax one is 16). `depth`: a light knocked
 * about has to lift this far to get out, three times its cup's rolled rim, and a wax one still stands 13 mm proud to
 * be taken out with two fingers. `lead` the 45° lead-in round the mouth, so a light set down a little off the middle
 * slides in; `band` how far round the mouth the top is read to be level.
 */
export const TEA_SEAT = Object.freeze({ light: 39, tall: 45, depth: 3, lead: 0.6, band: 2 });

/** What the view calls a base's seat where it puts the word on it. */
export const SEAT_WORD = 'tea-light seat';

/**
 * The seat's sizes on a printer (mm): its diameter `d` the widest light with the clearance either side and the wall
 * error a typical printer prints a hole smaller by (39.5 at the default clearance, so a 39 mm light drops in and a 38
 * mm one sits within 0.65 of the middle), its `depth` whole layers, the `wall` of two lines it keeps from the base's
 * side, and how uneven (`rough`) the top round it may be: within the seat's own depth, as a scan's or a generated
 * model's ribbing is – anything standing higher inside it is the model's own, which the seat cuts away to take its
 * place.
 */
export function seatSizes(S) {
  const d = r6(TEA_SEAT.light + 2 * (S.c + PRINTERS.typical.delta));
  const depth = up(TEA_SEAT.depth, S.hl);
  return { d, r: r6(d / 2), depth, lead: TEA_SEAT.lead, wall: S.skin, rough: depth, band: TEA_SEAT.band, tall: TEA_SEAT.tall };
}

/**
 * The least height of the seat's floor over the bed: solid a millimetre over the base's lock (`lockTop`, the plug's
 * `top`), as the base is anyway, or 2 mm over the bed with no lock under it – whole layers.
 */
export const seatFloor = (S, lockTop = null) => up(lockTop == null ? 2 : lockTop + 1, S.hl);

/** The seat's floor for a top whose lowest point round the mouth is `low` over the bed: its depth under that, on a layer. */
export const seatFloorAt = (S, low) => r6(Math.floor((low - seatSizes(S).depth) / S.hl + 1e-9) * S.hl);

/**
 * The tea-light seat a base with a bore of radius R gets, from what its top is (`seatOf` reads it off the model's
 * slices, heights over the bed): or why none – 'narrow' when a 38 mm tea light doesn't go through the bore at all,
 * 'room' when the base is too narrow to keep a wall round the seat, 'level' when the top round the seat rises more
 * than the seat is deep (a sloping or stepped top), 'detail' when something of the model stands that high inside it
 * that the seat can't take the place of (wider than the seat, or running on up into the model), 'thin' when its floor
 * would come too near the lock under it, 'hollow' when the base is not solid under it and 'low' when an LED tea light
 * would not stand up in the model over it. The model's own detail standing in the seat's mouth – a candle cup on the
 * floor, where the light is to go – is cut away with the seat (`clears`).
 * @param {object} S `sizes()`
 * @param {number} R the base's bore
 * @param {{ low: number|null, inside?: { top: number, d: number, clear?: number|null }|null, rim?: number|null,
 *   solid?: boolean, room?: number }} m `low` the top's lowest point round the mouth (null with nothing there); `rim`
 *   the highest point round the mouth, where the top round it rises past the seat's depth; `inside` the highest thing
 *   inside the mouth, how wide it spans and the first height clear over it (null when it runs on up into the model);
 *   `solid` whether the base is solid under the seat's floor down to the least floor (`seatFloor`); `room` the free
 *   height over the floor inside the model, over what the seat clears
 * @param {number|null} lockTop the plug lock's `top`, or null when it has none
 * @returns {{ d: number, r: number, depth: number, lead: number, zf: number, mouth: number, clears?: { h: number,
 *   across: number, top: number } }|{ why: string, … }} `zf` the floor and `mouth` the top's lowest point, where the
 *   lead-in ends; `clears` the model's own detail the seat takes the place of, `h` proud and `across` wide, cut up to
 *   `top`; a refusal carries what its words need
 */
export function seatFor(S, R, m, lockTop = null) {
  const z = seatSizes(S);
  const opening = r6(2 * R);
  if (!takesTeaLight(opening, S.c)) return { why: 'narrow', opening, need: r6(TEA_LIGHT + 2 * S.c) };
  // the base's side is its plug's, the clearance in from the bore
  if (R - S.c - (z.r + z.lead) < z.wall - 1e-9) return { why: 'room', opening, need: r6(2 * (z.r + z.lead + z.wall + S.c)) };
  const { low, inside = null, rim = null, solid = true, room = Infinity } = m;
  if (low == null) return { why: 'hollow' };
  if (rim != null && rim - low > z.rough + 1e-9) return { why: 'level', h: r6(rim - low), rough: z.rough };
  // the model's own detail standing higher than the seat is deep inside its mouth is where the light is to go: the
  // seat takes its place where all of it lies inside the seat and it ends under the model over it – wider, or running
  // on up into the model, cutting it would leave the rest of it standing
  const proud = !!inside && inside.top - low > z.rough + 1e-9;
  if (proud && !(inside.d <= z.d + 1e-9 && inside.clear != null)) {
    return { why: 'detail', h: r6(inside.top - low), across: r6(inside.d), rough: z.rough, d: z.d, ...(inside.clear == null ? { open: true } : {}) };
  }
  const zf = seatFloorAt(S, low);
  const least = seatFloor(S, lockTop);
  if (zf < least - 1e-9) return { why: 'thin', t: r6(low - (lockTop ?? 0)), need: r6(least + z.depth - (lockTop ?? 0)), lock: lockTop != null };
  if (!solid) return { why: 'hollow' };
  if (room < z.tall - 1e-9) return { why: 'low', room: r6(room), tall: z.tall };
  const seat = { d: z.d, r: z.r, depth: r6(low - zf), lead: z.lead, zf, mouth: r6(low) };
  if (!proud) return seat;
  // cut a millimetre past where the detail ends, and never into the model over it
  const top = r6(Math.min(inside.clear + 1, zf + room));
  return { ...seat, clears: { h: r6(inside.top - low), across: r6(inside.d), top } };
}

// ---------- sizes ----------

/**
 * How far the click's ridge is drawn past the neck it clicks over (mm): 0.3
 * at the default clearance, less as the clearance grows. A user who has
 * raised the clearance to suit a printer that prints fat gets the ridge
 * printed fat as well, so what it really reaches past the gap stays about
 * 0.3–0.4 mm on any printer. Never under 0.15, a click a hand can feel.
 */
export const ddOf = (c) => Math.min(0.3, Math.max(0.15, r6(0.45 - c)));

/**
 * The free gap a lid's rim needs to the nearest body material at the joint
 * face (mm): both sides grow by a typical printer's elephant's foot and wall
 * error, and the clearance is kept between them, so the lid prints apart
 * from the handle's feet beside it. 0.9 at the default clearance.
 */
export const gminOf = (c) => r6(2 * (PRINTERS.typical.ef + PRINTERS.typical.delta) + 2 * c);

/**
 * The click tab's length (mm): the shortest whole half millimetre over 8 whose bending strain at its root, pushed
 * where its ridge is (`ridgeIn` from its free end) by the interference a typical printer prints – the most a ridge is
 * drawn, 0.3 mm, and twice its wall error – stays under PLA's limit (`MATERIALS.PLA.strain`), with 3 % to spare for
 * the tab's curve round the neck. The strain grows with the tab's thickness and falls with the square of its lever,
 * so the thicker tab of a wide nozzle is longer: 9 mm for a 1.2 mm tab, 11 for 1.8 and 12.5 for 2.4.
 */
function tabLength(td, ridgeIn) {
  const i = 0.3 + 2 * PRINTERS.typical.delta;
  const lever = Math.sqrt((3 * i * td) / (2 * ((0.97 * MATERIALS.PLA.strain) / 100)));
  return Math.max(8, Math.ceil((lever + ridgeIn) * 2 - 1e-9) / 2);
}

/**
 * Every size of the twist-lock that follows from the printer (mm). Heights
 * are whole layers from the joint face, since half a layer off left a lid
 * almost no play as printed; every flat ceiling over a moving part has one
 * more layer of room (`sag`), for the bridge's droop; the slits are wide
 * enough that strings and squish do not weld them shut. Only the radii, the
 * twist and the opening follow the model (`collarFor`, `plugFor`).
 * @param {number} n nozzle
 * @param {number} hl layer height
 * @param {number} c clearance per side
 * @returns {object} at n 0.4, hl 0.2, c 0.15: cz 0.2, zl 1, a 1, t 1.6, H 2.4, td 1.2, g 0.8, b 1.2, sockTop 2.8 …
 */
export function sizes(n = 0.4, hl = 0.2, c = 0.15) {
  const cz = r6(Math.max(hl, up(c, hl))); // the play along the axis: whole layers, at least one
  const sag = hl; // one more layer under a flat ceiling over a moving part
  const ledge = r6(Math.max(0.8, up(4 * hl, hl))); // the lid's material under each slot's arm: four layers
  const zl = r6(ledge + cz); // the lug's underside over the face
  const a = r6(Math.max(up(1, hl), 5 * hl)); // the lug's height: five layers
  const t = r6(Math.max(1.6, 4 * n)); // the neck's wall: four lines
  const H = r6(zl + a + 2 * hl); // the neck's top: two layers over the lug
  const td = r6(Math.max(1.2, 3 * n)); // the click tab: three lines
  const g = r6(Math.max(0.8, 2 * n, 2 * c + 0.2)); // the slits beside and behind the tab
  const b = up(1.2, hl); // the tab's height
  const gTop = r6(Math.max(0.8, up(3 * hl, hl) + sag)); // the slit over the tab: three layers and the sag
  const dd = ddOf(c);
  const fb = 0.3;
  // the ridge's middle, where the neck pushes the tab, this far in from the tab's free end: half its base and a tenth
  const ridgeIn = r6((fb + 2 * (dd + c + 0.2)) / 2 + 0.1);
  return {
    n, hl, c, cz, sag, ledge, zl, a, t, H, td, g, b, gTop,
    e: 0.5, // how far the lug's square shoulder bears: one line drawn out over air at most
    w: 5, wKey: 6.5, N: 3, // three lugs, the first wider so the lid goes on one way round
    lead: 0.3, // 45° lead-ins on the lugs' ends and the ledges' ends, so a drooped edge rides up instead of snagging
    mouth: 0.4, // a 45° mouth on every bed edge a mating part passes, for the elephant's foot
    slitMouth: 0.3,
    dd, fb, ridgeIn, // the ridge: how far it reaches past the neck, its flat tip, where it stands on the tab
    Ld: tabLength(td, ridgeIn), // the tab's length: 9 mm for a 1.2 mm tab, longer for a wide nozzle's thicker one
    skin: r6(2 * n), // kept over every cutter, so nothing of the lock shows outside
    sockTop: r6(H + cz + sag), // the socket's ceiling
    armTop: r6(zl + a + cz + sag), // the slot arm's ceiling
    armFloor: r6(zl - cz),
    slitTop: r6(b + gTop),
    Hc: up(1.2, hl), // the collar's depth at its bore under the face
    gmin: gminOf(c),
  };
}

// ---------- the collar twist-lock (lids) ----------

/**
 * The lid's twist (degrees) on a neck of radius r0: far enough that the lug
 * clears its slot's entry by a millimetre each side, whole degrees.
 */
export const twistFor = (S, r0) => Math.ceil(deg((S.w + 2 * S.c + 2) / r0));

/**
 * Where the lugs, the slots' arms and the click tabs go round a neck of
 * radius r0, the same as the solids are built (so a test of the layout is a
 * test of the lock), in the lid's frame. The lugs stand at phi0 + 120k, lug
 * 0 the wide key; each slot's arm runs from its entry, θ back from the lug,
 * to just past it: the lid is set on turned θ anticlockwise seen from above
 * and locks turning clockwise. A
 * click tab lies in the free arc after an arm, its ridge just past the arm's
 * end; a second tab is tried in the same gap after the first. A tab is only
 * placed where it fits before the next arm – which starts a whole twist
 * before the next lug, so the ridge's path while the lid turns misses that
 * lug too – and where its ridge never passes the first tab's grooves, which
 * would click half-way (a twist of a degree or two, on a neck over 330 mm,
 * is the only place that rule is needed). The layout holds (`ok`) when every
 * gap has a tab: a gap without one would cut the lid's socket ring into
 * loose pieces.
 * @param {object} S `sizes()`
 * @param {number} r0 the neck's radius
 * @param {{ phi0?: number, perGap?: number, theta?: number }} options
 * @returns {{ theta: number, lugs: { phi: number, w: number, half: number }[], arms: number[][],
 *   tabs: { k: number, psi: number }[], ok: boolean }} ψ is where each tab's ridge is with the lid locked
 */
export function layout(S, r0, { phi0 = 0, perGap = 2, theta = twistFor(S, r0) } = {}) {
  const { c, N, g, Ld, dd, fb } = S;
  const lugs = [];
  const arms = [];
  const tabs = [];
  for (let k = 0; k < N; k++) {
    const phi = phi0 + (360 * k) / N;
    const w = k === 0 ? S.wKey : S.w;
    const half = deg(w / 2 / r0);
    const cw = deg(c / r0);
    lugs.push({ phi, w, half });
    arms.push([phi - theta - half - cw, phi + half + cw]);
  }
  const rs = r0 + c; // the tab's inside face is the socket's
  const base = fb + 2 * (dd + c + 0.2); // the ridge's width where it meets the tab
  const span = deg((Ld + g + base / 2 + 1) / rs); // the tab, its end slit and a millimetre
  const margin = deg(1 / rs);
  const toRidge = deg((base / 2 + g) / rs);
  for (let k = 0; k < N; k++) {
    const nextArm = arms[(k + 1) % N][0] + (k + 1 === N ? 360 : 0);
    let start = arms[k][1];
    let prev = null;
    for (let j = 0; j < perGap; j++) {
      const psi = start + margin + toRidge;
      const fits = psi + span + margin <= nextArm && (prev == null || psi > prev + theta + deg(base / r0) + 1);
      if (!fits) break;
      tabs.push({ k, psi });
      prev = psi;
      start = psi + span - toRidge;
    }
  }
  return { theta, lugs, arms, tabs, ok: new Set(tabs.map((tab) => tab.k)).size === N };
}

/** The least outside radius at height z, from an outside profile (the first or last where z runs past it). */
export function rAt(outer, z) {
  if (z <= outer[0][1]) return outer[0][0];
  for (let i = 0; i < outer.length - 1; i++) {
    const [r1, z1] = outer[i];
    const [r2, z2] = outer[i + 1];
    if (z >= z1 && z <= z2) return z2 > z1 ? r1 + ((z - z1) / (z2 - z1)) * (r2 - r1) : Math.min(r1, r2);
  }
  return outer[outer.length - 1][0];
}

/**
 * How much of the piece lies between the point (r, z) and its outside: the
 * distance to the outside profile, measured square to it, so a sloping dome
 * is measured through its thickness, not across. Negative when the point is
 * outside the piece.
 */
export function skinAt(outer, r, z) {
  let best = Infinity;
  for (let i = 0; i < outer.length - 1; i++) {
    const [r1, z1] = outer[i];
    const [r2, z2] = outer[i + 1];
    const dr = r2 - r1;
    const dz = z2 - z1;
    const L2 = dr * dr + dz * dz;
    const f = L2 ? Math.max(0, Math.min(1, ((r - r1) * dr + (z - z1) * dz) / L2)) : 0;
    best = Math.min(best, Math.hypot(r - (r1 + f * dr), z - (z1 + f * dz)));
  }
  return r < rAt(outer, z) ? best : -best;
}

/**
 * The largest neck radius r0, in steps of `step`, that keeps the skin (two
 * lines) over the outer faces of what is cut out of the lid – the socket,
 * the slot arms and the slits behind the click tabs – from the bed, where
 * each widens into its 45° mouth, up to its top corner (the socket's
 * ceiling, the arms' tops, the slits over the tabs), at every height the
 * outside is read at. Under a dome, whose outside narrows as it rises, the
 * top corners decide; a lid whose outside steps in under them – a round
 * lantern's wall under its eave – is held to its wall there. Null when not
 * even a 3 mm neck keeps it. `outer` is the lid's outside from the face up,
 * past the socket's ceiling.
 */
export function domeRoom(outer, S, { step = 0.01 } = {}) {
  const { c, e, td, g, skin, sockTop, armTop, slitTop, mouth, slitMouth } = S;
  // each outer face: its radius, how far its mouth widens it at the bed and how high it goes
  const faces = (r0) => [[r0 + c, mouth, sockTop], [r0 + 2 * c + e, mouth, armTop], [r0 + c + td + g, slitMouth, slitTop]];
  const points = (r, m, top) => [[r + m, 0], [r, m], ...outer.filter(([, z]) => z > m && z < top).map(([, z]) => [r, z]), [r, top]];
  const keeps = (r0) => faces(r0).every(([r, m, top]) => points(r, m, top).every(([x, z]) => skinAt(outer, x, z) >= skin - 1e-9));
  // whole steps from 3 mm, so 3 + k·step is exact and the answer is a whole step; from the outside in, as the largest
  // that keeps the skin is the first found
  for (let k = Math.ceil((outer[0][0] - 3) / step - 1e-9) - 1; k >= 0; k--) {
    const r0 = r6(3 + k * step);
    if (r0 < outer[0][0] && keeps(r0)) return r0;
  }
  return null;
}

/**
 * The collar twist-lock a lid gets, from its outside over the face: the
 * neck's radius (`domeRoom`), its bore (`rn`, the opening is twice it), the
 * socket's (`rs`) and the slots' (`rf`) radii, the twist, the click tabs and
 * where they flex (`tabR`, their middle). When none fits, `{ r0, why }`:
 * 'room' when the skin leaves no neck wider than its wall and 2 mm, 'tabs'
 * when some gap between the slots has no room for a click tab, or the tabs
 * would bend further than PLA takes over and over (`click`).
 */
export function collarFor(outer, S, { phi0 = 0 } = {}) {
  const r0 = domeRoom(outer, S);
  if (r0 == null || r0 - S.t <= 2) return { r0, why: 'room' };
  const L = layout(S, r0, { phi0 });
  const tabR = r6(r0 + S.c + S.td / 2);
  // a tab that would bend further than the plastic takes over and over cracks or takes a set, and the click goes
  if (!L.ok || !clickHolds(S, tabR)) return { r0, why: 'tabs', layout: L };
  return {
    r0, rn: r6(r0 - S.t), rs: r6(r0 + S.c), rf: r6(r0 + 2 * S.c + S.e), opening: r6(2 * (r0 - S.t)),
    theta: L.theta, tabs: L.tabs.length, tabR, layout: L,
  };
}

/** Whether click tabs at radius r keep PLA under its strain as a typical printer prints them (`click`). */
const clickHolds = (S, r) => click(S, r, 1, { printer: 'typical' }).ok;

/**
 * The longest bridge a collar twist-lock asks the printer for: the roof of the slit over a click tab, which runs the
 * tab's length and its end slit round the socket, a tab and a slit wide (`across`). Its length (`long`) is taken along
 * the middle of that strip, as a slicer reads it. The rest of the lock's ceilings are narrower rings and ledges, so
 * this is what the print notes quote: about 10.5 mm on a 0.4 nozzle round a 30 mm neck, a little more round a
 * smaller one, and longer for a wide nozzle's longer tab.
 * @param {object} S `sizes()`
 * @param {number} r0 the neck's radius
 * @returns {{ long: number, across: number }} mm
 */
export function slitBridge(S, r0) {
  const rs = r0 + S.c;
  const across = S.td + S.g;
  return { long: r6((S.Ld + S.g) * (rs + across / 2) / rs), across: r6(across) };
}

/** The collar's underside never slopes out further than this (r per z): 59.8° from vertical. */
export const STEEP = 1.72;

/**
 * How far out the collar's underside slopes (r per z), from the body's wall under the face (`below`, `[[r, z, rin],
 * …]` by falling z from z = 0: its least outside radius r and its inside's farthest point rin): as far as the model's
 * own outside slopes over twice the collar's depth – so the collar never overhangs more than the model beside it – but
 * never further than 59.8° from vertical, nor less than 45°, which any printer prints. Null when the wall does not
 * reach that deep.
 */
export function collarSlope(below, S) {
  const depth = 2 * S.Hc;
  if (!below.length || below[below.length - 1][1] > -depth + 1e-9) return null;
  const rising = below.map(([r, z]) => [r, z]).reverse();
  const slope = (rAt(rising, -depth) - below[0][0]) / depth;
  return Math.min(STEEP, Math.max(1, slope));
}

/**
 * How deep under the face the collar reaches: where its underside, sloping out from the neck's bore rn, lands on the
 * wall's inside – from there down it lies inside the wall – or meets the wall's outside inset by the skin, where it
 * ends (the inside of a square tube's corner lies past its outside's nearest point). Where the wall round the axis
 * ends before either (a lantern's band over its windows), the collar runs on under the wall's end, `hang` further,
 * its outside standing straight down from the wall's at `r`, until its underside meets that: its bottom cut flat
 * there would be a shelf over air, which needs support. Null when `below` does not reach under the collar's bore.
 * @returns {{ depth: number, hang: number, r: number|null }|null} `r` null when the collar lands on the wall
 */
export function collarReach(below, rn, S, slope) {
  let last = null;
  for (const [r, z, rin] of below) {
    const d = -z;
    if (d < S.Hc - 1e-9) continue;
    const line = rn + slope * (d - S.Hc);
    const wall = Math.min(rin, r - S.skin);
    if (line >= wall - 1e-9) return { depth: d, hang: 0, r: null };
    last = { d, wall, line };
  }
  if (!last) return null;
  const hang = r6((last.wall - last.line) / slope);
  return { depth: r6(last.d + hang), hang, r: r6(last.wall) };
}

// ---------- the plug twist-lock (bases) ----------

/**
 * The plug's lugs (mm, degrees): `e` how far each reaches past the bore,
 * `w` its width (lug 0 `wKey`, the key), its root sunk `sink` into the plug,
 * the body's `floor` kept under each slot's 45° floor at the bore, the lugs
 * at −`phi0` − 120k.
 */
export const PLUG = Object.freeze({ e: 0.8, w: 6, wKey: 7.5, N: 3, sink: 0.3, floor: 1.2, phi0: 30 });

/**
 * The plug's heights and its coin slot for a bore of radius R: the lug's
 * tip `a` tall, its underside at `zl` (high enough that the body keeps its
 * floor under the slot), the 45° `rise` from root to tip, the lock's `top`
 * over the bed (the lugs' slots or the tabs' slits, whichever is higher),
 * the plug's face `rp` and the coin slot's length (`coin`, stopping a
 * millimetre inside the tabs' slits).
 */
export function plugDims(S, R) {
  const { c, hl } = S;
  const { e, w, sink, floor } = PLUG;
  const a = up(1, hl);
  const rise = r6(e + c + sink);
  const zl = up(floor + rise + c * Math.SQRT2, hl);
  const top = r6(Math.max(zl + a + rise + c * Math.SQRT2, S.b + S.gTop + (S.td + S.g + 0.05)));
  const rp = r6(R - c);
  return { e, a, w, zl, rise, top, rp, coin: r6(2 * (rp - S.td - S.g - 1)) };
}

/**
 * Where the plug's lugs, the body's slots and the plug's click tabs go round
 * a bore of radius R (one tab per gap, as built), and whether it holds
 * together (`ok`): a tab in every gap, its ridge just past the slot before
 * it and the tab ending a millimetre short of the next lug. A tab is longer
 * than the twist, so its ridge's path while the plug turns misses the next
 * slot as well, and the plug's middle inside the tabs' slits is wide.
 *
 * The plug goes in turned θ clockwise seen from above (each slot's entry is
 * θ clockwise of where its lug locks) and locks turning anticlockwise: with
 * the model upside down, as one fits a base, that is clockwise, the way a
 * lid locks seen from above. It is laid out turning the other way and then
 * mirrored across the X axis, which keeps the coin slot along X.
 * @returns {{ theta: number, lugs: { phi: number, half: number }[], arms: number[][], tabs: { k: number, psi: number }[],
 *   ok: boolean }} ψ is where each tab's ridge is with the plug locked
 */
export function plugLayoutOk(S, R, d = plugDims(S, R)) {
  const { c, g, Ld, dd, fb } = S;
  const rp = R - c;
  const theta = Math.ceil(deg((d.w + 2 * c + 2) / R));
  const lugs = [];
  const arms = [];
  for (let k = 0; k < PLUG.N; k++) {
    const phi = PLUG.phi0 + (360 * k) / PLUG.N;
    const half = deg((k === 0 ? PLUG.wKey : d.w) / 2 / rp);
    const cw = deg(c / R);
    lugs.push({ phi, half });
    arms.push([phi - half - cw, phi + theta + half + cw]);
  }
  const base = fb + 2 * (dd + c + 0.2);
  const margin = deg(1 / rp);
  const span = deg((Ld + g + base / 2 + 1) / rp);
  const tabs = [];
  for (let k = 0; k < PLUG.N; k++) {
    const nl = lugs[(k + 1) % PLUG.N];
    const psi = arms[k][1] + margin + deg((base / 2 + g) / rp);
    if (psi + span <= nl.phi + (k + 1 === PLUG.N ? 360 : 0) - nl.half - margin) tabs.push({ k, psi });
  }
  const flip = (a) => (720 - a) % 360;
  return {
    theta,
    lugs: lugs.map(({ phi, half }) => ({ phi: flip(phi), half })),
    arms: arms.map(([a0, a1]) => [flip(a1), flip(a1) + (a1 - a0)]),
    tabs: tabs.map(({ k, psi }) => ({ k, psi: flip(psi) })),
    ok: tabs.length === PLUG.N,
  };
}

/**
 * What it takes to spread the body's ring by the lugs' reach `e` at the
 * three lugs (N): the force the plug's 45° lug faces could cam it open
 * with. A 45° shoulder only holds on a stiff ring – on a thin one it springs
 * open at a fraction of the plug's hold – so the ring must outlast the hold
 * three times over. The ring behind the slots, from their back to `ringOut`,
 * as a free ring under three spread loads (`ringCompliance`), weak PETG.
 */
export function camOut(S, R, d, ringOut, { E = MATERIALS.PETG.weak.E, mu = MATERIALS.PETG.weak.mu } = {}) {
  const tipR = R + d.e;
  const wall = ringOut - (tipR + S.c);
  if (wall <= 0) return 0;
  const h = d.a + 2 * (tipR - (R - S.c - PLUG.sink)) + 2;
  const Rm = tipR + S.c + wall / 2;
  const k = ringCompliance({ R: Rm, E, I: (h * wall ** 3) / 12, A: h * wall, N: PLUG.N, gamma: d.w / 2 / Rm });
  return (PLUG.N * (d.e / k) * (1 + mu)) / (1 - mu);
}

/**
 * The plug twist-lock a base gets, by one rule at every scale: the largest
 * bore R, in steps of 0.1 mm, no wider than the finder's window, whose body
 * ring keeps two lines and a millimetre behind the slots, outlasts three
 * times the plug's hold before its lugs could cam it open (`camOut`), and
 * has room for the slots and a click tab in every gap; with the base solid
 * a millimetre over the lock. Null when none does.
 * @param {object} S `sizes()`
 * @param {{ Rwindow: number, solidTop: number, ringOutAt: (zMax: number) => number }} model the widest bore the
 *   model allows, how high its bottom is solid, and its ring's least outside radius from over the bed layer (whose
 *   mouth is cut anyway) up to zMax
 * @returns {{ R: number, opening: number, theta: number, wall: number, camOutN: number, ringOut: number, zl: number,
 *   top: number, rp: number, coin: number, tabs: number, tabR: number, layout: object }|null}
 */
export function plugFor(S, { Rwindow, solidTop, ringOutAt }) {
  for (let k = Math.floor(Rwindow * 10 + 1e-6); k >= 30; k--) {
    const P = plugAt(S, k / 10, { solidTop, ringOutAt });
    // the lock's height does not depend on R, so a bottom too thin for one is too thin for all
    if (P.why === 'floor') return null;
    if (!P.why) return P;
  }
  return null;
}

/**
 * The plug twist-lock on a bore of radius R exactly, by `plugFor`'s rule –
 * the engine builds the base a part asks for, whose circle is its own – or
 * why none: 'floor' when the bottom is not solid a millimetre over the lock,
 * 'wall' when the ring behind the slots is too thin, 'cam' when it would
 * spread before the plug's hold is reached, 'tabs' when a gap between the
 * slots has no room for a click tab, or the tabs would bend further than PLA
 * takes over and over (`click`).
 * @returns {object} as `plugFor`'s, or `{ R, why }`
 */
export function plugAt(S, R, { solidTop, ringOutAt }) {
  // three times the plug's hold in whole newtons (605 N)
  const need = 3 * Math.round(plugHold(S));
  const d = plugDims(S, R);
  if (solidTop < d.top + 1) return { R, why: 'floor' };
  const ringOut = ringOutAt(d.top + 0.5);
  const wall = ringOut - (R + d.e + S.c);
  if (wall < 2 * S.n + 1) return { R, why: 'wall' };
  const cam = camOut(S, R, d, ringOut);
  if (cam < need) return { R, why: 'cam' };
  const L = plugLayoutOk(S, R, d);
  const tabR = r6(R - S.c - S.td / 2);
  if (!L.ok || !clickHolds(S, tabR)) return { R, why: 'tabs' };
  return {
    R, opening: r6(2 * R), theta: L.theta, wall: r6(wall), camOutN: Math.round(cam), ringOut: r6(ringOut),
    zl: d.zl, top: d.top, rp: d.rp, coin: d.coin, tabs: L.tabs.length, tabR, layout: L,
  };
}

// ---------- springs ----------

/**
 * A free thin ring under N equal loads pressing in, each spread over an arc
 * ±gamma (radians): the radial give under each load per newton (mm/N). The
 * Fourier series of the ring – stretching for the mean, bending for the
 * k = N, 2N … terms – so N = 2 point loads give 0.0744·R³/EI and N = 3,
 * 0.0159·R³/EI, the textbook values.
 */
export function ringCompliance({ R, E, I, A, N, gamma = 0, kmax = 4000 }) {
  const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x);
  const q0 = N / (2 * Math.PI * R); // per newton of each load
  let w = (q0 * R * R) / (E * A);
  for (let j = 1; j * N <= kmax; j++) {
    const k = j * N;
    w += (2 * q0 * sinc(k * gamma) * R ** 4) / (E * I * (k * k - 1) ** 2);
  }
  return w;
}

/** Solves K x = f on a copy of K (Gaussian elimination with partial pivoting); K is small and dense. */
function solveDense(K, f) {
  const n = f.length;
  const a = K.map((row, i) => [...row, f[i]]);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[p][col])) p = r;
    [a[col], a[p]] = [a[p], a[col]];
    for (let r = col + 1; r < n; r++) {
      const m = a[r][col] / a[col][col];
      if (m) for (let k = col; k <= n; k++) a[r][k] -= m * a[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
    x[r] = s / a[r][r];
  }
  return x;
}

/**
 * A curved beam in its own plane – an arc of radius R (Infinity: straight)
 * `span` long, `b` tall out of the plane and `t` thick across it – clamped
 * at both ends (`ends` 'both', a bridge loaded at its middle) or at one
 * ('one', a cantilever loaded at its tip), as frame elements solved
 * directly. A click tab is a curved cantilever flexing in the layers' plane,
 * the way a print bends without parting its layers.
 * @returns {{ k: number, strainPerMm: number }} the stiffness (N/mm) where it is loaded, square to the arc, and
 *   the peak bending strain for each millimetre it is pushed there
 */
export function arcBeam({ R = Infinity, span, b, t, E = MATERIALS.PLA.weak.E, ends = 'both', n = 80 }) {
  const I = (b * t ** 3) / 12;
  const A = b * t;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const s = (span * i) / n;
    if (!Number.isFinite(R)) pts.push([s, 0]);
    else {
      const ang = s / R - span / (2 * R);
      pts.push([R * Math.sin(ang), R * Math.cos(ang) - R]);
    }
  }
  const dof = 3 * pts.length;
  const K = Array.from({ length: dof }, () => new Array(dof).fill(0));
  for (let e = 0; e < n; e++) {
    const [x1, y1] = pts[e];
    const [x2, y2] = pts[e + 1];
    const L = Math.hypot(x2 - x1, y2 - y1);
    const cs = (x2 - x1) / L;
    const sn = (y2 - y1) / L;
    const EA = (E * A) / L;
    const EI = E * I;
    const k = [
      [EA, 0, 0, -EA, 0, 0],
      [0, (12 * EI) / L ** 3, (6 * EI) / L ** 2, 0, (-12 * EI) / L ** 3, (6 * EI) / L ** 2],
      [0, (6 * EI) / L ** 2, (4 * EI) / L, 0, (-6 * EI) / L ** 2, (2 * EI) / L],
      [-EA, 0, 0, EA, 0, 0],
      [0, (-12 * EI) / L ** 3, (-6 * EI) / L ** 2, 0, (12 * EI) / L ** 3, (-6 * EI) / L ** 2],
      [0, (6 * EI) / L ** 2, (2 * EI) / L, 0, (-6 * EI) / L ** 2, (4 * EI) / L],
    ];
    const T = [[cs, sn, 0, 0, 0, 0], [-sn, cs, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, cs, sn, 0], [0, 0, 0, -sn, cs, 0], [0, 0, 0, 0, 0, 1]];
    // the element's stiffness turned into the global axes: Tᵀ k T
    const kT = k.map((row) => T[0].map((_, j) => row.reduce((acc, v, m) => acc + v * T[m][j], 0)));
    const ke = T[0].map((_, i) => kT[0].map((_, j) => T.reduce((acc, row, m) => acc + row[i] * kT[m][j], 0)));
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) K[3 * e + i][3 * e + j] += ke[i][j];
  }
  const fixed = new Set([0, 1, 2]);
  if (ends === 'both') [dof - 3, dof - 2, dof - 1].forEach((d) => fixed.add(d));
  const free = [...Array(dof).keys()].filter((d) => !fixed.has(d));
  const at = ends === 'both' ? Math.round(n / 2) : n;
  // a unit load pressing square to the arc, towards its centre
  const ang = Number.isFinite(R) ? (span * at) / n / R - span / (2 * R) : 0;
  const f = new Array(dof).fill(0);
  f[3 * at] = -Math.sin(ang);
  f[3 * at + 1] = -Math.cos(ang);
  const u = solveDense(free.map((i) => free.map((j) => K[i][j])), free.map((i) => f[i]));
  const U = new Array(dof).fill(0);
  free.forEach((d, i) => {
    U[d] = u[i];
  });
  const give = -(U[3 * at] * Math.sin(ang) + U[3 * at + 1] * Math.cos(ang));
  // the largest bending moment, from each element's end turns and moves
  let peak = 0;
  for (let e = 0; e < n; e++) {
    const [x1, y1] = pts[e];
    const [x2, y2] = pts[e + 1];
    const L = Math.hypot(x2 - x1, y2 - y1);
    const cs = (x2 - x1) / L;
    const sn = (y2 - y1) / L;
    const across = (i) => [-U[3 * i] * sn + U[3 * i + 1] * cs, U[3 * i + 2]];
    const [v1, t1] = across(e);
    const [v2, t2] = across(e + 1);
    const EI = E * I;
    const M1 = (EI / L ** 2) * (6 * v1 + 4 * L * t1 - 6 * v2 + 2 * L * t2);
    const M2 = (EI / L ** 2) * (-6 * v1 - 2 * L * t1 + 6 * v2 - 4 * L * t2);
    peak = Math.max(peak, Math.abs(M1), Math.abs(M2));
  }
  return { k: 1 / give, strainPerMm: (peak * (t / 2)) / (E * I) / give };
}

// ---------- holds ----------

/**
 * How hard a locked lid can be pulled off (N): each of its three lugs gives
 * way at the least of bending over its overhang, shearing at its root and
 * punching through the lid's ledge under it. The key lug's extra width is
 * not counted. 250 N at the default clearance, falling as the clearance
 * grows (the lug's lever lengthens).
 * @returns {{ pull: number, perLug: number, by: 'bending'|'shear'|'punch' }}
 */
export function lugHold(S, material = 'PLA') {
  const { sigma, tau } = MATERIALS[material];
  const ways = {
    bending: (sigma * S.w * S.a * S.a) / (6 * (S.c + S.e / 2)),
    shear: tau * S.w * S.a,
    punch: tau * S.ledge * (S.w + 2 * S.ledge),
  };
  const by = Object.keys(ways).reduce((p, q) => (ways[q] < ways[p] ? q : p));
  return { pull: S.N * ways[by], perLug: ways[by], by };
}

/**
 * How hard a locked plug can be pulled out (N): the body's floor under each
 * slot shearing out round the lug, across the layers. About 605 N, so a
 * base and its tea light hang from it with room to spare.
 */
export function plugHold(S, material = 'PLA') {
  const { tau } = MATERIALS[material];
  return PLUG.N * tau * PLUG.floor * (PLUG.w + 2 * PLUG.floor);
}

/**
 * The click: the turn it takes to snap the tabs' ridges out of their
 * grooves (N·m), and the strain each tab bends to. Each tab is a curved
 * cantilever at radius r (its middle) pushed aside where its ridge is,
 * `S.ridgeIn` short of its free end – what lies past the ridge bends nothing
 * – by the ridge's printed interference – drawn `S.dd`, printed that and
 * twice the printer's wall error – over a 45° flank with friction.
 * @param {object} S `sizes()`
 * @param {number} r the tabs' middle radius (`collarFor` / `plugFor` `tabR`)
 * @param {number} tabs how many
 * @param {{ printer?: string, material?: string, nominal?: boolean }} options
 * @returns {{ torque: number, strain: number, ok: boolean, i: number }} strain in %, `ok` when the plastic takes it
 *   over and over
 */
export function click(S, r, tabs, { printer = 'tuned', material = 'PLA', nominal = false } = {}) {
  const M = MATERIALS[material];
  const { E, mu } = nominal ? M.nominal : M.weak;
  const i = r6(S.dd + 2 * PRINTERS[printer].delta);
  // a point load bends a beam's elements as cubics, which a few dozen of them follow exactly
  const beam = arcBeam({ R: r, span: S.Ld - S.ridgeIn, b: S.b, t: S.td, E, ends: 'one', n: 24 });
  const strain = beam.strainPerMm * i * 100;
  return { torque: ((tabs * beam.k * i * (1 + mu)) / (1 - mu)) * (r / 1000), strain, ok: strain <= M.strain + 1e-9, i };
}

// ---------- the least scale ----------

/**
 * The least scale at which `fits(s)` holds (to `tol`), or null when none up
 * to `to` does: a scan in steps of `step` to the first scale that fits,
 * then halving the step between it and the one before. `fits` measures the
 * model afresh at each scale (the joint's face moves as the model grows), so
 * it may be slow: the scan keeps the calls to a few dozen. As the face moves
 * a lock may also fit now and then a little below where it fits for good;
 * the scan steps over that, and the answer rounded up to a whole step
 * (`scalePercent`, with the defaults) is the first step that fits.
 */
export function leastScale(fits, { from = 1, to = 6, step = 0.05, tol = 0.0025 } = {}) {
  let lo = null;
  for (let k = 0; ; k++) {
    const s = r6(from + k * step);
    if (s > to + 1e-9) return null;
    if (fits(s)) {
      if (lo == null) return s;
      let hi = s;
      while (hi - lo > tol + 1e-9) {
        const mid = r6((lo + hi) / 2);
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    lo = s;
  }
}

// ---------- words ----------

/** An opening or a diameter for the texts: whole millimetres. */
export const roundOpening = (d) => Math.round(d);

/** A height for the texts: a tenth of a millimetre. */
export const roundZ = (z) => Math.round(z * 10) / 10;

/** A lift for the texts: up to the next half millimetre, so lifting by it always clears. */
export const roundLift = (L) => Math.ceil(L * 2 - 1e-9) / 2;

/** An angle for the texts: whole degrees. */
export const roundAngle = (a) => Math.round(a);

/** A force for the texts: to 10 N, as near as such a sum can say. */
export const roundForce = (F) => Math.round(F / 10) * 10;

/** A least scale for the texts (%): up to the next 5 %, so the scale said always fits. */
export const scalePercent = (s) => Math.ceil(s * 20 - 1e-9) * 5;

/** The scale a [Make it N %] button offers for a least scale (%): up to the next whole 100 %. */
export const offerPercent = (s) => Math.ceil(scalePercent(s) / 100 - 1e-9) * 100;

/**
 * Which way a lid slides out once lifted: under a handle whose span runs
 * along `handle` it goes square to it, between the legs – said so when its
 * way is within 45° of square. Without a handle, or along one, sideways.
 * @param {number[]} dir the way out, in plan [dx, dy] or in the world [dx, dy, dz]
 * @param {number[]|null} handle the handle's span, the same way, or null with no handle
 */
export function slideWords(dir, handle = null) {
  const lenD = Math.hypot(...dir);
  const lenH = handle ? Math.hypot(...handle) : 0;
  const dot = handle ? dir.reduce((sum, v, i) => sum + v * (handle[i] ?? 0), 0) : 0;
  if (lenH > 0 && Math.abs(dot) / (lenD * lenH) <= Math.SQRT1_2 + 1e-9) return 'under the handle, square to it';
  return 'sideways';
}

/**
 * How a part comes out once it is turned free, for the texts: 'lift it off'
 * when nothing is over it, else 'lift it 5 mm and slide it out under the
 * handle, square to it' (the lift rounded up, `roundLift`).
 * @param {{ lift: number, dir: number[]|null }} way the way out (`dir` null, or [0, 0], when it lifts straight off)
 * @param {number[]|null} handle the handle's span in plan, or null
 */
export function wayWords(way, handle = null) {
  const dir = way?.dir;
  if (!dir || !(Math.hypot(...dir) > 0)) return 'lift it off';
  return `lift it ${roundLift(way.lift)} mm and slide it out ${slideWords(dir, handle)}`;
}
