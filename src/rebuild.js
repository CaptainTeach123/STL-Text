import { DECOR_KINDS, normaliseDecorSpec } from './decor.js';
import { placementFrame } from './placement.js';

/**
 * From the details found on a model (see details.js), a plan for rebuilding
 * them: what each was meant to be, and the clean generated decoration to put
 * in its place. Details close together are first grouped – the leaves and
 * berries of a sprig, the petals and bud of a rosette are found as pieces –
 * and each group (or lone detail) is read by its shape: a tight sphere fit is
 * a berry; a footprint with five or more lobes and no elongation a star;
 * eight or more lobes, or a round group with a bud in its middle, a rosette;
 * a long footprint a leaf (a holly leaf when its outline is spiky); a long
 * group a sprig; anything else a dome, with little confidence.
 *
 * @param {Array} details  from findDetails
 * @param {object} [options]
 * @param {number} [options.featureSize]  the scale the details were found at
 * @returns {{ items: PlanItem[] }}
 *   PlanItem = { id, kind, label, confidence, spec, position, normal, direction, spin, sink, conform, size, height, extent,
 *     sources, note }
 *   where `spec` is the decoration to generate (see decor.js), `position`/`normal`/`spin`/`sink`/`conform` place it
 *   as a part by its bottom, draped over the surface, `extent` is the footprint it covers (length along `direction`,
 *   width across), `sources` are the ids of the details it replaces.
 */
export function planRebuild(details, { featureSize = 0 } = {}) {
  const F = featureSize > 0 ? featureSize : Math.max(1, ...details.map((d) => d.size)) * 3;
  const groups = groupDetails(details, F);
  const items = [];
  for (const group of groups) {
    const item = group.length === 1 ? readOne(group[0]) : readGroup(group, F);
    if (item) items.push({ id: items.length + 1, ...item });
    else for (const d of group) items.push({ id: items.length + 1, ...readOne(d) }); // a group that is no one thing: each piece on its own
  }
  return { items };
}

/** Groups of details that touch or nearly touch (gaps under a quarter of the feature scale), facing the same way. */
function groupDetails(details, F) {
  const n = details.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const gap = 0.25 * F;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = details[i], b = details[j];
      const dist = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]);
      const facing = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
      if (dist - (a.size + b.size) / 2 < gap && facing > 0.3) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(details[i]);
  }
  return [...byRoot.values()];
}

const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The spin (degrees about the normal) that turns a part's +x onto `direction` on a surface facing `normal`. */
function spinFor(normal, direction) {
  const { x, y } = placementFrame(normal, 0);
  const dx = direction[0] * x.x + direction[1] * x.y + direction[2] * x.z;
  const dy = direction[0] * y.x + direction[1] * y.y + direction[2] * y.z;
  if (Math.hypot(dx, dy) < 1e-6) return 0;
  return Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 10) / 10;
}

/** A point on the foot of the detail (its middle brought down to the foot level along the normal). */
function footPoint(d) {
  const middle = d.footMiddle ?? d.middle ?? d.center;
  const above = dot(middle, d.normal) - (d.footLevel ?? dot(middle, d.normal));
  return [middle[0] - d.normal[0] * above, middle[1] - d.normal[1] * above, middle[2] - d.normal[2] * above];
}

function place(kind, spec, { position, normal, direction, sag, height, confidence, sources, size, note, extent }) {
  // the decoration is draped over the surface it stands on (it follows a curve), so its skirt only has to reach a
  // little into the surface; the sag across the footprint adds some, within reason
  const skirt = Math.round((Math.min(Math.max(0, sag), 0.5 * height + 0.3, 1.5) * 0.5 + 0.3) * 10) / 10;
  const full = normaliseDecorSpec({ ...spec, kind, skirt });
  const dir = unit(direction ?? [1, 0, 0]);
  return {
    kind,
    label: DECOR_KINDS[kind].label,
    confidence,
    spec: full,
    position,
    normal: unit(normal),
    direction: dir,
    spin: spinFor(normal, dir),
    sink: Math.round((skirt + 0.05) * 100) / 100, // the skirt sunk, and a hair more so the base never lies in the surface
    conform: true,
    size,
    height,
    extent: extent ?? { length: size, width: size },
    sources,
    note,
  };
}

/**
 * The removing spots that cut a detail's smudgy original away before its clean version goes on: one round spot for
 * a compact detail, a row of them along a long one, each a little larger than the footprint they cover.
 * @returns {Array<{ position: number[], normal: number[], radius: number }>}
 */
export function removalSpotsFor(item) {
  const { length, width } = item.extent ?? { length: item.size, width: item.size };
  const across = Math.max(0.5, Math.min(length, width));
  const along = Math.max(length, width);
  const radius = Math.round(Math.max(1.5, 0.55 * across + 0.5) * 2) / 2;
  if (along <= 1.3 * across) return [{ position: item.position, normal: item.normal, radius: Math.round(Math.max(1.5, 0.55 * along + 0.5) * 2) / 2 }];
  // along the long axis, overlapping by a third
  const step = radius * 1.3;
  const span = along - 2 * radius * 0.7;
  const count = Math.max(2, Math.ceil(span / step) + 1);
  const dir = length >= width ? item.direction : unit(cross(item.normal, item.direction));
  const spots = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : -span / 2 + (span * i) / (count - 1);
    spots.push({ position: [item.position[0] + dir[0] * t, item.position[1] + dir[1] * t, item.position[2] + dir[2] * t], normal: item.normal, radius });
  }
  return spots;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** What one detail was meant to be. */
function readOne(d) {
  const height = Math.max(0.1, d.crest ?? d.height);
  const common = { position: footPoint(d), normal: d.normal, sag: d.sag ?? 0, height, sources: [d.id], size: d.size, direction: d.direction, extent: { length: 1.05 * (d.footLength ?? d.length ?? d.size), width: 1.05 * (d.footWidth ?? d.width ?? d.size) } };
  if (d.kind === 'round') {
    const radius = d.radius;
    // the sphere's centre stays where the fitted one is: the berry's base lies 0.65 radius below its centre
    const centreAbove = dot(d.center, d.normal) - (d.footLevel ?? dot(d.center, d.normal));
    const position = [d.center[0] - d.normal[0] * centreAbove, d.center[1] - d.normal[1] * centreAbove, d.center[2] - d.normal[2] * centreAbove];
    return place('berry', { radius }, { ...common, position, extent: { length: 2 * radius, width: 2 * radius }, sag: Math.max(0, (d.sag ?? 0) + centreAbove - 0.65 * radius), confidence: 0.9, note: 'a sphere fits it closely' });
  }
  const el = d.elongation ?? 1;
  const lobes = d.lobes ?? 0;
  // the region stops a ring short of the foot and the thin tips of a star or leaf read low: the footprint is a
  // little larger than measured
  const L = 1.05 * (d.footLength ?? d.length), W = 1.05 * (d.footWidth ?? d.width);
  const across = Math.max(L, W);
  if (lobes >= 7 && el < 1.4) {
    return place('rosette', { radius: across / 2, height, petals: Math.min(16, lobes) }, { ...common, confidence: 0.6, note: `${lobes} lobes around a round footprint` });
  }
  if (lobes >= 4 && el < 1.35) {
    // four to six lobes read on a smudgy outline: a five-point star, the usual one
    return place('star', { radius: across / 2, height, points: 5 }, { ...common, direction: d.lobeDirection, confidence: lobes === 5 ? 0.85 : 0.6, note: `${lobes} points around a round footprint` });
  }
  if (el >= 1.7) {
    const spiky = lobes >= 4;
    return place(spiky ? 'holly' : 'leaf', { length: L, width: W, height }, { ...common, direction: d.direction, confidence: el >= 2.2 ? 0.75 : 0.55, note: `a long footprint, ${el.toFixed(1)} times as long as wide${spiky ? ', with a spiky outline' : ''}` });
  }
  return place('dome', { length: Math.max(L, W), width: Math.min(L, W), height }, { ...common, direction: d.direction, confidence: 0.3, note: 'no clear shape: a rounded bump of the same extent' });
}

/** What a group of details close together was meant to be. */
function readGroup(group, F) {
  // the group's direction and extent: the principal axis of its members' middles, weighted by size
  let w = 0;
  const c = [0, 0, 0], nrm = [0, 0, 0];
  for (const d of group) {
    const m = footPoint(d);
    const wt = d.size;
    w += wt;
    for (let k = 0; k < 3; k++) {
      c[k] += m[k] * wt;
      nrm[k] += d.normal[k] * wt;
    }
  }
  for (let k = 0; k < 3; k++) c[k] /= w;
  const normal = unit(nrm);
  const { x, y } = placementFrame(normal, 0);
  const ax = [x.x, x.y, x.z], ay = [y.x, y.y, y.z];
  let sxx = 0, sxy = 0, syy = 0;
  const pts = group.map((d) => {
    const m = footPoint(d);
    const r = [m[0] - c[0], m[1] - c[1], m[2] - c[2]];
    return { u: dot(r, ax), v: dot(r, ay), d };
  });
  for (const p of pts) {
    sxx += p.u * p.u * p.d.size;
    sxy += p.u * p.v * p.d.size;
    syy += p.v * p.v * p.d.size;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of pts) {
    const a = p.u * cs + p.v * sn, b = -p.u * sn + p.v * cs;
    const half = p.d.size / 2;
    minA = Math.min(minA, a - half);
    maxA = Math.max(maxA, a + half);
    minB = Math.min(minB, b - half);
    maxB = Math.max(maxB, b + half);
  }
  const length = maxA - minA, width = maxB - minB;
  const midA = (minA + maxA) / 2, midB = (minB + maxB) / 2;
  const mu = midA * cs - midB * sn, mv = midA * sn + midB * cs;
  const position = [c[0] + mu * ax[0] + mv * ay[0], c[1] + mu * ax[1] + mv * ay[1], c[2] + mu * ax[2] + mv * ay[2]];
  const direction = [cs * ax[0] + sn * ay[0], cs * ax[1] + sn * ay[1], cs * ax[2] + sn * ay[2]];
  const height = Math.max(0.1, ...group.map((d) => d.crest ?? d.height));
  const sag = Math.max(0, ...group.map((d) => d.sag ?? 0));
  const sources = group.map((d) => d.id);
  const el = width > 1e-9 ? length / width : 1;
  const rounds = group.filter((d) => d.kind === 'round');
  const common = { position, normal, direction, sag, height, sources, size: Math.max(length, width), extent: { length, width } };
  if (rounds.length === group.length) return null; // berries close together: each stays a berry of its own
  if (el < 1.4) {
    const bud = rounds.find((d) => Math.hypot(d.center[0] - position[0], d.center[1] - position[1], d.center[2] - position[2]) < 0.3 * length);
    if (bud || group.length >= 4) {
      return place('rosette', { radius: Math.max(length, width) / 2, height, petals: Math.max(5, Math.min(16, group.length - (bud ? 1 : 0))) }, { ...common, confidence: bud ? 0.7 : 0.45, note: `${group.length} pieces around a round footprint${bud ? ', with a round bud in the middle' : ''}` });
    }
  }
  if (el >= 1.6) {
    return place('sprig', { length, width, height }, { ...common, confidence: group.length >= 3 ? 0.7 : 0.5, note: `${group.length} pieces along a line, ${el.toFixed(1)} times as long as wide` });
  }
  return place('dome', { length: Math.max(length, width), width: Math.min(length, width), height }, { ...common, confidence: 0.25, note: `${group.length} pieces close together with no clear shape` });
}

/** The decoration spec for a plan item read as another kind: sized from what was measured. */
export function specForKind(kind, item) {
  const L = Math.max(item.size, 0.5), W = Math.max(0.3, item.spec?.width ?? item.size * 0.5);
  const height = Math.max(0.1, item.height);
  const skirt = item.spec?.skirt ?? 0.3;
  switch (kind) {
    case 'berry':
      return normaliseDecorSpec({ kind, radius: item.spec?.radius ?? item.size * 0.4, skirt });
    case 'star':
      return normaliseDecorSpec({ kind, radius: item.size / 2, height, points: 5, skirt });
    case 'rosette':
      return normaliseDecorSpec({ kind, radius: item.size / 2, height, petals: 8, skirt });
    case 'leaf':
    case 'holly':
    case 'dome':
    case 'sprig':
      return normaliseDecorSpec({ kind, length: item.spec?.length ?? L, width: item.spec?.length ? item.spec.width : W, height, skirt });
    default:
      return normaliseDecorSpec({ kind: 'berry', radius: item.size * 0.4, skirt });
  }
}
