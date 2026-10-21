import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  FloatType,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  LatheGeometry,
  LineBasicMaterial,
  LinearFilter,
  LineSegments,
  Matrix4,
  Triangle,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
  RGBAFormat,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { INTERSECTED, MeshBVH, NOT_INTERSECTED, acceleratedRaycast } from 'three-mesh-bvh';
import { placedAt, snapTolerance } from './aim.js';
import { SEAT_WORD } from './locks.js';
import { geometryFromBuffers } from './mesh.js';
import { clickRadius, surfaceNormalAt } from './surfaceNormal.js';
import {
  APART_COLOR, CUT_COLOR, PIECE_COLORS, PIN_COLOR, TOO_BIG_COLOR, axisCuts, cellSizes, cutPlane, explodeOffset, letterFor, offsetAlongRay, pieceColorIndex,
  printTransform, printedFace, printedRow, snapTarget, triangleInBox, wayAt,
} from './split.js';

Mesh.prototype.raycast = acceleratedRaycast;

const COLORS = {
  model: 0x8aa4c8,
  passthrough: 0xe0a93a,
  emboss: 0xff8a2b,
  engrave: 0xff3b6b,
  detached: 0xb8bcc8, // an item that is not touching the model
  spot: 0x22d3a6, // a clean-up spot's ring
  marker: 0x22d3a6,
  cutHover: 0xa78bfa, // a cut's handle under the pointer or being dragged
  apartHover: 0x2dd4bf, // the same for a cut that comes apart
  tooBig: 0xd6294b, // the number of a piece too big for the printer (the page's --err)
};

/**
 * The model's section under a cut being placed, by the lip the engine finds
 * there: teal where a full lip with clips fits, amber where only a shorter or
 * clipless one does, red where none does; light while it is worked out, and
 * for a glued cut.
 */
const AIM_COLORS = { full: APART_COLOR, short: 0xf59e0b, none: COLORS.tooBig, neutral: 0xf8fafc };
/** The ticks beside it where it snaps: a seam of the model's, a spot suggested, where a full lip fits, and the one it snapped to. */
const TICK_COLORS = { seam: 0x64748b, spot: APART_COLOR, lip: 0xf59e0b, snapped: 0xff7a1a };

/**
 * A twist-lock in the pieces view: its own faces orange (the neck and grooves; the socket, slots and click tabs), its
 * lugs yellow so they stand out of the neck they are on, what carries it lighter (the collar, the socket ring), glowing
 * while its part is pointed at. As printed, a face of it that overhangs more than 45° is red, and its bridged ceilings
 * are outlined. A base's tea-light seat, cut with its lock but no part of it, is violet.
 */
export const LOCK_COLORS = Object.freeze({ lock: 0xff6a00, carry: 0xffb27a, lug: 0xffd60a, glow: 0xb84c00, over: 0xe11d48, bridge: 0xfacc15, seat: 0x8b5cf6 });

/** A part's circle in the model view: teal when its lock fits, amber when it only lifts off, red when it can't come out. */
const PART_STATE_COLORS = { lock: APART_COLOR, lift: 0xf59e0b, stuck: COLORS.tooBig };

/**
 * While a part is picked on the model: the part under the pointer gold, and the handle it leaves on the lantern drawn
 * in the colour of what stays. A selected part's ring handle is a white knob on its circle, ringed in the circle's
 * colour, with a dark two-headed arrow across it: something to drag, not a hole.
 */
export const HOVER_COLORS = Object.freeze({ part: 0xf2b705, stays: 0x2563eb, grip: 0x111827 });

/** What the pointer over a part's ring handle is told. */
export const GRIP_TITLE = 'Drag to make the circle wider or narrower';
/** The most islands of a handle on one level the outline follows (a lantern's two legs, or its crown). */
const HANDLE_BOXES = 4;

/** Boxes as a texture of `levels` columns and `HANDLE_BOXES` rows, each texel one box: x0, y0, x1, y1. */
function boxTexture(data, levels) {
  const t = new DataTexture(data, levels, HANDLE_BOXES, RGBAFormat, FloatType);
  t.magFilter = t.minFilter = NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** How long ▶ takes to show a part coming apart (ms). */
const WAY_PLAY_MS = 2500;
/** The most parts the model view tints at once (the split's cut limit). */
const TINTS = 12;
/** The class of a piece's triangle: the solid, unrepaired, and from here on its lock's materials (`#buildPieces`). */
const SOLID = 0;
const LOOSE = 1;

/** Triangle ranges `[start, count, mark]` clipped to the triangles t0 … t0 + tc, relative to t0. */
function marksWithin(ranges, t0, tc) {
  const out = [];
  for (const [start, count, mark] of ranges) {
    const a = Math.max(start, t0);
    const b = Math.min(start + count, t0 + tc);
    if (b > a) out.push([a - t0, b - a, mark]);
  }
  return out;
}

/** Smooth in and out over 0 … 1. */
const ease = (t) => t * t * (3 - 2 * t);

/**
 * What carries a lock (the collar, the socket ring) is added flush with the pieces' own face at the joint, and the
 * union leaves that face's triangles some its and some the face's: drawn as they come they are a fringe of slivers.
 * The triangles of class `k` lying in the joint's plane – facing along its axis, a hair from it – are the face's, and
 * go back to the solid's class.
 * @param {Uint8Array} cls each triangle's class, changed in place
 * @param {number} k the class of what carries the lock
 * @param {ArrayLike<number>} index the triangles' corners
 * @param {ArrayLike<number>} positions x, y, z of each corner
 * @param {number[]} at a point on the joint's plane
 * @param {number[]} axis the joint's axis
 * @returns {number} how many went back
 */
export function unmarkJoint(cls, k, index, positions, at, axis) {
  const len = Math.hypot(...axis);
  const [ax, ay, az] = axis.map((v) => v / len);
  const plane = at[0] * ax + at[1] * ay + at[2] * az;
  const p = (t, j) => index[t * 3 + j] * 3;
  let n = 0;
  for (let t = 0; t < cls.length; t++) {
    if (cls[t] !== k) continue;
    const [a, b, c] = [p(t, 0), p(t, 1), p(t, 2)];
    const u = [0, 1, 2].map((i) => positions[b + i] - positions[a + i]);
    const v = [0, 1, 2].map((i) => positions[c + i] - positions[a + i]);
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    const area = Math.hypot(nx, ny, nz);
    if (!(area > 0)) continue;
    const middle = [0, 1, 2].map((i) => (positions[a + i] + positions[b + i] + positions[c + i]) / 3);
    if (Math.abs(nx * ax + ny * ay + nz * az) / area > 0.995 && Math.abs(middle[0] * ax + middle[1] * ay + middle[2] * az - plane) < 0.02) {
      cls[t] = SOLID;
      n++;
    }
  }
  return n;
}

const CLICK_PX = 5;
const CLICK_MS = 500;

/** Past this many cells the live preview is left out: every cell draws the whole model again. */
const CELL_PREVIEW_MAX = 12;
/** Grids with more slots than this are not even scanned for the preview. */
const CELL_SCAN_MAX = 4096;

/** The two in-plane axes (u, v) of a cut across each axis, so that u × v is the cut's normal. */
const CUT_UV = [
  [1, 2],
  [2, 0],
  [0, 1],
];

const AXIS_VECTORS = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cssColor = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const boxArrays = (box) => ({ min: box.min.toArray(), max: box.max.toArray() });

/** The slot of `t` among sorted cut positions; a point on a cut is in the lower slot, as in split.js. */
function slot(t, cuts) {
  let i = 0;
  while (i < cuts.length && t > cuts[i]) i++;
  return i;
}

/**
 * Mark every slot of the grid between the cuts that some triangle enters,
 * for a geometry placed by `matrix` (a Matrix4) when given. A triangle
 * within one slot marks it; one across a cut is tested against each slot
 * its box overlaps, as its box can claim a slot it misses (the long sides of
 * a cone span the empty slots round its tip). Sampling vertices instead
 * would lose a slot between two cuts that no vertex falls in, such as the
 * middle of a long plain box.
 */
function markCells(seen, geometry, byAxis, grid, matrix = null) {
  const pos = geometry.attributes.position.array;
  const index = geometry.index?.array ?? null;
  const triangles = index ? index.length / 3 : pos.length / 9;
  const e = matrix?.elements ?? null;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const corners = new Float64Array(9);
  const from = [0, 0, 0];
  const to = [0, 0, 0];
  const slo = [0, 0, 0];
  const shi = [0, 0, 0];
  const edge = (a, c, upper) => (upper ? (c < byAxis[a].length ? byAxis[a][c] : Infinity) : c > 0 ? byAxis[a][c - 1] : -Infinity);
  for (let t = 0; t < triangles; t++) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Infinity;
      hi[a] = -Infinity;
    }
    for (let k = 0; k < 3; k++) {
      const v = (index ? index[t * 3 + k] : t * 3 + k) * 3;
      const x = pos[v];
      const y = pos[v + 1];
      const z = pos[v + 2];
      if (e) {
        corners[3 * k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        corners[3 * k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        corners[3 * k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      } else {
        corners[3 * k] = x;
        corners[3 * k + 1] = y;
        corners[3 * k + 2] = z;
      }
      for (let a = 0; a < 3; a++) {
        if (corners[3 * k + a] < lo[a]) lo[a] = corners[3 * k + a];
        if (corners[3 * k + a] > hi[a]) hi[a] = corners[3 * k + a];
      }
    }
    for (let a = 0; a < 3; a++) {
      from[a] = slot(lo[a], byAxis[a]);
      to[a] = slot(hi[a], byAxis[a]);
    }
    const across = from[0] !== to[0] || from[1] !== to[1] || from[2] !== to[2];
    for (let k = from[2]; k <= to[2]; k++) {
      for (let j = from[1]; j <= to[1]; j++) {
        for (let i = from[0]; i <= to[0]; i++) {
          const s = (k * grid[1] + j) * grid[0] + i;
          if (seen[s]) continue;
          if (across) {
            [i, j, k].forEach((c, a) => {
              slo[a] = edge(a, c, false);
              shi[a] = edge(a, c, true);
            });
            if (!triangleInBox(corners, lo, hi, slo, shi)) continue;
          }
          seen[s] = 1;
        }
      }
    }
  }
}

/** Rays askew of the axes, so that none runs along a face or through an edge of a box-shaped model. */
const PROBE_RAYS = [new Vector3(1, 0.31, 0.17), new Vector3(-0.23, 1, 0.41), new Vector3(0.37, -0.29, 1)].map((v) => v.normalize());

/**
 * Mark the slots that lie wholly inside the model. A slot no triangle
 * reaches is all inside or all outside, so one point of it tells which: an
 * odd number of crossings of the model's surface (its unrepaired triangles,
 * material group 1, left out), as most of three rays find. A slot on the
 * outside of the grid runs on to infinity past its last cut, so it is
 * outside and is never tested.
 */
function markEnclosed(seen, geometry, byAxis, grid) {
  const bvh = geometry.boundsTree;
  if (!bvh || grid.some((n) => n < 3)) return;
  const sides = geometry.groups.length ? [DoubleSide, DoubleSide] : DoubleSide;
  const ray = new Ray();
  for (let k = 1; k < grid[2] - 1; k++) {
    for (let j = 1; j < grid[1] - 1; j++) {
      for (let i = 1; i < grid[0] - 1; i++) {
        const s = (k * grid[1] + j) * grid[0] + i;
        if (seen[s]) continue;
        const cell = [i, j, k];
        ray.origin.fromArray(cell.map((c, a) => (byAxis[a][c - 1] + byAxis[a][c]) / 2));
        let votes = 0;
        for (const dir of PROBE_RAYS) {
          ray.direction.copy(dir);
          const crossings = bvh.raycast(ray, sides).filter((hit) => hit.face.materialIndex !== 1).length;
          votes += crossings % 2;
        }
        if (votes >= 2) seen[s] = 1;
      }
    }
  }
}

/** The slots marked by `markCells`, as cells `[i, j, k]` in the order of `cellSizes`. */
function markedCells(seen, grid) {
  const cells = [];
  for (let k = 0; k < grid[2]; k++) {
    for (let j = 0; j < grid[1]; j++) {
      for (let i = 0; i < grid[0]; i++) if (seen[(k * grid[1] + j) * grid[0] + i]) cells.push([i, j, k]);
    }
  }
  return cells;
}

/**
 * The cuts a caller passed, read as planes `{ id, letter, axis, at, apart }`.
 * Takes the document's cuts (`{ id, position, normal, joint? }`, lettered by
 * their place in the list) or normalised ones (`apart: { hold }`); a cut that
 * is not straight is left out. What a cut's dovetail tabs add to the pieces
 * (`reach`, `w`: see `cellSizes`) is kept; `apart` says it comes apart.
 */
function readCuts(cuts) {
  const out = [];
  (cuts ?? []).forEach((cut, i) => {
    const plane = cutPlane(cut);
    if (!plane) return;
    out.push({
      id: cut.id ?? `c${i + 1}`,
      letter: cut.letter ?? letterFor(i),
      axis: plane.axis,
      at: plane.at,
      apart: cut.joint === 'apart' || !!cut.apart,
      ...(cut.reach ? { reach: cut.reach, w: cut.w } : {}),
    });
  });
  return out;
}

/**
 * The section of a mesh by the plane across `axis` at `at`: a segment for
 * each triangle that crosses it, as pairs of points, read through the mesh's
 * BVH so that only the triangles by the plane are looked at – a dense model's
 * section follows the pointer on every frame. A corner on the plane counts as
 * above it, so a face lying in the plane is outlined once, by the walls below
 * it, and never crossed itself.
 * @param {BufferGeometry} geometry indexed, with its `boundsTree`
 * @param {number} axis 0, 1 or 2
 * @param {number} at
 * @param {Float32Array|null} [out] reused when it is big enough (it is grown otherwise: the result says which array holds the points)
 * @returns {{ positions: Float32Array, count: number }} `count` segments, six numbers each
 */
export function sectionSegments(geometry, axis, at, out = null) {
  let positions = out ?? new Float32Array(6 * 1024);
  let count = 0;
  const bvh = geometry?.boundsTree;
  const index = geometry?.index?.array;
  if (!bvh || !index) return { positions, count };
  const pos = geometry.attributes.position.array;
  const key = ['x', 'y', 'z'][axis];
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const put = (o, i, j, d0, d1) => {
    // where the edge from corner i (d0 from the plane) to corner j (d1) crosses it
    const t = d0 / (d0 - d1);
    positions[o + axis] = at;
    positions[o + u] = pos[i + u] + (pos[j + u] - pos[i + u]) * t;
    positions[o + v] = pos[i + v] + (pos[j + v] - pos[i + v]) * t;
  };
  bvh.shapecast({
    intersectsBounds: (box) => (box.min[key] <= at && box.max[key] >= at ? INTERSECTED : NOT_INTERSECTED),
    intersectsRange: (offset, n) => {
      for (let k = offset; k < offset + n; k++) {
        const tri = bvh.resolveTriangleIndex(k) * 3;
        const a = index[tri] * 3;
        const b = index[tri + 1] * 3;
        const c = index[tri + 2] * 3;
        const da = pos[a + axis] - at;
        const db = pos[b + axis] - at;
        const dc = pos[c + axis] - at;
        const sa = da >= 0;
        const sb = db >= 0;
        if (sa === sb && sb === dc >= 0) continue;
        if (count * 6 + 6 > positions.length) {
          const grown = new Float32Array(positions.length * 2);
          grown.set(positions);
          positions = grown;
        }
        // the corner alone on its side, and the two edges from it
        const [lone, dl, p, dp, q, dq] = sa === sb ? [c, dc, a, da, b, db] : sa === dc >= 0 ? [b, db, c, dc, a, da] : [a, da, b, db, c, dc];
        put(count * 6, lone, p, dl, dp);
        put(count * 6 + 3, lone, q, dl, dq);
        count++;
      }
      return false;
    },
  });
  return { positions, count };
}

/** The colour of a cut's plane, edge, handle and badge: teal for one that comes apart, violet for a glued one. */
const cutColor = (cut) => (cut.apart ? APART_COLOR : CUT_COLOR);

/** Triangle ranges `[start, count]` clipped to the triangles t0 … t0 + tc, relative to t0. */
function rangesWithin(ranges, t0, tc) {
  const out = [];
  for (const [start, count] of ranges) {
    const a = Math.max(start, t0);
    const b = Math.min(start + count, t0 + tc);
    if (b > a) out.push([a - t0, b - a]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** Material groups: 0 for the solid, 1 for the unrepaired triangles in `ranges`. */
function addGroups(geometry, ranges, triangles) {
  let cursor = 0;
  for (const [start, count] of ranges) {
    if (start > cursor) geometry.addGroup(cursor * 3, (start - cursor) * 3, 0);
    geometry.addGroup(start * 3, count * 3, 1);
    cursor = start + count;
  }
  if (cursor < triangles) geometry.addGroup(cursor * 3, (triangles - cursor) * 3, 0);
}

/**
 * A round badge with a short text on it (a cut's letter, a piece's number).
 * It always faces the camera and keeps its size on screen; `userData.px` is
 * that size, applied by the viewer as the canvas or the camera changes.
 */
function labelSprite(text, { fill, ring = null, px = 22 }) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (ring) {
    ctx.lineWidth = 9;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${text.length > 2 ? 44 : text.length > 1 ? 58 : 70}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 4);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, transparent: true }));
  sprite.renderOrder = 13;
  sprite.raycast = () => {}; // never picked: the handle beside it is
  sprite.userData.px = px;
  return sprite;
}

function disposeSprite(sprite) {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

/**
 * A part's ring handle, as big as the place a press grabs it (scaled in mm, as its circle is): a white knob ringed in
 * `ring`, a dark two-headed arrow across it – it resizes the circle.
 */
function gripSprite(ring) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = ring;
  ctx.stroke();
  // the arrow, across the knob: a shaft and a head at each end
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = cssColor(HOVER_COLORS.grip);
  ctx.fillStyle = cssColor(HOVER_COLORS.grip);
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(-24, 0);
  ctx.lineTo(24, 0);
  ctx.stroke();
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 46, 0);
    ctx.lineTo(s * 18, -24);
    ctx.lineTo(s * 18, 24);
    ctx.closePath();
    ctx.fill();
  }
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  // drawn small, the arrow stays dark rather than averaged into the white round it
  map.generateMipmaps = false;
  map.minFilter = LinearFilter;
  const sprite = new Sprite(new SpriteMaterial({ map, depthTest: false, transparent: true }));
  sprite.renderOrder = 13;
  sprite.raycast = () => {}; // never picked: the handle under it is
  return sprite;
}

/** A small white dot ringed in dark, `px` CSS pixels across whatever the zoom: the point under the pointer while a cut is placed. */
function dotSprite(px = 11) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#1b2230';
  ctx.stroke();
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, transparent: true }));
  sprite.raycast = () => {};
  sprite.userData.px = px;
  return sprite;
}

/**
 * A double arrow one unit long along +z: a cut's handle, pointing the two
 * ways the cut can be dragged.
 */
function handleGeometry() {
  const r = 0.22; // arrow head radius
  const s = 0.07; // shaft radius
  const h = 0.4; // arrow head length
  const profile = [
    [0, -0.5],
    [r, -0.5 + h],
    [s, -0.5 + h],
    [s, 0.5 - h],
    [r, 0.5 - h],
    [0, 0.5],
  ].map(([x, y]) => new Vector2(x, y));
  return new LatheGeometry(profile, 24).rotateX(Math.PI / 2);
}

/**
 * Three.js scene for the editor. Z is up (like STL files and slicers).
 *
 *  - the model ("base") is drawn from buffers the worker prepared, with the
 *    BVH it serialised, so picking is instant even on huge files
 *  - every text item is its own overlay mesh; the selected one is drawn
 *    solid, the others faded
 *  - clicking an item selects it, clicking bare model moves the selected
 *    item, dragging the selected item moves it live
 *  - the "final result" mesh can replace the model on screen while picking
 *    still happens on the (hidden) model
 *  - a split for printing draws its cuts as violet planes (teal for one that
 *    comes apart) with a lettered badge and a handle that drags the plane
 *    along its axis; while editing, the model is coloured by the piece each
 *    part of it will go to (clipping planes on the GPU, so it follows a drag
 *    on every frame); the computed pieces replace the model in the "pieces"
 *    view, pulled apart by Spread
 *
 * View modes (`viewMode`): 'model' (the model and the text being edited),
 * 'result' (the final result) and 'pieces' (the computed pieces). Hover and
 * clicks on the model only happen where the model is where it is drawn,
 * which the exploded pieces view is not.
 *
 * Renders on demand, so an idle page costs nothing.
 */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true; // the live piece preview clips the model per piece; materials without planes pay nothing
    container.appendChild(this.renderer.domElement);
    this.viewSize = [container.clientWidth || 800, container.clientHeight || 600]; // CSS pixels, kept up to date by #resize

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(60, -90, 70);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // a view zoomed or turned under a still pointer while a cut is placed: the plane goes where the pointer now is
    this.controls.addEventListener('change', () => {
      this.requestRender();
      this.#aimAgain();
    });

    this.scene.add(new HemisphereLight(0xffffff, 0x445066, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, -0.8, 1.2);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.materials = {
      model: new MeshStandardMaterial({ color: COLORS.model, roughness: 0.55, metalness: 0.05, side: FrontSide }), // a closed solid: back faces never show, and culling them halves the fill work on every frame
      passthrough: new MeshStandardMaterial({ color: COLORS.passthrough, roughness: 0.6, metalness: 0.05, side: DoubleSide }),
    };
    // a part's material tinted in the model view (setParts): its circle (x, y, r), the heights it takes and its colour
    this.tint = {
      count: { value: 0 },
      disc: { value: Array.from({ length: TINTS }, () => new Vector3()) },
      span: { value: Array.from({ length: TINTS }, () => new Vector2()) },
      color: { value: Array.from({ length: TINTS }, () => new Color()) },
    };
    this.tintCount = 0;
    // the part under the pointer while one is picked on the model (setPartHover): its material gold, and the handle it
    // leaves on the lantern outlined in the colour of what stays – its islands' boxes, level by level, in a texture
    this.hoverTint = {
      on: { value: 0 },
      disc: { value: new Vector3() },
      span: { value: new Vector2() },
      color: { value: new Color(HOVER_COLORS.part) },
      handleOn: { value: 0 },
      handleBoxes: { value: boxTexture(new Float32Array(4 * HANDLE_BOXES), 1) },
      handleLevels: { value: 0 },
      handleFrom: { value: 0 },
      handleStep: { value: 1 },
      handleGrow: { value: 0 },
      handleColor: { value: new Color(HOVER_COLORS.stays) },
    };
    this.materials.model.onBeforeCompile = (shader) => {
      shader.uniforms.tintCount = this.tint.count;
      shader.uniforms.tintDisc = this.tint.disc;
      shader.uniforms.tintSpan = this.tint.span;
      shader.uniforms.tintColor = this.tint.color;
      const h = this.hoverTint;
      Object.assign(shader.uniforms, {
        hoverOn: h.on, hoverDisc: h.disc, hoverSpan: h.span, hoverColor: h.color, handleOn: h.handleOn, handleBoxes: h.handleBoxes,
        handleLevels: h.handleLevels, handleFrom: h.handleFrom, handleStep: h.handleStep, handleGrow: h.handleGrow, handleColor: h.handleColor,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTintAt;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvTintAt = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform int tintCount;\nuniform vec3 tintDisc[${TINTS}];\nuniform vec2 tintSpan[${TINTS}];\nuniform vec3 tintColor[${TINTS}];\nvarying vec3 vTintAt;
          uniform int hoverOn;\nuniform vec3 hoverDisc;\nuniform vec2 hoverSpan;\nuniform vec3 hoverColor;
          uniform int handleOn;\nuniform sampler2D handleBoxes;\nuniform int handleLevels;\nuniform float handleFrom;\nuniform float handleStep;\nuniform float handleGrow;\nuniform vec3 handleColor;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          for (int i = 0; i < ${TINTS}; i++) {
            if (i >= tintCount) break;
            if (vTintAt.z >= tintSpan[i].x && vTintAt.z <= tintSpan[i].y && distance(vTintAt.xy, tintDisc[i].xy) <= tintDisc[i].z) diffuseColor.rgb = mix(diffuseColor.rgb, tintColor[i], 0.5);
          }
          if (hoverOn == 1 && vTintAt.z >= hoverSpan.x && vTintAt.z <= hoverSpan.y && distance(vTintAt.xy, hoverDisc.xy) <= hoverDisc.z) diffuseColor.rgb = mix(diffuseColor.rgb, hoverColor, 0.7);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          if (handleOn == 1) {
            // on a level of the handle's (or the one either side, as a leg leans between them): inside one of its boxes
            int j = int(floor((vTintAt.z - handleFrom) / handleStep + 0.5));
            bool held = false;
            for (int dj = -1; dj <= 1; dj++) {
              int k = j + dj;
              if (k < 0 || k >= handleLevels) continue;
              for (int b = 0; b < ${HANDLE_BOXES}; b++) {
                vec4 box = texelFetch(handleBoxes, ivec2(k, b), 0);
                if (vTintAt.x >= box.x - handleGrow && vTintAt.x <= box.z + handleGrow && vTintAt.y >= box.y - handleGrow && vTintAt.y <= box.w + handleGrow) held = true;
              }
            }
            // a light tint, and its edges as seen drawn in the colour: an outline that follows the handle as it turns
            if (held) {
              float edge = smoothstep(0.5, 0.8, 1.0 - abs(dot(normalize(normal), normalize(vViewPosition))));
              diffuseColor.rgb = mix(diffuseColor.rgb, handleColor, 0.3 + 0.7 * edge);
            }
          }`,
        );
    };
    this.baseMesh = null;
    this.baseDimmed = false;
    this.resultMesh = null;
    this.resultShown = false; // the final result (or the pieces) asked for; viewMode says what is actually shown
    this.overlays = new Map(); // itemId -> { mesh, mode, selected, stale }

    this.marker = new Group();
    const ring = new Mesh(
      new RingGeometry(0.7, 1, 40),
      new MeshBasicMaterial({ color: COLORS.marker, side: DoubleSide, depthTest: false, transparent: true }),
    );
    const stem = new Mesh(
      new CylinderGeometry(0.06, 0.06, 1.6, 8).rotateX(Math.PI / 2).translate(0, 0, 0.8),
      new MeshBasicMaterial({ color: COLORS.marker, depthTest: false }),
    );
    ring.renderOrder = stem.renderOrder = 10;
    this.marker.add(ring, stem);
    this.marker.visible = false;
    this.scene.add(this.marker);

    // split for printing: cut planes, the live piece preview and the computed pieces
    this.shapes = {
      quad: new PlaneGeometry(1, 1),
      handle: handleGeometry(),
      pick: new SphereGeometry(0.5, 12, 8),
    };
    this.shapes.edges = new EdgesGeometry(this.shapes.quad);
    this.pickMaterial = new MeshBasicMaterial();
    this.cutGroup = new Group();
    this.cuts = new Map(); // cutId -> { id, letter, axis, at, selected, group, fill, edge, handle, pick, badge }
    this.cutBoundsGiven = null; // the bounds the caller measured (model and text); the model's own otherwise
    this.hoverCutId = null;
    this.cutDrag = null; // { id, at } while a handle is being dragged
    this.cutSnap = { step: 1, shift: 5 }; // mm a drag snaps to, without and with Shift
    this.cellGroup = new Group();
    this.cellSpec = null; // { cuts, tooBig }
    this.cellMeshes = new Map(); // 'i,j,k' -> { mesh, cell, bounds: [{ plane, axis, index, upper }] }
    this.cellKey = null;
    this.cellOrder = null;
    this.pieceGroup = new Group();
    this.pieceLabelGroup = new Group();
    this.pieceEntries = []; // { mesh, kind: 'piece' | 'pin' | 'part', index, cell, fits }
    this.pieceLabels = []; // { sprite, index, centre, cell }
    this.pieceGrid = [0, 0, 0];
    this.pieceBounds = null;
    this.spread = 1;
    this.piecesStale = false;
    this.pieceHighlight = null;
    // the parts a split takes out, as their pieces move: each one's way out from the piece it comes out of
    this.pieceWays = new Map(); // piece index -> { cutId, way, point: Vector3, out: Vector3, home, drop }
    this.lockHighlight = new Set(); // the cuts whose lock glows
    this.asPrinted = false; // the pieces as they lie on the bed, not exploded
    this.wayPlay = null; // { frame, resolve } while ▶ plays a part coming apart
    this.lookAside = null; // the piece of a part set down beside its lock while the lock is looked at
    this.lookSeat = false; // what is looked at there is a base's tea-light seat, from over it, not its lock
    this.lookPose = null; // where the camera was put to look at it (`#pose`)
    this.lockLabels = []; // { cutId, name, piece, at } where a lock's lugs, slots and click tabs are (the engine's)
    this.lockWords = null; // { el, items: [{ el, name, points }] } the words on the lock looked at, in the page over the view
    this.insets = null; // () => ({ top, bottom }) CSS pixels of the view under the page's own controls: framing keeps clear of them
    this.onSpread = null; // (f) the view moved the pieces itself: a way played, the lock looked at
    // the parts a split takes out: each the circle it takes out, on its face
    this.partGroup = new Group();
    this.partCircles = []; // { group, badge, dispose }
    this.partsKey = '';
    this.partHover = null; // the part a click would take out while one is picked on the model (setPartHover)
    this.partHoverKey = '';
    this.partHoverShape = null; // { group, dispose } its circle and walls
    this.partHoverHandle = false; // whether the handle it leaves on is outlined
    this.scene.add(this.cutGroup, this.cellGroup, this.pieceGroup, this.pieceLabelGroup, this.partGroup);

    // placing a cut from the view (see setAim): a plane that follows the pointer, the model's section on it, the point
    // under the pointer and ticks where it snaps
    this.aim = null; // { axis } while a place for a cut is being picked on the model
    this.aimTargets = { axis: null, list: [] }; // what a cut across that axis snaps to, picked or dragged
    this.aimVerdict = null; // 'full' | 'short' | 'none' from the engine, or null: the section's colour
    this.aimHover = null; // { at, raw, target, point, screen, pinned } the place under the pointer while picking
    this.aimPreview = null; // { axis, at, verdict } a place shown with no pointer on the model (a suggestion hovered)
    this.aimLast = null; // the pointer and its keys at the last move while picking or dragging, for Alt pressed or let go
    this.aimTouch = null; // { pointerId, before } the finger sliding the plane on a touch screen, and the plane before it
    this.dragTarget = null; // what a dragged handle snapped to
    this.sectionKey = null;
    this.sectionBuffer = null;
    this.ticksKey = null;
    this.#buildAim();

    this.grid = null;
    this.bounds = new Box3(new Vector3(-50, -50, 0), new Vector3(50, 50, 10));
    this.#buildGrid();

    this.raycaster = new Raycaster();
    this.raycaster.firstHitOnly = true;
    this.onPick = null; // ({ point, normal }) clicked bare model
    this.onSelectItem = null; // (itemId) clicked an item
    this.onDrag = null; // ({ itemId, point, normal, done })
    this.onSelectCut = null; // (cutId) pressed a cut's handle
    this.onCutDrag = null; // ({ id, at, target, done, screen }) dragged a cut's handle; `target` what it snapped to
    this.onPartDrag = null; // ({ id, r, pxPerMm, done, cancelled }) dragged a part's ring handle: the radius under the pointer
    this.onAim = null; // ({ at, raw, target, point, free, screen, pinned }) the place under the pointer while picking (`free`: Alt held), or ({ at: null }) none
    this.onAimPick = null; // ({ at, target, shift, point, free }) clicked the model while picking
    this.hoverEnabled = true;
    this.#bindPointer();
    this.#applyVisibility();

    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(container);
    this.#resize();
    this.frame();
  }

  requestRender() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (this.lockWords) this.#placeLockWords();
    });
  }

  /* ------------------------------------------------------------- model */

  /** Mesh from worker display buffers, split into model / passthrough groups. */
  #meshFromDisplay(display) {
    const geometry = geometryFromBuffers(display);
    const triangles = display.index.length / 3;
    const ranges = display.passthroughRanges ?? (display.passthroughStart < triangles ? [[display.passthroughStart, triangles - display.passthroughStart]] : []);
    addGroups(geometry, ranges, triangles);
    if (display.bvhRoots?.length) {
      geometry.boundsTree = MeshBVH.deserialize(
        { version: display.bvhVersion, roots: display.bvhRoots, index: display.index, indirectBuffer: null },
        geometry,
        { setIndex: true },
      );
    }
    geometry.computeBoundingBox();
    return new Mesh(geometry, [this.materials.model, this.materials.passthrough]);
  }

  #disposeMesh(mesh) {
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.boundsTree = null;
    mesh.geometry.dispose();
  }

  /** Show the model (display buffers from the worker), or nothing for null. */
  setBase(display) {
    this.#clearCells(); // the preview shares the model's geometry: it goes before that is freed
    this.#disposeMesh(this.baseMesh);
    this.baseMesh = null;
    this.setResult(null);
    this.cutBoundsGiven = null; // measured on the old model; the next setCuts brings the new ones
    if (display && display.index.length) {
      this.baseMesh = this.#meshFromDisplay(display);
      this.scene.add(this.baseMesh);
      this.bounds.copy(this.baseMesh.geometry.boundingBox);
    } else {
      this.bounds.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 10));
    }
    this.#buildGrid();
    this.marker.visible = false;
    this.#updateCells();
    this.#applyVisibility(); // also sizes the cut planes to the new bounds
  }

  /** Show (or clear) the final result in place of the model. It replaces any pieces. */
  setResult(display) {
    this.#disposeMesh(this.resultMesh);
    this.resultMesh = null;
    this.#clearPieces();
    if (display && display.index.length) {
      this.resultMesh = this.#meshFromDisplay(display);
      this.scene.add(this.resultMesh);
    }
    this.showResult(this.resultShown);
  }

  /** Dim the model while the worker re-derives it (a material change only: no geometry work). */
  setBaseDimmed(on) {
    const m = this.materials.model;
    m.transparent = !!on;
    m.opacity = on ? 0.75 : 1;
    this.baseDimmed = !!on;
    this.#styleCells();
    this.requestRender();
  }

  /**
   * Show the computed result (the pieces when there are any, else the final
   * result) in place of the model, or go back to the model.
   */
  showResult(on) {
    this.resultShown = !!on && (!!this.resultMesh || this.pieceEntries.length > 0);
    this.#applyVisibility();
  }

  /** What is on screen: 'model', 'result' or 'pieces'. */
  get viewMode() {
    if (!this.resultShown) return 'model';
    if (this.pieceEntries.length) return 'pieces';
    return this.resultMesh ? 'result' : 'model';
  }

  /** What is drawn: as `viewMode`, but the model while a suggestion's plane is previewed on it (`previewAim`). */
  #shownMode() {
    return this.aimPreview ? 'model' : this.viewMode;
  }

  #applyVisibility() {
    const mode = this.#shownMode();
    const cells = mode === 'model' && this.cellMeshes.size > 0;
    if (this.baseMesh) this.baseMesh.visible = mode === 'model' && !cells; // hidden under the preview, but still what clicks land on
    this.cellGroup.visible = cells;
    if (this.resultMesh) this.resultMesh.visible = mode === 'result';
    this.pieceGroup.visible = this.pieceLabelGroup.visible = mode === 'pieces';
    this.partGroup.visible = mode === 'model';
    this.tint.count.value = mode === 'model' ? this.tintCount : 0; // the model's material draws the final result too
    // the part a click would take out, on the model only
    const hover = mode === 'model' && !!this.partHover;
    this.hoverTint.on.value = hover ? 1 : 0;
    this.hoverTint.handleOn.value = hover && this.partHoverHandle ? 1 : 0;
    if (this.partHoverShape) this.partHoverShape.group.visible = hover;
    this.cutGroup.visible = !(mode === 'pieces' && this.asPrinted); // as printed, the pieces are not where the cuts are
    for (const o of this.overlays.values()) o.mesh.visible = mode === 'model';
    if (mode === 'pieces') this.marker.visible = false;
    this.#layoutCuts(); // the planes sit in the gaps between exploded pieces
    this.#syncAim(); // only drawn on the model, which may have new bounds
    this.requestRender();
  }

  get hasModel() {
    return !!this.baseMesh;
  }

  /* ---------------------------------------------------------- overlays */

  #overlayMaterial(mode) {
    if (mode === 'engrave') return new MeshStandardMaterial({ color: COLORS.engrave, roughness: 0.6, flatShading: true, transparent: true, opacity: 0.6, depthTest: false });
    if (mode === 'spot') return new MeshStandardMaterial({ color: COLORS.spot, roughness: 0.5, flatShading: true, transparent: true, opacity: 0.7 });
    return new MeshStandardMaterial({ color: COLORS.emboss, roughness: 0.45, flatShading: true, transparent: true, opacity: 1 });
  }

  #styleOverlay(o) {
    const base = o.mode === 'engrave' ? 0.6 : o.mode === 'spot' ? 0.7 : 1;
    const fade = o.selected ? 1 : 0.55;
    const stale = o.stale ? 0.7 : 1;
    const loose = o.detached ? 0.55 : 1;
    o.mesh.material.opacity = base * fade * stale * loose;
    o.mesh.material.color.set(o.detached ? COLORS.detached : o.mode === 'engrave' ? COLORS.engrave : o.mode === 'spot' ? COLORS.spot : COLORS.emboss);
    o.mesh.material.wireframe = !!o.detached;
    o.mesh.material.transparent = true;
    o.mesh.renderOrder = o.mode === 'engrave' ? 5 : 0;
    o.mesh.visible = this.#shownMode() === 'model';
  }

  /**
   * Create or replace the overlay for an item. `geometry` is
   * { positions, index } in the item's local frame, `matrix` its placement.
   */
  setOverlay(itemId, { geometry, matrix, mode, selected = false }) {
    let o = this.overlays.get(itemId);
    const flat = geometryFromBuffers({ positions: geometry.positions, index: geometry.index }).toNonIndexed();
    flat.computeVertexNormals();
    if (o) {
      o.mesh.geometry.dispose();
      o.mesh.geometry = flat;
      if (o.mode !== mode) {
        o.mesh.material.dispose();
        o.mesh.material = this.#overlayMaterial(mode);
      }
    } else {
      const mesh = new Mesh(flat, this.#overlayMaterial(mode));
      mesh.matrixAutoUpdate = false;
      mesh.userData.itemId = itemId;
      this.scene.add(mesh);
      o = { mesh, mode, selected, stale: false, detached: false };
      this.overlays.set(itemId, o);
    }
    o.mode = mode;
    o.selected = selected;
    o.stale = false;
    o.mesh.matrix.fromArray(matrix);
    this.#styleOverlay(o);
    this.requestRender();
  }

  removeOverlay(itemId) {
    const o = this.overlays.get(itemId);
    if (!o) return;
    this.scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    o.mesh.material.dispose();
    this.overlays.delete(itemId);
    this.requestRender();
  }

  /** Keep only the given item ids. */
  pruneOverlays(keepIds) {
    for (const id of [...this.overlays.keys()]) if (!keepIds.has(id)) this.removeOverlay(id);
  }

  setOverlaySelected(selectedId) {
    for (const [id, o] of this.overlays) {
      o.selected = id === selectedId;
      this.#styleOverlay(o);
    }
    this.requestRender();
  }

  /** Dim an overlay while new geometry is being computed for it. */
  setOverlayStale(itemId, stale) {
    const o = this.overlays.get(itemId);
    if (!o || o.stale === stale) return;
    o.stale = stale;
    this.#styleOverlay(o);
    this.requestRender();
  }

  /** Show an item as not touching the model (grey wireframe) or back to normal. */
  setOverlayDetached(itemId, detached) {
    const o = this.overlays.get(itemId);
    if (!o || o.detached === !!detached) return;
    o.detached = !!detached;
    this.#styleOverlay(o);
    this.requestRender();
  }

  /** Move an overlay without new geometry (placement-only change). */
  setOverlayMatrix(itemId, matrix) {
    const o = this.overlays.get(itemId);
    if (!o) return;
    o.mesh.matrix.fromArray(matrix instanceof Matrix4 ? matrix.toArray() : matrix);
    this.requestRender();
  }

  hasOverlay(itemId) {
    return this.overlays.has(itemId);
  }

  /* -------------------------------------------------------- cut planes */

  /**
   * Show the cuts of a split as violet planes across the model – teal for
   * one that comes apart – each with its letter and a handle that drags it,
   * or none for null. Cuts that are not straight along X, Y or Z are left
   * out. Existing planes are updated in place, so this is cheap to call on
   * every render.
   * @param {object[]|null} cuts the document's cuts (`{ id, position, normal, joint? }`, lettered by list order) or normalised ones (`{ id, letter, axis, at, apart? }`)
   * @param {{ selectedId?: string|null, bounds?: { min: number[], max: number[] }|null }} [options]
   *   `bounds` (model and text, e.g. from the engine's measure) sizes the planes and limits a drag; the model's bounds without it
   */
  setCuts(cuts, { selectedId = null, bounds = null } = {}) {
    this.cutBoundsGiven = bounds ? new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max)) : null;
    const list = readCuts(cuts);
    const keep = new Set(list.map((c) => c.id));
    for (const id of [...this.cuts.keys()]) if (!keep.has(id)) this.#removeCut(id);
    for (const c of list) {
      const o = this.cuts.get(c.id) ?? this.#addCut(c);
      if (o.axis !== c.axis) {
        o.axis = c.axis;
        this.#orientCut(o);
      }
      if (o.letter !== c.letter || o.apart !== c.apart) {
        o.apart = c.apart;
        o.fill.material.color.setHex(cutColor(o));
        o.edge.material.color.setHex(cutColor(o));
        this.#letterCut(o, c.letter);
      }
      o.at = this.cutDrag?.id === c.id ? this.cutDrag.at : c.at; // a render during a drag must not snap the plane back
      o.selected = c.id === selectedId;
    }
    if (this.hoverCutId && !this.cuts.has(this.hoverCutId)) this.hoverCutId = null;
    this.#styleCuts();
    this.#updateCells(); // the bounds may have changed which cells the cuts make
    this.#applyVisibility(); // places the planes
  }

  /**
   * Show the parts a split takes out on the model (not on the pieces, which are the parts themselves), each as the
   * circle it takes out on its face, seen through the model, with its letter: teal when its lock fits, amber when it
   * only lifts off, red when it can't come out or cuts something. Once its lock is known, three marks on the circle
   * where the lock's lugs are, the wide key's bigger; once where it ends is known (`top`), its material from its face
   * up to there tinted the same colour. None for an empty list. Drawn again only when they change.
   * @param {{ id: string, letter: string, axis: number, position: number[], r: number, selected?: boolean,
   *   state?: 'lock'|'lift'|'stuck', lugs?: boolean, top?: number|null }[]} parts
   */
  setParts(parts = []) {
    const key = JSON.stringify(parts);
    if (key === this.partsKey) return;
    this.partsKey = key;
    for (const c of this.partCircles) {
      this.partGroup.remove(c.group);
      c.dispose();
    }
    this.partCircles = parts.map((p) => this.#partCircle(p));
    for (const c of this.partCircles) this.partGroup.add(c.group);
    // the tint is drawn by the model's own material: each part's circle and the heights it takes, across Z
    const tinted = parts.filter((p) => p.axis === 2 && Number.isFinite(p.top)).slice(0, TINTS);
    tinted.forEach((p, i) => {
      const [lo, hi] = [Math.min(p.position[2], p.top), Math.max(p.position[2], p.top)];
      this.tint.disc.value[i].set(p.position[0], p.position[1], p.r);
      this.tint.span.value[i].set(lo, hi);
      this.tint.color.value[i].setHex(PART_STATE_COLORS[p.state] ?? APART_COLOR);
    });
    this.tintCount = tinted.length;
    this.#applyVisibility();
  }

  /**
   * The part a click would take out while one is picked on the model, or null for none: its material from its face up
   * to where it ends (`top`) tinted gold, its circle drawn on its face and its prism's walls faintly up to its end;
   * and the handle it leaves on the lantern (`handle`: its islands' boxes level by level, `[{ z, boxes }]`, the levels
   * `step` apart) outlined in the colour of what stays. The plane that follows the pointer gives way to it. Drawn
   * again only when it changes.
   * @param {{ centre: number[], r: number, face: number, top: number, handle?: { step: number, levels: { z: number,
   *   boxes: number[][] }[] }|null }|null} spec
   */
  setPartHover(spec) {
    const key = spec ? JSON.stringify(spec) : '';
    if (key === this.partHoverKey) return;
    this.partHoverKey = key;
    this.partHover = spec ?? null;
    const h = this.hoverTint;
    if (this.partHoverShape) {
      this.scene.remove(this.partHoverShape.group);
      this.partHoverShape.dispose();
      this.partHoverShape = null;
    }
    this.partHoverHandle = false;
    if (spec) {
      const [x, y] = spec.centre;
      const [lo, hi] = [Math.min(spec.face, spec.top), Math.max(spec.face, spec.top)];
      h.disc.value.set(x, y, spec.r);
      h.span.value.set(lo, hi);
      const levels = spec.handle?.levels ?? [];
      if (levels.length && spec.handle.step > 0) {
        const { step } = spec.handle;
        const from = levels[0].z;
        const n = Math.round((levels.at(-1).z - from) / step) + 1;
        // a texel with no box holds an empty one, which nothing is inside
        const data = new Float32Array(4 * n * HANDLE_BOXES);
        for (let i = 0; i < n * HANDLE_BOXES; i++) data.set([1e9, 1e9, -1e9, -1e9], 4 * i);
        for (const lv of levels) {
          const j = Math.round((lv.z - from) / step);
          lv.boxes.slice(0, HANDLE_BOXES).forEach((b, k) => data.set(b, 4 * (k * n + j)));
        }
        h.handleBoxes.value.dispose();
        h.handleBoxes.value = boxTexture(data, n);
        h.handleLevels.value = n;
        h.handleFrom.value = from;
        h.handleStep.value = step;
        h.handleGrow.value = step;
        this.partHoverHandle = true;
      }
      this.partHoverShape = this.#hoverShape(spec);
      this.scene.add(this.partHoverShape.group);
    }
    this.#applyVisibility();
    this.#syncAim();
  }

  /** The circle on a hovered part's face, over everything, and its prism's walls up to where it ends, faint. */
  #hoverShape({ centre, r, face, top }) {
    const group = new Group();
    const n = 128;
    const points = new Float32Array(n * 6);
    for (let k = 0; k < n; k++) {
      const [a, b] = [(2 * Math.PI * k) / n, (2 * Math.PI * (k + 1)) / n];
      points.set([r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(b), r * Math.sin(b), 0], k * 6);
    }
    const line = new BufferGeometry();
    line.setAttribute('position', new BufferAttribute(points, 3));
    const edge = new LineSegments(line, new LineBasicMaterial({ color: HOVER_COLORS.part, depthTest: false, transparent: true }));
    edge.renderOrder = 12;
    edge.position.set(centre[0], centre[1], face);
    const height = Math.abs(top - face);
    const wall = new Mesh(
      new CylinderGeometry(r, r, height, n, 1, true).rotateX(Math.PI / 2),
      new MeshBasicMaterial({ color: HOVER_COLORS.part, transparent: true, opacity: 0.1, side: DoubleSide, depthWrite: false }),
    );
    wall.position.set(centre[0], centre[1], (face + top) / 2);
    wall.renderOrder = 7;
    for (const o of [edge, wall]) o.raycast = () => {};
    group.add(wall, edge);
    const dispose = () => {
      line.dispose();
      edge.material.dispose();
      wall.geometry.dispose();
      wall.material.dispose();
    };
    return { group, dispose };
  }

  #partCircle({ id = null, letter, axis, position, r, selected = false, state = 'lock', lugs = false }) {
    const group = new Group();
    const [u, v] = CUT_UV[axis];
    group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(AXIS_VECTORS[u], AXIS_VECTORS[v], AXIS_VECTORS[axis]));
    group.position.fromArray(position);
    const hex = PART_STATE_COLORS[state] ?? APART_COLOR;
    const n = 128;
    const points = new Float32Array(n * 6);
    for (let k = 0; k < n; k++) {
      const [a, b] = [(2 * Math.PI * k) / n, (2 * Math.PI * (k + 1)) / n];
      points.set([r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(b), r * Math.sin(b), 0], k * 6);
    }
    const line = new BufferGeometry();
    line.setAttribute('position', new BufferAttribute(points, 3));
    // the outline seen through the shell round it, the disc faint behind the model
    const edge = new LineSegments(line, new LineBasicMaterial({ color: hex, transparent: true, opacity: selected ? 1 : 0.8, depthTest: false }));
    edge.raycast = () => {};
    edge.renderOrder = 11;
    const fill = new Mesh(new RingGeometry(0, r, n), new MeshBasicMaterial({ color: hex, transparent: true, opacity: selected ? 0.3 : 0.16, side: DoubleSide, depthWrite: false }));
    fill.raycast = () => {};
    fill.renderOrder = 6;
    group.add(fill, edge);
    // the lugs: three tabs standing out of the circle at 0°, 120° and 240° about its axis, as the lugs stand out of
    // the neck, the key's wider
    let marks = null;
    if (lugs) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const a = (2 * Math.PI * k) / 3;
        const h = 0.14 * r;
        const w = (k === 0 ? 0.65 : 0.5) * h;
        const [c, sn] = [Math.cos(a), Math.sin(a)];
        const at = (x, y) => [x * c - y * sn, x * sn + y * c, 0];
        tri.push(...at(r - 0.02 * r, -w), ...at(r + h, -w), ...at(r + h, w), ...at(r - 0.02 * r, -w), ...at(r + h, w), ...at(r - 0.02 * r, w));
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(tri), 3));
      marks = new Mesh(g, new MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.95, side: DoubleSide, depthTest: false }));
      marks.raycast = () => {};
      marks.renderOrder = 11;
      group.add(marks);
    }
    const badge = labelSprite(letter, { fill: cssColor(hex), ring: '#ffffff', px: selected ? 27 : 22 });
    // on the circle, between two lugs when they are drawn
    if (lugs) badge.position.set(r * Math.cos(Math.PI / 3), r * Math.sin(Math.PI / 3), 0);
    else badge.position.set(r, 0, 0);
    badge.scale.setScalar(this.#spriteScale(badge.userData.px));
    group.add(badge);
    // the selected part's ring handle on its outline, clear of its letter and its lugs, and turned off the X axis a
    // lantern's handle usually stands on: dragged, the circle grows or shrinks (`onPartDrag`)
    let grip = null;
    let pick = null;
    if (selected && id) {
      const size = clamp(0.015 * this.bounds.getSize(new Vector3()).length(), 0.5, 8);
      grip = gripSprite(cssColor(hex));
      grip.scale.setScalar(2.6 * size); // as wide as the place a press grabs it
      grip.position.set(r * Math.cos(-Math.PI / 3), r * Math.sin(-Math.PI / 3), 0);
      pick = new Mesh(this.shapes.pick, this.pickMaterial);
      pick.visible = false;
      pick.scale.setScalar(2.6 * size);
      pick.position.copy(grip.position);
      pick.userData.partId = id;
      group.add(grip, pick);
    }
    const dispose = () => {
      line.dispose();
      edge.material.dispose();
      fill.geometry.dispose();
      fill.material.dispose();
      marks?.geometry.dispose();
      marks?.material.dispose();
      if (grip) disposeSprite(grip);
      disposeSprite(badge);
    };
    return { group, badge, grip, dispose, pick, id, axis, position, r };
  }

  /** Where a part's ring handle is on screen, in CSS pixels from the canvas's top left, or null (none drawn: not selected). */
  partGripPosition(id) {
    const c = this.partCircles.find((x) => x.id === id && x.pick);
    if (!c || !this.partGroup.visible) return null;
    this.partGroup.updateMatrixWorld(true);
    const p = c.pick.getWorldPosition(new Vector3()).project(this.camera);
    const [w, h] = this.viewSize;
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  }

  /** The part whose ring handle is under the pointer (its circle as drawn), or null. */
  #pickGrip(event) {
    const picks = this.partCircles.filter((c) => c.pick);
    if (!picks.length || !this.partGroup.visible) return null;
    this.partGroup.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    const hit = this.raycaster.intersectObjects(picks.map((c) => c.pick), false)[0];
    return hit ? picks.find((c) => c.pick === hit.object) ?? null : null;
  }

  /** One pointer move of a ring handle's drag: the circle's radius is how far from its centre the pointer is on its face. */
  #dragGrip(drag, event) {
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    const plane = new Plane(AXIS_VECTORS[drag.axis].clone(), -drag.position[drag.axis]);
    const p = this.raycaster.ray.intersectPlane(plane, new Vector3());
    if (!p) return; // looking along the face: this move says nothing about the circle
    const [u, v] = CUT_UV[drag.axis];
    const r = Math.hypot(p.getComponent(u) - drag.position[u], p.getComponent(v) - drag.position[v]);
    if (!(r > 0)) return;
    drag.r = r;
    this.onPartDrag?.({ id: drag.partId, r, pxPerMm: this.#pxPerMm(p.toArray(), u), done: false });
  }

  /** Move one cut's plane (and the piece preview) to `at` mm along its axis, without rebuilding anything. */
  setCutOffset(id, at) {
    const c = this.cuts.get(id);
    if (c) c.at = at;
    const p = this.cellSpec?.cuts.find((x) => x.id === id);
    if (p) p.at = at;
    this.#updateCells({ live: true });
    this.#applyVisibility();
  }

  /**
   * Snapping while a handle is dragged: to `step` mm, or `shift` mm with
   * Shift held (0 turns snapping off).
   */
  setCutSnap(step = 1, shift = 5) {
    this.cutSnap = { step: Math.max(0, Number(step) || 0), shift: Math.max(0, Number(shift) || 0) };
  }

  /** Where a cut's handle is on screen, in CSS pixels from the canvas's top left (the readout goes there), or null. */
  cutScreenPosition(id) {
    const c = this.cuts.get(id);
    if (!c) return null;
    this.camera.updateMatrixWorld();
    const p = c.handle.getWorldPosition(new Vector3()).project(this.camera);
    const [w, h] = this.viewSize;
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  }

  #cutBounds() {
    return this.cutBoundsGiven ?? this.bounds;
  }

  #addCut({ id, letter, axis, at, apart = false }) {
    const color = cutColor({ apart });
    const fill = new Mesh(this.shapes.quad, new MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: DoubleSide, depthWrite: false }));
    fill.raycast = () => {}; // the model behind a plane stays clickable: only the handle picks a cut
    fill.renderOrder = 6;
    const edge = new LineSegments(this.shapes.edges, new LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false }));
    edge.raycast = () => {};
    edge.renderOrder = 11;
    const handle = new Mesh(this.shapes.handle, new MeshBasicMaterial({ color, side: DoubleSide, depthTest: false, transparent: true }));
    handle.raycast = () => {};
    handle.renderOrder = 12;
    // a larger, invisible ball around the handle is what picks it, so a thin arrow is easy to grab
    const pick = new Mesh(this.shapes.pick, this.pickMaterial);
    pick.visible = false;
    pick.userData.cutId = id;
    const group = new Group();
    group.add(fill, edge, handle, pick);
    this.cutGroup.add(group);
    const c = { id, letter: null, axis, at, apart, selected: false, group, fill, edge, handle, pick, badge: null };
    this.cuts.set(id, c);
    this.#orientCut(c);
    this.#letterCut(c, letter);
    return c;
  }

  #removeCut(id) {
    const c = this.cuts.get(id);
    if (!c) return;
    this.cutGroup.remove(c.group);
    c.fill.material.dispose();
    c.edge.material.dispose();
    c.handle.material.dispose();
    disposeSprite(c.badge);
    this.cuts.delete(id);
  }

  /** Turn a cut's group so its local z is the cut's normal and local x, y its in-plane axes. */
  #orientCut(c) {
    const [u, v] = CUT_UV[c.axis];
    c.group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(AXIS_VECTORS[u], AXIS_VECTORS[v], AXIS_VECTORS[c.axis]));
  }

  #letterCut(c, letter) {
    if (c.badge) {
      c.group.remove(c.badge);
      disposeSprite(c.badge);
    }
    c.letter = letter;
    c.badge = labelSprite(letter, { fill: cssColor(cutColor(c)), ring: '#ffffff' });
    c.badge.scale.setScalar(this.#spriteScale(c.badge.userData.px));
    c.group.add(c.badge);
  }

  /** How big the planes across the bounds are drawn: the bounds' faces plus a margin, grown by `gaps[a]` mm along each axis. */
  #planeLayout(gaps = [0, 0, 0]) {
    const box = this.#cutBounds();
    const size = box.getSize(new Vector3()).toArray();
    const centre = box.getCenter(new Vector3()).toArray();
    const diag = Math.max(Math.hypot(...size), 1);
    const extent = size.map((s, a) => s + 2 * Math.max(0.075 * s, 0.03 * diag) + gaps[a]);
    return { box, centre, diag, extent };
  }

  /** Sizes and places every plane: the bounds' face plus a margin, the handle just outside it, clear of the model. */
  #layoutCuts() {
    if (!this.cuts.size) return;
    const list = [...this.cuts.values()];
    const byAxis = axisCuts(list, boxArrays(this.#cutBounds()));
    const exploded = this.#shownMode() === 'pieces';
    const gap = exploded ? this.#explodeGap() : 0;
    // exploded pieces spread out by one gap per cut, so the planes grow with them
    const { centre, diag, extent } = this.#planeLayout(byAxis.map((l) => l.length * gap));
    const handle = clamp(0.09 * diag, 3, 80);
    for (const c of list) {
      const [u, v] = CUT_UV[c.axis];
      const onAxis = byAxis[c.axis];
      const rank = onAxis.indexOf(c.at);
      // each cut stays in the middle of the gap between the pieces either side of it (see explodeOffset)
      const shift = exploded && rank >= 0 ? (rank + 0.5 - onAxis.length / 2) * gap : 0;
      const at = [...centre];
      at[c.axis] = c.at + shift;
      c.group.position.fromArray(at);
      c.fill.scale.set(extent[u], extent[v], 1);
      c.edge.scale.copy(c.fill.scale);
      // each axis has its own side, so handles of crossing cuts never sit on one another: an X cut's above the top edge,
      // a Y cut's off the right-hand edge, a level cut's in front of the near edge (all on local v, see CUT_UV)
      const out = [0, c.axis === 2 ? -1 : 1, 0];
      const edgeAt = extent[v] / 2;
      c.handle.position.fromArray(out.map((d) => d * (edgeAt + 0.6 * handle)));
      c.handle.scale.setScalar(handle);
      c.pick.position.copy(c.handle.position);
      c.pick.scale.setScalar(handle * 1.15);
      c.badge.position.fromArray(out.map((d) => d * (edgeAt + 1.45 * handle)));
    }
  }

  #styleCuts() {
    for (const c of this.cuts.values()) {
      const active = c.id === this.hoverCutId || c.id === this.cutDrag?.id;
      c.fill.material.opacity = c.selected ? 0.28 : 0.14;
      c.edge.material.opacity = c.selected ? 1 : 0.6;
      c.handle.material.color.setHex(active ? (c.apart ? COLORS.apartHover : COLORS.cutHover) : cutColor(c));
      c.handle.material.opacity = c.selected || active ? 1 : 0.8;
      c.badge.userData.px = c.selected ? 27 : 22;
      c.badge.scale.setScalar(this.#spriteScale(c.badge.userData.px));
    }
    this.requestRender();
  }

  #pickCut(event) {
    if (!this.cuts.size) return null;
    this.cutGroup.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    const hit = this.raycaster.intersectObjects([...this.cuts.values()].map((c) => c.pick), false)[0];
    return hit ? hit.object.userData.cutId : null;
  }

  /** One pointer move of a handle drag: the plane follows the point of its axis nearest the pointer's ray. */
  #dragCut(drag, event) {
    const c = this.cuts.get(drag.cutId);
    if (!c) return;
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    const { origin, direction } = this.raycaster.ray;
    const t = offsetAlongRay(origin.toArray(), direction.toArray(), drag.p, drag.n);
    if (t === null) return; // looking straight along the axis: this move says nothing about where the plane goes
    this.aimLast = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey };
    const step = event.shiftKey ? this.cutSnap.shift : this.cutSnap.step;
    const box = this.#cutBounds();
    let at = drag.start + (t - drag.t0);
    // the model's seams and the spots suggested pull a cut that comes apart in from a few pixels away, as when it is
    // placed on the model – never onto another cut across the axis, where it would do nothing; Alt drags it freely, and
    // a glued cut always goes by the steps
    const others = [...this.cuts.values()].filter((o) => o.id !== c.id && o.axis === c.axis).map((o) => o.at);
    const list = !event.altKey && c.apart && this.aimTargets.axis === c.axis ? this.aimTargets.list.filter((tg) => !others.some((o) => Math.abs(o - tg.at) < 0.05)) : [];
    const near = [...drag.p];
    near[c.axis] = at;
    const target = list.length ? snapTarget(list, at, snapTolerance(this.#pxPerMm(near, c.axis))) : null;
    if (target) at = target.at;
    else if (step > 0) at = Math.round(at / step) * step;
    at = clamp(at, box.min.getComponent(c.axis) - 1, box.max.getComponent(c.axis) + 1);
    at = Math.round(at * 1e4) / 1e4;
    if (at === drag.at && target === drag.target) return;
    drag.at = at;
    drag.target = target;
    this.dragTarget = target;
    this.cutDrag = { id: c.id, at };
    this.setCutOffset(c.id, at); // and the section under it, with the ticks
    this.onCutDrag?.({ id: c.id, at, target, done: false, screen: this.cutScreenPosition(c.id) });
  }

  /* -------------------------------------------- placing a cut from the view */

  #buildAim() {
    const pr = this.renderer.getPixelRatio();
    // the plane is turned like a cut's group (see #orientCut); the section and the ticks are in world space
    const plane = new Group();
    const fill = new Mesh(this.shapes.quad, new MeshBasicMaterial({ color: AIM_COLORS.neutral, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false }));
    fill.raycast = () => {};
    fill.renderOrder = 6;
    const edge = new LineSegments(this.shapes.edges, new LineBasicMaterial({ color: AIM_COLORS.neutral, transparent: true, opacity: 0.9, depthTest: false }));
    edge.raycast = () => {};
    edge.renderOrder = 11;
    plane.add(fill, edge);
    // wide lines (in device pixels), drawn over the model so the whole section shows
    const lines = (material) => {
      const line = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ depthTest: false, transparent: true, ...material }));
      line.frustumCulled = false; // their points change as the pointer moves: no bounds are kept up to date
      line.raycast = () => {};
      line.visible = false;
      return line;
    };
    const section = lines({ color: AIM_COLORS.neutral, linewidth: 3 * pr });
    section.renderOrder = 14;
    const ticks = lines({ vertexColors: true, linewidth: 2.5 * pr });
    ticks.renderOrder = 13;
    const dot = dotSprite();
    dot.renderOrder = 15;
    dot.scale.setScalar(this.#spriteScale(dot.userData.px));
    plane.visible = dot.visible = false;
    this.aimParts = { plane, fill, edge, section, ticks, dot };
    this.scene.add(plane, section, ticks, dot);
  }

  /**
   * Pick a place for a cut on the model: while on, a plane across `axis`
   * follows the point under the pointer (snapped to the targets given with
   * `setAimTargets`, unless Alt is held), with the model's section on it and
   * a dot on the point, and `onAim` hears of each move; a click on the model
   * calls `onAimPick` instead of `onPick`, and never selects or drags an item
   * or a handle. On a touch screen, where nothing hovers, a touch on the
   * model puts the plane there and a slide moves it; when the finger lifts
   * it stays (`pinned`), for the caller to place the cut there. Only in the
   * model view: the pieces are drawn pulled apart, away from the model the
   * pointer would be read on.
   * @param {{ axis: number, snap?: boolean, plane?: boolean }|null} aim null ends it; `snap` false places it freely (a
   *   glued cut); `plane` false draws no plane (a part's own cut, picked again, goes only to a part)
   */
  setAim(aim) {
    this.aim = aim ? { axis: aim.axis, snap: aim.snap !== false, plane: aim.plane !== false } : null;
    this.#aimTouchEnd();
    this.aimHover = null;
    this.aimVerdict = null;
    this.ticksKey = null;
    this.marker.visible = false;
    this.renderer.domElement.style.cursor = '';
    this.#syncAim();
  }

  /**
   * What a cut across `axis` snaps to while it is placed or its handle
   * dragged: `[{ at, kind: 'seam'|'spot'|'lip', … }]` (see aim.js
   * `aimTargets`), drawn as ticks beside the plane.
   */
  setAimTargets(axis, list) {
    this.aimTargets = { axis, list: list ?? [] };
    this.#syncAim();
    this.#aimAgain(); // a target that comes up beside the pointer (where a full lip fits, a spot) pulls the plane to it now
  }

  /** The colour of the section: 'full', 'short' or 'none' from the lip the engine finds there, or null while it is not known. */
  setAimVerdict(verdict) {
    if (this.aimVerdict === (verdict ?? null)) return;
    this.aimVerdict = verdict ?? null;
    this.#syncAim();
  }

  /**
   * Show a plane and the section across `axis` at `at` (a suggestion
   * hovered), coloured by `verdict`, over the pointer's; null hides it. With
   * the pieces or the final result shown, the model is drawn instead while
   * it is shown: the pieces are pulled apart, away from where the plane is.
   */
  previewAim(spec) {
    const was = this.#shownMode();
    this.aimPreview = spec ? { axis: spec.axis, at: spec.at, verdict: spec.verdict ?? null } : null;
    if (this.#shownMode() !== was) this.#applyVisibility();
    else this.#syncAim();
  }

  /**
   * Give up a handle being dragged, as a cancelled pointer does: the plane
   * goes back where it was. Whether one was being dragged.
   */
  cancelCutDrag() {
    return this.cancelDrag?.() ?? false;
  }

  /** How many pixels a millimetre along `axis` spans on screen at `point`. */
  #pxPerMm(point, axis) {
    this.camera.updateMatrixWorld();
    const a = new Vector3(...point).project(this.camera);
    const b = new Vector3(...point);
    b.setComponent(axis, b.getComponent(axis) + 1).project(this.camera);
    const [w, h] = this.viewSize;
    return Math.hypot(((b.x - a.x) * w) / 2, ((b.y - a.y) * h) / 2);
  }

  /** The place under the pointer while picking: on the model, snapped (Alt: freely, to 0.1 mm), or null off it or in the pieces view. */
  #aimPoint(event, alt = event.altKey) {
    if (this.viewMode !== 'model') return null;
    const hit = this.#pickModel(event);
    if (!hit) return null;
    const axis = this.aim.axis;
    const raw = hit.point[axis];
    const list = alt || !this.aim.snap || this.aimTargets.axis !== axis ? [] : this.aimTargets.list;
    const target = list.length ? snapTarget(list, raw, snapTolerance(this.#pxPerMm(hit.point, axis))) : null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { at: placedAt(raw, target), raw, target, point: hit.point, free: !!alt, screen: [event.clientX - rect.left, event.clientY - rect.top] };
  }

  /**
   * The pointer moved while picking: the plane follows it, and the caller
   * hears where it is. A finger sliding off the model (`keep`) leaves the
   * plane where it last was on it, and lifted there it stays (`pinned`).
   */
  #aimMove(event, { pinned = false, keep = false } = {}) {
    if (pinned) this.aimNext = null; // a move still waiting for its frame must not unpin it
    this.aimLast = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey, pointerType: event.pointerType };
    const h = this.#aimPoint(event);
    this.aimHover = h ? { ...h, pinned } : (pinned || keep) && this.aimHover ? { ...this.aimHover, pinned } : null;
    this.renderer.domElement.style.cursor = h ? 'crosshair' : '';
    this.#syncAim();
    this.onAim?.(this.aimHover ?? { at: null });
  }

  /**
   * The place under a still pointer worked out again, on the next frame:
   * the view zoomed or turned, or the targets changed, so that the plane, the
   * readout and what a click places stay the same place. Never for a plane a
   * finger pinned (it has no pointer), nor while a finger slides one.
   */
  #aimAgain() {
    const last = this.aimLast;
    if (!this.aim || !last || last.pointerType === 'touch' || this.aimHover?.pinned || this.aimTouch) return;
    this.#aimFrame(last);
  }

  /**
   * A finger that was sliding the plane is done: lifted (`event`), the plane
   * stays where it last was on the model; or (`cancel`) a second finger came
   * down for a pinch or a pan of the view, and the plane goes back to what it
   * was before the finger touched.
   */
  #aimTouchEnd({ event = null, cancel = false } = {}) {
    const t = this.aimTouch;
    if (!t) return;
    this.aimTouch = null;
    this.aimNext = null; // a move still waiting for its frame was the finger's
    if (cancel) {
      this.aimHover = t.before;
      this.#syncAim();
      this.onAim?.(this.aimHover ?? { at: null });
    } else if (event && this.aim) this.#aimMove(event, { pinned: true });
  }

  /** Draw what is being placed: a suggestion hovered, else the place under the pointer while picking, else the section under a dragged handle. */
  #syncAim() {
    const p = this.aimParts;
    if (!p) return;
    const drag = this.cutDrag ? this.cuts.get(this.cutDrag.id) : null;
    const shown =
      this.aimPreview ??
      (this.aim && this.aimHover ? { axis: this.aim.axis, at: this.aimHover.at, verdict: this.aimVerdict } : null) ??
      (drag ? { axis: drag.axis, at: this.cutDrag.at, verdict: this.aimVerdict, handle: true } : null);
    const model = this.#shownMode() === 'model';
    // over a part a click would take out, the part is drawn instead of the plane
    const onPart = !!this.aim && (!!this.partHover || !this.aim.plane) && !this.aimPreview;
    p.plane.visible = !!shown && !shown.handle && model && !onPart; // a dragged cut has its own plane
    p.section.visible = !!shown && model && !!this.baseMesh && !onPart;
    p.dot.visible = !this.aimPreview && !!this.aim && !!this.aimHover && model;
    if (shown) {
      const color = AIM_COLORS[shown.verdict] ?? AIM_COLORS.neutral;
      p.fill.material.color.setHex(color);
      p.edge.material.color.setHex(color);
      p.section.material.color.setHex(color);
      this.#placeAim(shown.axis, shown.at);
      if (p.section.visible) this.#sectionAt(shown.axis, shown.at);
    }
    if (p.dot.visible) p.dot.position.fromArray(this.aimHover.point);
    const axis = this.aim?.axis ?? drag?.axis ?? null;
    const ticks = model && !onPart && axis !== null && this.aimTargets.axis === axis && this.aimTargets.list.length > 0;
    p.ticks.visible = ticks;
    if (ticks) this.#layoutTicks(axis, (this.aim ? this.aimHover?.target : this.dragTarget) ?? null);
    this.requestRender();
  }

  /** The preview plane across `axis` at `at`, as big as the cut planes. */
  #placeAim(axis, at) {
    const { centre, extent } = this.#planeLayout();
    const [u, v] = CUT_UV[axis];
    const { plane, fill, edge } = this.aimParts;
    plane.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(AXIS_VECTORS[u], AXIS_VECTORS[v], AXIS_VECTORS[axis]));
    centre[axis] = at;
    plane.position.fromArray(centre);
    fill.scale.set(extent[u], extent[v], 1);
    edge.scale.copy(fill.scale);
  }

  /** The model's section across `axis` at `at` (worked out again only when the place or the model changes). */
  #sectionAt(axis, at) {
    const geometry = this.baseMesh?.geometry;
    const key = geometry ? `${geometry.uuid}|${axis}|${at}` : null;
    if (key === this.sectionKey) return;
    this.sectionKey = key;
    const line = this.aimParts.section;
    if (!geometry) {
      line.visible = false;
      return;
    }
    const { positions, count } = sectionSegments(geometry, axis, at, this.sectionBuffer);
    if (positions !== this.sectionBuffer) {
      // a bigger array than before: a geometry of its own, as the old one's buffer on the GPU is the old size
      line.geometry.dispose();
      line.geometry = new LineSegmentsGeometry().setPositions(positions);
      this.sectionBuffer = positions;
    } else {
      const data = line.geometry.attributes.instanceStart.data;
      data.clearUpdateRanges();
      data.addUpdateRange(0, count * 6);
      data.needsUpdate = true;
    }
    line.geometry.instanceCount = count;
  }

  /**
   * The ticks where a cut across `axis` snaps: a rail along the axis at a
   * corner of the plane, as long as the model, with a tick out of it at each
   * target – longer for a spot – and the one snapped to in orange. The corner
   * is on the handles' side towards −u: in the usual view the left one, away
   * from the readout, which sits right of the pointer.
   */
  #layoutTicks(axis, snapped) {
    const { box, centre, diag, extent } = this.#planeLayout();
    const list = this.aimTargets.list;
    const key = JSON.stringify([axis, list.map((t) => [t.at, t.kind]), snapped?.at ?? null, snapped?.kind ?? null, boxArrays(box)]);
    if (key === this.ticksKey) return;
    this.ticksKey = key;
    const [u, v] = CUT_UV[axis];
    const corner = [...centre];
    corner[u] -= extent[u] / 2;
    corner[v] += (axis === 2 ? -1 : 1) * (extent[v] / 2); // the side the handles are on
    const tick = clamp(0.03 * diag, 2, 25);
    const positions = [];
    const colors = [];
    const segment = (t0, t1, out, hex) => {
      const a = [...corner];
      const b = [...corner];
      a[axis] = t0;
      b[axis] = t1;
      b[u] += out;
      positions.push(...a, ...b);
      const c = new Color(hex);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    segment(box.min.getComponent(axis), box.max.getComponent(axis), 0, TICK_COLORS.seam);
    const lengths = { seam: 1, lip: 1.5, spot: 2 };
    // a spot drawn over a seam or a lip at the same place, and the one snapped to over everything
    const isSnapped = (t) => !!snapped && t.at === snapped.at && t.kind === snapped.kind;
    const rank = (t) => (isSnapped(t) ? 3 : { seam: 0, lip: 1, spot: 2 }[t.kind] ?? 0);
    const ordered = [...list].sort((p, q) => rank(p) - rank(q));
    for (const t of ordered) segment(t.at, t.at, -tick * (lengths[t.kind] ?? 1), isSnapped(t) ? TICK_COLORS.snapped : TICK_COLORS[t.kind] ?? TICK_COLORS.seam);
    const line = this.aimParts.ticks;
    line.geometry.dispose();
    line.geometry = new LineSegmentsGeometry().setPositions(positions).setColors(colors);
  }

  /* -------------------------------------------- live piece preview */

  /**
   * Colour the model by the piece each part of it will go to, as the cuts
   * stand now: one clipped copy of the model per non-empty cell, in that
   * cell's piece colour, so the preview follows a drag on every frame with
   * no worker call. Shown in the model view only, and only up to 12 cells
   * (beyond that the model is drawn plain). Null switches it off.
   * @param {object[]|null} cuts the same cuts as setCuts
   * @param {{ tooBig?: ((cell: { cell: number[], size: number[], flat: number|null }) => boolean)|null }} [options]
   *   `tooBig` is asked about each cell of `cellSizes` (the cut bounds, tabs counted) on every change, drags included; true tints that cell red
   */
  setCellPreview(cuts, { tooBig = null } = {}) {
    const list = readCuts(cuts);
    this.cellSpec = list.length ? { cuts: list, tooBig } : null;
    const live = this.cellSpec?.cuts.find((c) => c.id === this.cutDrag?.id);
    if (live) live.at = this.cutDrag.at;
    this.#updateCells();
    this.#applyVisibility();
  }

  /**
   * Bring the preview in line with the cuts. A full rebuild scans the model
   * for the cells it reaches, which only happens when the cuts or the model
   * changed; during a drag (`live`) only the clip planes move, unless the
   * cut passed another one or left the model.
   */
  #updateCells({ live = false } = {}) {
    const geometry = this.baseMesh?.geometry;
    const spec = this.cellSpec;
    if (!geometry || !spec) {
      this.#clearCells();
      return;
    }
    const box = this.#cutBounds();
    const byAxis = axisCuts(spec.cuts, boxArrays(box));
    if (!byAxis.some((l) => l.length)) {
      this.#clearCells();
      return;
    }
    // which cut bounds which cell depends only on their order along each axis
    const order = [0, 1, 2]
      .map((a) =>
        spec.cuts
          .filter((c) => c.axis === a && byAxis[a].includes(c.at))
          .sort((p, q) => p.at - q.at)
          .map((c) => c.id)
          .join(','),
      )
      .join('|');
    const sameOrder = this.cellOrder === `${geometry.uuid}|${order}`;
    const key = `${geometry.uuid}|${order}|${JSON.stringify(byAxis)}|${JSON.stringify(boxArrays(box))}`;
    if ((live && sameOrder) || this.cellKey === key) {
      this.#placeCells(byAxis);
      this.#styleCells();
      return;
    }
    this.#clearCells();
    this.cellKey = key;
    this.cellOrder = `${geometry.uuid}|${order}`;
    const grid = byAxis.map((l) => l.length + 1);
    if (grid[0] * grid[1] * grid[2] > CELL_SCAN_MAX) return;
    const filled = markedCells(this.#modelSlots(byAxis, grid), grid);
    if (filled.length > CELL_PREVIEW_MAX) return;
    // the model's unrepaired triangles (its material group 1) stay amber in every cell: text can only be raised there
    const loose = geometry.groups.some((g) => g.materialIndex === 1);
    for (const cell of filled) {
      const bounds = [];
      for (let a = 0; a < 3; a++) {
        // three.js keeps the side where n·x + constant ≥ 0: +axis above the lower cut, −axis below the upper one
        if (cell[a] > 0) bounds.push({ plane: new Plane(AXIS_VECTORS[a].clone(), 0), axis: a, index: cell[a] - 1, upper: false });
        if (cell[a] < byAxis[a].length) bounds.push({ plane: new Plane(AXIS_VECTORS[a].clone().negate(), 0), axis: a, index: cell[a], upper: true });
      }
      const clippingPlanes = bounds.map((b) => b.plane);
      const material = new MeshStandardMaterial({
        color: PIECE_COLORS[pieceColorIndex(cell)],
        roughness: 0.55,
        metalness: 0.05,
        side: DoubleSide, // the open cut shows the inside, in the piece's colour
        clippingPlanes,
      });
      const mesh = new Mesh(
        geometry,
        loose ? [material, new MeshStandardMaterial({ color: COLORS.passthrough, roughness: 0.6, metalness: 0.05, side: DoubleSide, clippingPlanes })] : material,
      );
      mesh.raycast = () => {}; // clicks go to the (hidden) model itself
      this.cellGroup.add(mesh);
      this.cellMeshes.set(cell.join(','), { mesh, cell, bounds });
    }
    this.#placeCells(byAxis);
    this.#styleCells();
  }

  /**
   * The slots of the grid the model fills: those its surface reaches (see
   * `markCells`) and those wholly inside it, such as the middle box of a
   * solid cube cut in three every way. Scanned once for each model and set
   * of cut positions.
   */
  #modelSlots(byAxis, grid) {
    const geometry = this.baseMesh.geometry;
    const key = `${geometry.uuid}|${JSON.stringify(byAxis)}`;
    if (this.modelSlotsFor?.key !== key) {
      const seen = new Uint8Array(grid[0] * grid[1] * grid[2]);
      markCells(seen, geometry, byAxis, grid);
      markEnclosed(seen, geometry, byAxis, grid);
      this.modelSlotsFor = { key, seen };
    }
    return this.modelSlotsFor.seen;
  }

  /**
   * The boxes between the cuts that hold some of the model or of its raised
   * text, as `'i,j,k'` keys of the cells of `cellSizes(bounds, cuts)`, so the
   * pieces can be counted before they are worked out; null when there is
   * nothing to tell by or too many boxes to look through.
   * @param {object[]} cuts the document's cuts
   * @param {{ min: number[], max: number[] }} bounds the box the cuts are placed in
   */
  filledCells(cuts, bounds) {
    const byAxis = axisCuts(readCuts(cuts), bounds);
    const grid = byAxis.map((l) => l.length + 1);
    if (grid[0] * grid[1] * grid[2] > CELL_SCAN_MAX) return null;
    // text that is not on the model is left out of the download, so it makes no piece
    const raised = [...this.overlays.values()].filter((o) => o.mode === 'emboss' && !o.detached);
    if (!this.baseMesh && !raised.length) return null;
    const key = JSON.stringify([this.baseMesh?.geometry.uuid, byAxis, raised.map((o) => [o.mesh.geometry.uuid, o.mesh.matrix.elements])]);
    if (this.filledFor?.key !== key) {
      const seen = this.baseMesh ? this.#modelSlots(byAxis, grid).slice() : new Uint8Array(grid[0] * grid[1] * grid[2]);
      for (const o of raised) markCells(seen, o.mesh.geometry, byAxis, grid, o.mesh.matrix);
      this.filledFor = { key, cells: new Set(markedCells(seen, grid).map((c) => c.join(','))) };
    }
    return this.filledFor.cells;
  }

  #placeCells(byAxis) {
    for (const e of this.cellMeshes.values()) {
      for (const b of e.bounds) {
        const at = byAxis[b.axis][b.index];
        b.plane.constant = b.upper ? at : -at;
      }
    }
  }

  #styleCells() {
    if (!this.cellMeshes.size) return;
    const tooBig = this.cellSpec?.tooBig;
    const boxes = new Map();
    if (tooBig) for (const c of cellSizes(boxArrays(this.#cutBounds()), this.cellSpec.cuts).cells) boxes.set(c.cell.join(','), c);
    for (const [key, e] of this.cellMeshes) {
      const box = boxes.get(key);
      const materials = [e.mesh.material].flat();
      materials[0].emissive.setHex(box && tooBig(box) ? TOO_BIG_COLOR : 0); // the piece's colour only, as in the pieces view
      for (const m of materials) {
        m.transparent = this.baseDimmed;
        m.opacity = this.baseDimmed ? 0.75 : 1;
      }
    }
  }

  #clearCells() {
    for (const e of this.cellMeshes.values()) {
      this.cellGroup.remove(e.mesh);
      for (const m of [e.mesh.material].flat()) m.dispose(); // the geometry is the model's own, freed with it
    }
    this.cellMeshes.clear();
    this.cellKey = null;
    this.cellOrder = null;
  }

  /* ------------------------------------------------------------ pieces */

  /**
   * Show computed pieces: one mesh per range of the display (a piece's
   * shell, a pin or a pegged part), coloured by cell like the preview and
   * pulled apart by Spread. Replaces any final result; showResult(true)
   * then shows them. A display without ranges, or null, clears them.
   * A twist-lock's faces (`markRanges`) are painted on its pieces, and a
   * part taken out moves along its own way out (`ways`) as Spread pulls the
   * pieces apart, from the piece it comes out of.
   * @param {{ positions: Float32Array, normals?: Float32Array, index: Uint32Array, passthroughRanges?: number[][],
   *           ranges: number[][], markRanges?: number[][], marks?: object[], parts?: object[] }|null} display
   *   `ranges[r] = [triStart, triCount, vertStart, vertCount]`, each self-contained; `parts[r]` is
   *   `{ kind: 'piece', index }`, `{ kind: 'pin', cell }` (a half-cell, between its two pieces) or `{ kind: 'part', id, cell }`;
   *   `markRanges[k] = [triStart, triCount, m]`, the triangles of lock `marks[m]` (`{ cutId, kind: 'lock'|'carry'|'lug'|'seat' }`,
   *   'seat' a base's tea-light seat)
   * @param {{ index: number, cell: number[], fits?: boolean, down?: string, yaw?: number }[]} [pieces] the result's
   *   pieces; `fits: false` tints a piece red; `down` and `yaw` how it lies as printed
   * @param {number[]|null} [grid] the number of cuts on each axis (from the pieces' cells without it)
   * @param {{ cutId: string, piece: number, home: number, point: number[], way: object, kind?: string, r?: number }[]} [ways]
   *   each part's piece, the piece it comes out of, a point on its axis (its circle's centre), its way out (a part
   *   seam's `part.way`), what it is ('lid', 'plug') and its circle's radius
   */
  setPieces(display, pieces = [], grid = null, ways = []) {
    // a part looked at is looked at again once its pieces are worked out anew – a seat switched off or a size changed
    // meanwhile: set down afresh, and the camera on it, not on where it was – unless the camera has been moved since,
    // which is left where it is. Pieces shown again after the model was, start afresh
    const shown = this.lookAside != null && this.viewMode === 'pieces';
    const looked = shown ? { cutId: this.lookingAt, seat: this.lookSeat, still: this.#pose() === this.lookPose } : null;
    this.#disposeMesh(this.resultMesh);
    this.resultMesh = null;
    this.#clearPieces();
    if (display?.index?.length && display.ranges?.length) this.#buildPieces(display, pieces ?? [], grid, ways ?? []);
    if (looked?.cutId != null && !this.asPrinted) this.#lookAgain(looked);
    this.showResult(this.resultShown);
  }

  /** Where the camera is and looks, as a key: the same while nobody moves it. */
  #pose() {
    return [...this.camera.position.toArray(), ...this.controls.target.toArray()].map((v) => v.toFixed(6)).join(' ');
  }

  /** Cut `cutId`'s part set down again to be looked at (`seat`: its top), the camera on it while it was `still`. */
  #lookAgain({ cutId, seat, still }) {
    if (still) {
      this.lookAtLock(cutId, { seat });
      return;
    }
    const entry = [...this.pieceWays.entries()].find(([, x]) => x.cutId === cutId);
    if (!entry) return;
    this.spread = 1;
    this.lookAside = entry[0];
    this.lookSeat = seat && entry[1].kind === 'plug';
    this.#layoutPieces();
    this.#layoutCuts();
    this.#showLockWords(cutId, { seat: this.lookSeat });
    this.#stylePieces();
  }

  #buildPieces(display, pieces, grid, ways) {
    const info = new Map(pieces.map((p) => [p.index, p]));
    const passthrough = display.passthroughRanges ?? [];
    const marks = display.marks ?? [];
    const shells = new Map(); // piece index -> shells drawn so far
    const boxes = new Map(); // piece index -> { box, cell, fits } for its number
    const all = new Box3();
    display.ranges.forEach(([t0, tc, v0, vc], r) => {
      if (!tc || !vc) return;
      const part = display.parts?.[r] ?? { kind: 'piece', index: r + 1 };
      const piece = part.kind === 'piece' ? info.get(part.index) : null;
      const cell = part.cell ?? piece?.cell ?? [0, 0, 0];
      const fits = piece?.fits !== false;
      // views of the shared arrays, but an index of its own rebased to the range: whole shared attributes would make
      // computeBoundingBox measure every piece, and dispose() free every piece's buffers at once
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(display.positions.subarray(v0 * 3, (v0 + vc) * 3), 3));
      if (display.normals) geometry.setAttribute('normal', new BufferAttribute(display.normals.subarray(v0 * 3, (v0 + vc) * 3), 3));
      const from = display.index.subarray(t0 * 3, (t0 + tc) * 3);
      const index = new Uint32Array(from.length);
      for (let i = 0; i < from.length; i++) index[i] = from[i] - v0;
      geometry.setIndex(new BufferAttribute(index, 1));
      if (!display.normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();

      const shell = part.kind === 'piece' ? (shells.get(part.index) ?? 0) : 0;
      if (part.kind === 'piece') shells.set(part.index, shell + 1);
      const color = new Color(part.kind === 'pin' ? PIN_COLOR : part.kind === 'part' ? COLORS.model : PIECE_COLORS[pieceColorIndex(cell)]);
      if (shell) color.offsetHSL(0, 0, shell % 2 ? 0.1 : -0.1); // the parts of one piece share its colour but stay told apart
      const material = new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: FrontSide });
      // each triangle's class: the solid, unrepaired (drawn as in the model view, from both sides), or a lock's
      const loose = rangesWithin(passthrough, t0, tc);
      const marked = marksWithin(display.markRanges ?? [], t0, tc);
      const materials = [material, loose.length ? new MeshStandardMaterial({ color: COLORS.passthrough, roughness: 0.6, metalness: 0.05, side: DoubleSide }) : material];
      const slots = []; // the locks' materials on this piece: { mark, cutId, kind, material }
      let cls = null;
      if (loose.length || marked.length) {
        cls = new Uint8Array(tc);
        for (const [start, count] of loose) cls.fill(LOOSE, start, start + count);
        for (const [start, count, m] of marked) {
          let slot = slots.find((x) => x.mark === m);
          if (!slot) {
            const kind = marks[m]?.kind ?? 'lock';
            slot = { mark: m, cutId: marks[m]?.cutId ?? null, kind, material: new MeshStandardMaterial({ color: LOCK_COLORS[kind] ?? LOCK_COLORS.lock, roughness: 0.45, metalness: 0.05, side: FrontSide }) };
            slots.push(slot);
            materials.push(slot.material);
          }
          cls.fill(materials.indexOf(slot.material), start, start + count);
        }
        this.#unmarkJoint(cls, index, geometry.attributes.position, slots, marks, materials);
      }
      // the faces a lock adds that overhang, as printed: red, in a material of their own after the lock's
      // (both sides: an overhang faces down, away from a view from above, and shows through the piece faded round it)
      const over = slots.length ? new MeshStandardMaterial({ color: LOCK_COLORS.over, roughness: 0.5, metalness: 0.05, side: DoubleSide }) : null;
      if (over) materials.push(over);
      const mesh = new Mesh(geometry, cls ? materials : material);
      mesh.userData = { kind: part.kind, index: part.kind === 'piece' ? part.index : null };
      this.pieceGroup.add(mesh);
      const entry = { mesh, kind: part.kind, index: part.kind === 'piece' ? part.index : null, cell, fits, cls, base: cls ? index.slice() : null, slots, over, printed: null, lines: null };
      this.#groupPiece(entry);
      this.pieceEntries.push(entry);
      all.union(geometry.boundingBox);
      if (part.kind === 'piece') {
        if (!boxes.has(part.index)) boxes.set(part.index, { box: new Box3(), cell, fits });
        boxes.get(part.index).box.union(geometry.boundingBox);
      }
    });
    this.pieceGrid = grid ?? [0, 1, 2].map((a) => Math.max(0, ...this.pieceEntries.filter((e) => e.kind === 'piece').map((e) => e.cell[a])));
    this.pieceBounds = all.isEmpty() ? null : all;
    this.pieceInfo = info;
    for (const [index, { box, cell, fits }] of boxes) {
      const sprite = labelSprite(String(index), {
        fill: fits ? 'rgba(27, 34, 48, 0.82)' : cssColor(COLORS.tooBig),
        ring: cssColor(PIECE_COLORS[pieceColorIndex(cell)]),
        px: 24,
      });
      sprite.scale.setScalar(this.#spriteScale(sprite.userData.px));
      this.pieceLabelGroup.add(sprite);
      // the piece a part comes out of has its number away from the lock, which sits where the part comes out: on a
      // lantern its neck, round the middle of the top
      const centre = box.getCenter(new Vector3());
      const way = ways.find((w) => w.home === index && w.way?.out);
      if (way) {
        const out = new Vector3(...way.way.out).normalize();
        const along = Math.abs(out.x) * (box.max.x - box.min.x) + Math.abs(out.y) * (box.max.y - box.min.y) + Math.abs(out.z) * (box.max.z - box.min.z);
        centre.addScaledVector(out, -0.25 * along);
      }
      this.pieceLabels.push({ sprite, index, centre, cell });
    }
    // each part's piece moves along its way out from where the piece it comes out of is drawn: turned about its axis
    // through its circle's centre, then lifted and slid, or dropped its own length out of the model's end
    for (const w of ways) {
      const box = boxes.get(w.piece)?.box;
      const home = boxes.get(w.home);
      if (!box || !home || !w.way?.out) continue;
      const out = new Vector3(...w.way.out).normalize();
      const size = box.getSize(new Vector3());
      const drop = Math.abs(size.x * out.x) + Math.abs(size.y * out.y) + Math.abs(size.z * out.z);
      // its half-width across its axis, for setting it down beside the lock
      const half = Math.max(Math.abs(out.x) < 0.5 ? size.x : size.y, Math.abs(out.z) < 0.5 ? size.z : size.y) / 2;
      this.pieceWays.set(w.piece, { cutId: w.cutId, way: w.way, point: new Vector3(...w.point), out, homeCell: home.cell, homeBox: home.box, drop, half, kind: w.kind ?? 'lid', r: w.r ?? null });
    }
    this.lockLabels = display.lockLabels ?? [];
    if (this.asPrinted) this.#classifyPrinted();
    this.#layoutPieces();
    this.#stylePieces();
  }

  /** What carries a lock, in a piece's classes, that lies in its joint's plane is the piece's own face (`unmarkJoint`). */
  #unmarkJoint(cls, index, pos, slots, marks, materials) {
    for (const slot of slots) {
      const m = marks[slot.mark];
      if (slot.kind === 'carry' && m?.at && m?.axis) unmarkJoint(cls, materials.indexOf(slot.material), index, pos.array, m.at, m.axis);
    }
  }

  /**
   * A piece's triangles grouped by class, each group drawn in its material: the index reordered so each class is one
   * run. As printed, the lock's faces that overhang are a class of their own (`printed`).
   */
  #groupPiece(e) {
    if (!e.cls) return;
    const geometry = e.mesh.geometry;
    const cls = e.printed ?? e.cls;
    const n = cls.length;
    const kinds = [e.mesh.material].flat().length;
    const counts = new Uint32Array(kinds);
    for (let t = 0; t < n; t++) counts[cls[t]]++;
    const starts = new Uint32Array(kinds);
    for (let k = 1; k < kinds; k++) starts[k] = starts[k - 1] + counts[k - 1];
    const at = starts.slice();
    const index = geometry.index.array;
    for (let t = 0; t < n; t++) {
      const to = at[cls[t]]++ * 3;
      index[to] = e.base[t * 3];
      index[to + 1] = e.base[t * 3 + 1];
      index[to + 2] = e.base[t * 3 + 2];
    }
    geometry.index.needsUpdate = true;
    geometry.clearGroups();
    for (let k = 0; k < kinds; k++) if (counts[k]) geometry.addGroup(starts[k] * 3, counts[k] * 3, k);
  }

  #clearPieces() {
    this.stopWay();
    for (const e of this.pieceEntries) {
      this.pieceGroup.remove(e.mesh);
      e.mesh.geometry.dispose();
      for (const m of new Set([e.mesh.material].flat())) m.dispose();
      this.#dropLines(e);
    }
    for (const l of this.pieceLabels) {
      this.pieceLabelGroup.remove(l.sprite);
      disposeSprite(l.sprite);
    }
    this.pieceEntries = [];
    this.pieceLabels = [];
    this.pieceBounds = null;
    this.pieceWays.clear();
    this.pieceInfo = null;
    this.lookAside = null;
    this.lockLabels = [];
    this.#hideLockWords();
    this.piecesStale = false; // the stale ones are gone
  }

  /** How far apart neighbouring pieces are drawn, in mm: Spread × 8 % of the diagonal, kept within 6–50 mm. */
  #explodeGap(spread = this.spread) {
    const box = this.pieceBounds ?? this.#cutBounds();
    return spread * clamp(0.08 * box.getSize(new Vector3()).length(), 6, 50);
  }

  /**
   * Where a piece is drawn: its turn and its move. A part's piece follows its way out (`wayAt`) from where the piece it
   * comes out of is; every other piece moves out from the middle by its cell (`explodeOffset`).
   */
  #placement(index, cell) {
    const gap = this.#explodeGap();
    const w = index != null ? this.pieceWays.get(index) : null;
    if (!w) return { turn: null, move: new Vector3(...explodeOffset(cell, this.pieceGrid, gap)) };
    const home = new Vector3(...explodeOffset(w.homeCell, this.pieceGrid, gap));
    if (this.lookAside === index) {
      // its lock looked at: set down beside it along its way out, its side of the lock towards the camera – a lid turned
      // over, its joint at the joint's height; a base as it is, beside the model's end
      const dir = this.#wayDir(w);
      const q = w.kind === 'plug' ? new Quaternion() : new Quaternion().setFromAxisAngle(new Vector3().crossVectors(w.out, dir).normalize(), Math.PI);
      const move = w.point.clone().sub(w.point.clone().applyQuaternion(q)).add(home).addScaledVector(dir, this.#parkAt(w));
      return { turn: q, move };
    }
    const { turn, offset } = wayAt(w.way, this.spread, w.drop + this.#explodeGap(1));
    const q = new Quaternion().setFromAxisAngle(w.out, (turn * Math.PI) / 180);
    // turned about its axis through its circle's centre: the centre stays where it is
    const move = w.point.clone().sub(w.point.clone().applyQuaternion(q)).add(new Vector3(...offset)).add(home);
    return { turn: q, move };
  }

  /** The way a part slides out, in the world: its own, or for one that comes straight off, away from the camera. */
  #wayDir(w) {
    const dir = w.way.dir ? new Vector3(...w.way.dir) : this.controls.target.clone().sub(this.camera.position);
    dir.addScaledVector(w.out, -dir.dot(w.out));
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0).addScaledVector(w.out, -w.out.x);
    return dir.normalize();
  }

  /** How far from its axis a part is set down beside its lock while it is looked at: clear of its body, with a gap. */
  #parkAt(w) {
    const dir = this.#wayDir(w);
    let reach = w.r ?? 0;
    const { min, max } = w.homeBox;
    for (let k = 0; k < 8; k++) {
      const p = new Vector3(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z);
      reach = Math.max(reach, p.sub(w.point).dot(dir));
    }
    return reach + w.half + this.#explodeGap(1);
  }

  #layoutPieces() {
    if (this.asPrinted) return this.#layoutPrinted();
    for (const e of this.pieceEntries) {
      const { turn, move } = this.#placement(e.index, e.cell);
      e.mesh.quaternion.copy(turn ?? new Quaternion());
      e.mesh.position.copy(move);
    }
    for (const l of this.pieceLabels) {
      const { turn, move } = this.#placement(l.index, l.cell);
      l.sprite.position.copy(l.centre);
      if (turn) l.sprite.position.applyQuaternion(turn);
      l.sprite.position.add(move);
    }
  }

  /**
   * The pieces as they print, in a row on the grid: each turned the way it lies on the bed (its `down` and `yaw`, as
   * the download saves it), its bottom on the grid, a gap between them.
   */
  #layoutPrinted() {
    const shown = this.pieceEntries.filter((e) => e.kind === 'piece');
    const gap = this.#explodeGap(1);
    const turned = new Map(); // piece index -> { R: Matrix4, size }
    for (const e of shown) {
      if (turned.has(e.index)) continue;
      const box = new Box3();
      for (const x of shown) if (x.index === e.index) box.union(x.mesh.geometry.boundingBox);
      const p = this.pieceInfo?.get(e.index);
      const { printMatrix } = printTransform({ min: box.min.toArray(), max: box.max.toArray() }, p?.down ?? '-z', p?.yaw ?? 0);
      const M = new Matrix4().fromArray(printMatrix);
      const lying = box.clone().applyMatrix4(M);
      turned.set(e.index, { M, size: lying.getSize(new Vector3()) });
    }
    const order = [...turned.keys()];
    const xs = printedRow(order.map((i) => turned.get(i).size.x), gap);
    const c = this.bounds.getCenter(new Vector3());
    const at = new Map(order.map((i, k) => [i, new Matrix4().makeTranslation(c.x + xs[k], c.y, this.bounds.min.z).multiply(turned.get(i).M)]));
    for (const e of this.pieceEntries) {
      const M = at.get(e.index);
      e.mesh.visible = !!M; // pins and printed parts have files of their own
      if (!M) continue;
      M.decompose(e.mesh.position, e.mesh.quaternion, new Vector3());
    }
    for (const l of this.pieceLabels) {
      const M = at.get(l.index);
      if (M) l.sprite.position.copy(l.centre).applyMatrix4(M);
    }
  }

  /**
   * As printed, which of each piece's lock faces overhang more than 45° (red) and which are bridged ceilings
   * (outlined), from their normals as the piece lies on the bed.
   */
  #classifyPrinted() {
    const R = new Matrix4();
    const n = new Vector3();
    const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
    for (const e of this.pieceEntries) {
      this.#dropLines(e);
      e.printed = null;
      if (!e.slots.length || e.kind !== 'piece') continue;
      const p = this.pieceInfo?.get(e.index);
      const box = e.mesh.geometry.boundingBox;
      const { printMatrix } = printTransform({ min: box.min.toArray(), max: box.max.toArray() }, p?.down ?? '-z', p?.yaw ?? 0);
      R.fromArray(printMatrix);
      const pos = e.mesh.geometry.attributes.position;
      const overAt = [e.mesh.material].flat().indexOf(e.over);
      const lockAt = new Set(e.slots.map((s) => [e.mesh.material].flat().indexOf(s.material)));
      const printed = e.cls.slice();
      const edges = new Map(); // a bridged ceiling's edges, by their ends: those used once are its outline
      const key = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
      for (let t = 0; t < printed.length; t++) {
        if (!lockAt.has(printed[t])) continue;
        a.fromBufferAttribute(pos, e.base[t * 3]).applyMatrix4(R);
        b.fromBufferAttribute(pos, e.base[t * 3 + 1]).applyMatrix4(R);
        c.fromBufferAttribute(pos, e.base[t * 3 + 2]).applyMatrix4(R);
        n.subVectors(b, a).cross(c.clone().sub(a));
        if (!(n.lengthSq() > 0)) continue;
        n.normalize();
        const kind = printedFace(n.z, Math.max(a.z, b.z, c.z) < 0.05);
        if (kind === 'over') printed[t] = overAt;
        if (kind === 'bridge') {
          for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const [k1, k2] = [key(p), key(q)];
            const k = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
            const seen = edges.get(k);
            if (seen) seen.n++;
            else edges.set(k, { n: 1, ends: [p.clone(), q.clone()] });
          }
        }
      }
      e.printed = printed;
      const outline = [...edges.values()].filter((x) => x.n === 1);
      if (outline.length) {
        // drawn in the piece's own frame, so it goes where the piece goes
        const back = R.clone().invert();
        const points = new Float32Array(outline.length * 6);
        outline.forEach((x, i) => {
          points.set(x.ends[0].clone().applyMatrix4(back).toArray(), i * 6);
          points.set(x.ends[1].clone().applyMatrix4(back).toArray(), i * 6 + 3);
        });
        const line = new BufferGeometry();
        line.setAttribute('position', new BufferAttribute(points, 3));
        // seen through the piece faded round them, as the lock is
        e.lines = new LineSegments(line, new LineBasicMaterial({ color: LOCK_COLORS.bridge, depthTest: false, transparent: true }));
        e.lines.renderOrder = 12;
        e.lines.raycast = () => {};
        e.mesh.add(e.lines);
      }
      this.#groupPiece(e);
    }
  }

  #dropLines(e) {
    if (!e.lines) return;
    e.mesh.remove(e.lines);
    e.lines.geometry.dispose();
    e.lines.material.dispose();
    e.lines = null;
  }

  #stylePieces() {
    const stale = this.piecesStale ? 0.6 : 1;
    const focus = this.pieceHighlight;
    // a part's row pointed at, no piece picked out: the pieces its lock is on fade round it, as a piece pointed at fades
    // the others, so the whole lock shows – the socket inside the part too – not only a brighter orange
    const rowLit = focus == null && !this.asPrinted && this.lockHighlight.size > 0;
    for (const e of this.pieceEntries) {
      const shown = focus == null || e.index === focus;
      const round = rowLit && e.slots.some((s) => this.lockHighlight.has(s.cutId));
      const opacity = stale * (shown ? (round ? 0.35 : 1) : 0.3);
      const materials = [e.mesh.material].flat();
      for (const m of new Set(materials)) {
        // a lock that glows shows through its piece faded round it; as printed every lock does, inside its piece faded
        // round it, so what it adds that overhangs shows, wherever it is
        const lock = e.slots.some((s) => s.material === m) || m === e.over;
        const lit = lock && (this.asPrinted || e.slots.some((s) => s.material === m && this.#lit(s.cutId)));
        const o = lit ? stale : this.asPrinted && e.slots.length ? 0.4 * opacity : opacity;
        if (m.transparent !== o < 1) m.needsUpdate = true;
        m.transparent = o < 1;
        m.opacity = o;
      }
      materials[0].emissive.setHex(!e.fits ? TOO_BIG_COLOR : focus != null && shown ? 0x262626 : 0);
      // a base's seat keeps its own violet, as the legend keys it: the lock's orange glow would turn it pink
      for (const s of e.slots) s.material.emissive.setHex(this.#lit(s.cutId) && s.kind !== 'seat' ? LOCK_COLORS.glow : 0);
    }
    for (const l of this.pieceLabels) {
      l.sprite.material.opacity = focus == null || l.index === focus ? stale : 0.35;
      // close on a lock, a piece's number would sit on the lock itself: the words on the lock say what is what instead
      l.sprite.visible = this.lookAside == null;
    }
    this.requestRender();
  }

  /** Spread the pieces apart: 0 (assembled) to 2; 1 is the default gap. A part's piece goes along its way out. */
  setSpread(f) {
    this.spread = clamp(Number(f) || 0, 0, 2);
    this.#leaveLook();
    this.#layoutPieces();
    this.#layoutCuts();
    this.requestRender();
  }

  /** Dim the pieces while newer ones are being computed for changed cuts or settings. */
  setPiecesStale(on) {
    this.piecesStale = !!on;
    this.#stylePieces();
  }

  /** Pick out one piece by its number (the others fade), or none for null. */
  setPieceHighlight(index) {
    this.pieceHighlight = index ?? null;
    this.#stylePieces();
  }

  /**
   * Make a cut's twist-lock glow on both its pieces (seen through a piece faded round it), or several cuts' (a list),
   * or none for null.
   */
  setLockHighlight(cutIds) {
    const lit = new Set([cutIds ?? []].flat());
    if (lit.size === this.lockHighlight.size && [...lit].every((id) => this.lockHighlight.has(id))) return;
    this.lockHighlight = lit;
    this.#stylePieces();
  }

  /** A part set down beside its lock to be looked at goes back on its way out, and its lock stops glowing. */
  #leaveLook() {
    if (this.lookAside == null) return;
    this.lookAside = null;
    this.lookSeat = false;
    this.#hideLockWords();
    this.#stylePieces();
  }

  /**
   * The words on a lock looked at, in the page over the view: "lug" on the lantern's neck, "slot" and "click tab" in
   * its part (or on a base, the other way round) – each on the one of its kind nearest the camera, following the
   * piece it is on; or, looking at a base's tea-light seat (`seat`), that word alone, on it.
   */
  #showLockWords(cutId, { seat = false } = {}) {
    this.#hideLockWords();
    const points = this.lockLabels.filter((x) => x.cutId === cutId && (x.name === SEAT_WORD) === seat);
    if (!points.length) return;
    const el = document.createElement('div');
    el.className = 'lock-words';
    el.setAttribute('aria-hidden', 'true');
    const names = [...new Set(points.map((x) => x.name))];
    const items = names.map((name) => {
      const word = document.createElement('span');
      word.className = 'lock-word';
      word.textContent = name;
      el.append(word);
      return { el: word, name, points: points.filter((x) => x.name === name).map((x) => ({ piece: x.piece, at: new Vector3(...x.at) })) };
    });
    this.container.append(el);
    this.lockWords = { el, items };
    this.requestRender();
  }

  #hideLockWords() {
    this.lockWords?.el.remove();
    this.lockWords = null;
  }

  /** Each word where its point is on screen this frame (the nearest of its kind to the camera), or hidden off it. */
  #placeLockWords() {
    const [w, h] = this.viewSize;
    const meshOf = new Map();
    for (const e of this.pieceEntries) if (e.kind === 'piece' && !meshOf.has(e.index)) meshOf.set(e.index, e.mesh);
    for (const item of this.lockWords.items) {
      let best = null;
      for (const p of item.points) {
        const mesh = meshOf.get(p.piece);
        if (!mesh?.visible) continue;
        const world = p.at.clone().applyMatrix4(mesh.matrixWorld);
        const d = world.distanceTo(this.camera.position);
        if (!best || d < best.d) best = { world, d };
      }
      const v = best?.world.project(this.camera);
      const shown = !!v && v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
      item.el.hidden = !shown;
      if (shown) item.el.style.transform = `translate(${Math.round(((v.x + 1) / 2) * w)}px, ${Math.round(((1 - v.y) / 2) * h)}px)`;
    }
  }

  /** Whether a cut's twist-lock glows: pointed at, or looked at. */
  #lit(cutId) {
    return this.lockHighlight.has(cutId) || (cutId != null && cutId === this.lookingAt);
  }

  /** Whether a lock's lugs are painted on the pieces shown, in their own colour. */
  get lugsShown() {
    return this.pieceEntries.some((e) => e.slots.some((x) => x.kind === 'lug'));
  }

  /** The cuts whose twist-lock is painted on the pieces shown, in the order they first appear. */
  get lockCuts() {
    return [...new Set(this.pieceEntries.flatMap((e) => e.slots.filter((s) => s.kind !== 'seat').map((s) => s.cutId)))].filter(Boolean);
  }

  /** The cuts whose base has a tea-light seat painted on the pieces shown: a seat is no lock, but is shown as one is. */
  get seatCuts() {
    return [...new Set(this.pieceEntries.flatMap((e) => e.slots.filter((s) => s.kind === 'seat').map((s) => s.cutId)))].filter(Boolean);
  }

  /** The cuts whose part moves along a way out of its own, and each one's way. */
  get partWays() {
    return [...this.pieceWays.values()].map((w) => ({ cutId: w.cutId, way: w.way }));
  }

  /**
   * ▶: the pieces come apart over 2.5 s, each part along its way out – turned free, lifted, slid out – and stay
   * apart; backwards (`back`), they go together again. Seen across the slide (`#frameWay`) – that of the part `cutId`
   * when it is a part's own ▶. Spread follows (`onSpread`). Resolves once it has played, or been stopped.
   */
  playWay({ back = false, cutId = null } = {}) {
    this.stopWay();
    if (this.asPrinted) this.setAsPrinted(false);
    this.#leaveLook();
    this.#frameWay(cutId);
    const [from, to] = back ? [1, 0] : [0, 1];
    return new Promise((resolve) => {
      const start = performance.now();
      const play = { frame: 0, resolve };
      const step = (now) => {
        const t = Math.min(1, (now - start) / WAY_PLAY_MS);
        this.setSpread(from + (to - from) * ease(t));
        this.onSpread?.(this.spread, t < 1);
        if (t < 1 && this.wayPlay === play) play.frame = requestAnimationFrame(step);
        else if (this.wayPlay === play) this.stopWay();
      };
      this.wayPlay = play;
      step(start);
    });
  }

  /** Stop ▶ where it is. */
  stopWay() {
    const play = this.wayPlay;
    if (!play) return;
    this.wayPlay = null;
    cancelAnimationFrame(play.frame);
    play.resolve();
  }

  get wayPlaying() {
    return !!this.wayPlay;
  }

  /** The cut whose lock is being looked at (its part set down beside it), or null. */
  get lookingAt() {
    return this.lookAside != null ? this.pieceWays.get(this.lookAside)?.cutId ?? null : null;
  }

  /** Whether what is looked at, set down beside the model, is a base's tea-light seat rather than its lock. */
  get lookingAtSeat() {
    return this.lookAside != null && this.lookSeat;
  }

  /**
   * Look at a part's lock: the camera close on it from 35° over its joint (under it, for a base), from the side away
   * from where the part goes out, and the lock glowing. The part is set down just beyond it, a lid turned over, so
   * both halves show: the neck and its lugs on the body and the socket, slots and click tabs in the lid; the slots in
   * the body's bore and the base's lugs, click tabs and coin slot. With `seat`, a base set down there is looked at
   * from 50° over its top instead, where a tea light stands – in its tea-light seat, where it has one. False when the
   * cut has no part shown.
   */
  lookAtLock(cutId, { seat = false } = {}) {
    const entry = [...this.pieceWays.entries()].find(([, x]) => x.cutId === cutId);
    if (!entry) return false;
    const [piece, w] = entry;
    this.stopWay();
    if (this.asPrinted) this.setAsPrinted(false);
    const lid = w.kind !== 'plug';
    this.spread = 1;
    this.lookAside = piece;
    this.lookSeat = seat && !lid;
    this.#layoutPieces();
    this.#layoutCuts();
    this.onSpread?.(1, false);
    const r = w.r ?? w.half;
    const dir = this.#wayDir(w);
    const home = new Vector3(...explodeOffset(w.homeCell, this.pieceGrid, this.#explodeGap()));
    if (this.lookSeat) {
      this.#lookAtSeat(w, home, dir);
      this.lookPose = this.#pose();
      this.#showLockWords(cutId, { seat: true });
      this.#stylePieces();
      return true;
    }
    // the lock's middle: a lid's neck stands out of the body's face into it, a base's slots run up into the body
    const lock = w.point.clone().add(home).addScaledVector(w.out, (lid ? 1 : -1) * Math.min(2, 0.08 * r));
    // with the part set down beyond it, the view takes in both
    const park = this.#parkAt(w);
    const [cos, sin] = [Math.cos((35 * Math.PI) / 180), Math.sin((35 * Math.PI) / 180)];
    const target = lock.clone().addScaledVector(dir, 0.5 * (park - r)).addScaledVector(w.out, -0.25 * w.drop);
    // seen from 35° over (or under) them, the row from the lock to the part's far side is foreshortened, and the part
    // stands back from the joint by its own length
    const radius = 0.5 * ((park + r + w.half) * sin + w.drop * cos) + 0.15 * r;
    const look = dir.clone().multiplyScalar(-cos).addScaledVector(w.out, sin).normalize();
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.camera.position.copy(target).addScaledVector(look, dist);
    this.camera.near = Math.max(dist / 500, 0.01);
    this.camera.far = dist * 400;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.#keepClear();
    this.lookPose = this.#pose();
    this.#showLockWords(cutId);
    this.#stylePieces();
    return true;
  }

  /**
   * The camera on a base set down beside the model's end, from 50° over its top, from the side away from where it
   * was set down: its tea-light seat in the middle of the view, the base whole round it.
   */
  #lookAtSeat(w, home, dir) {
    // the base stands as it does in the model, beside it: its top is its own length up from the model's end
    const top = w.point.clone().add(home).addScaledVector(dir, this.#parkAt(w)).addScaledVector(w.out, -w.drop);
    const [cos, sin] = [Math.cos((50 * Math.PI) / 180), Math.sin((50 * Math.PI) / 180)];
    const look = dir.clone().multiplyScalar(-cos).addScaledVector(w.out, -sin).normalize();
    const radius = 1.25 * w.half + 0.15 * w.drop;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.camera.position.copy(top).addScaledVector(look, dist);
    this.camera.near = Math.max(dist / 500, 0.01);
    this.camera.far = dist * 400;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(top);
    this.controls.update();
    this.#keepClear();
  }

  /**
   * As printed: each piece turned the way it lies on the bed and set on the grid in a row, the faces its lock adds
   * that overhang more than 45° red and its bridged ceilings outlined; or the pieces apart again.
   */
  setAsPrinted(on) {
    on = !!on;
    if (on === this.asPrinted) return;
    if (on) this.stopWay();
    this.asPrinted = on;
    this.lookAside = null;
    this.lookSeat = false;
    this.#hideLockWords();
    if (on) this.#classifyPrinted();
    else {
      for (const e of this.pieceEntries) {
        e.printed = null;
        e.mesh.visible = true;
        this.#dropLines(e);
        this.#groupPiece(e);
      }
    }
    this.#layoutPieces();
    this.#stylePieces();
    this.#applyVisibility();
  }

  get hasPieces() {
    return this.pieceEntries.length > 0;
  }

  /* ----------------------------------------------------------- picking */

  setHoverEnabled(enabled) {
    this.hoverEnabled = enabled;
    if (!enabled) {
      this.marker.visible = false;
      this.requestRender();
    }
  }

  /** The point of the model's surface nearest to `position`, with its normal, or null. */
  closestSurfacePoint(position) {
    const geometry = this.baseMesh?.geometry;
    if (!geometry?.boundsTree) return null;
    const found = geometry.boundsTree.closestPointToPoint(new Vector3(...position), {});
    if (!found) return null;
    const index = geometry.index;
    const pos = geometry.attributes.position;
    const tri = new Triangle();
    tri.a.fromBufferAttribute(pos, index.getX(found.faceIndex * 3));
    tri.b.fromBufferAttribute(pos, index.getX(found.faceIndex * 3 + 1));
    tri.c.fromBufferAttribute(pos, index.getX(found.faceIndex * 3 + 2));
    const normal = tri.getNormal(new Vector3());
    if (!normal.lengthSq()) return null;
    return { point: found.point.toArray(), normal: this.#surfaceNormal(this.baseMesh, found.point, normal, found.faceIndex) };
  }

  /** First model surface hit by a ray from `origin` along `direction`, or null. */
  raycastFrom(origin, direction) {
    if (!this.baseMesh) return null;
    this.raycaster.set(new Vector3(...origin), new Vector3(...direction).normalize());
    return this.#hit(this.raycaster.intersectObject(this.baseMesh, false));
  }

  /** Fit the camera to what is shown: the model (or the empty build plate), the final result, or the spread-out pieces. */
  frame() {
    if (this.lookAside != null) {
      this.#leaveLook();
      this.#layoutPieces();
    }
    // the pieces, with the lock's tools under them and the legend over them, kept clear of both
    this.#fitBox(this.#shownBounds(), new Vector3(0.55, -0.95, 0.75).normalize(), { clear: this.viewMode === 'pieces' });
  }

  /** The camera on `box`, from the side `from` points to (a unit vector from its middle), taking it all in. */
  #fitBox(box, from, { clear = false } = {}) {
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 5);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.camera.position.copy(center).add(from.clone().multiplyScalar(dist * 1.05));
    this.camera.near = radius / 200;
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    if (clear) this.#keepClear();
    this.requestRender();
  }

  /**
   * The camera, framed on the whole view, drawn back and moved so what it frames sits in the part of the view the
   * page's own controls leave clear (`insets`): the legend and the view's tools over its top, the lock's tools under
   * its foot – on a phone they take a good share of it.
   */
  #keepClear() {
    const { top = 0, bottom = 0 } = this.insets?.() ?? {};
    const h = this.viewSize[1];
    const free = h - top - bottom;
    if (!(top + bottom > 0) || free < 0.3 * h) return; // little enough left that the whole view does better
    const offset = this.camera.position.clone().sub(this.controls.target);
    // as much farther as the clear band is shorter than the view
    offset.multiplyScalar(h / free);
    const forward = offset.clone().negate().normalize();
    const right = new Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    // the clear band's middle is (top − bottom) / 2 pixels under the view's: moved up that far, what is framed is there
    const perPx = (2 * offset.length() * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    if (up.lengthSq() > 0.5) this.controls.target.addScaledVector(up, ((top - bottom) / 2) * perPx);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.far = Math.max(this.camera.far, offset.length() * 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * ▶ seen across the way out: where a part slides out along the line of sight – into the view, past the handle it
   * goes under, where it seems to run through a leg – the camera turns about the upright through what it looks at
   * until it looks square to the slide, from a little above, drawn back to take in the whole way, so the part is seen
   * passing under the handle. Where the slide already runs across the view, the view is left as the user has it.
   */
  #frameWay(cutId = null) {
    const ways = [...this.pieceWays.entries()];
    const own = cutId != null ? ways.find(([, x]) => x.cutId === cutId) : null;
    if (own?.[1].kind === 'plug') return this.#frameBase(...own);
    const w = (own?.[1].way?.dir ? own[1] : null) ?? ways.map(([, x]) => x).find((x) => x.way?.dir && x.kind !== 'plug');
    if (!w) return;
    const dir = this.#wayDir(w);
    const up = w.out.clone();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const flat = offset.clone().addScaledVector(up, -offset.dot(up));
    if (flat.lengthSq() > 1e-9 && Math.abs(flat.clone().normalize().dot(dir)) < Math.SQRT1_2) return;
    const side = new Vector3().crossVectors(up, dir).normalize();
    if (flat.dot(side) < 0) side.negate();
    // a little round from square towards where the camera was, so the handle shows as an arch, not edge on
    const toward = dir.clone().multiplyScalar(flat.dot(dir) < 0 ? -1 : 1);
    const round = (25 * Math.PI) / 180;
    side.multiplyScalar(Math.cos(round)).addScaledVector(toward, Math.sin(round)).normalize();
    // the whole way: the pieces where it starts and where it ends
    const box = new Box3();
    const was = this.spread;
    for (const f of [0, 1]) {
      this.spread = f;
      this.#layoutPieces();
      for (const e of this.pieceEntries) if (e.mesh.visible) box.expandByObject(e.mesh);
    }
    this.spread = was;
    this.#layoutPieces();
    const above = (20 * Math.PI) / 180;
    this.#fitBox(box, side.multiplyScalar(Math.cos(above)).addScaledVector(up, Math.sin(above)).normalize(), { clear: true });
  }

  /**
   * A base's own ▶ seen from a little over the model's end, the way the camera looked round the upright: the base
   * where it starts and where it ends, the model's foot round it, so it shows dropping out – and, the pieces round
   * its lock faded while its row is pointed at, its tea-light seat on its top.
   */
  #frameBase(piece, w) {
    const box = new Box3();
    const was = this.spread;
    for (const f of [0, 1]) {
      this.spread = f;
      this.#layoutPieces();
      for (const e of this.pieceEntries) if (e.index === piece && e.mesh.visible) box.expandByObject(e.mesh);
    }
    this.spread = was;
    this.#layoutPieces();
    if (box.isEmpty()) return;
    box.expandByScalar(0.25 * box.getSize(new Vector3()).length());
    const up = w.out.clone().negate();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const flat = offset.addScaledVector(up, -offset.dot(up));
    // looking along the upright: from the front, as the view starts
    if (flat.lengthSq() < 1e-9) flat.set(0.55, -0.95, 0).addScaledVector(up, -new Vector3(0.55, -0.95, 0).dot(up));
    const above = (25 * Math.PI) / 180;
    this.#fitBox(box, flat.normalize().multiplyScalar(Math.cos(above)).addScaledVector(up, Math.sin(above)).normalize(), { clear: true });
  }

  #shownBounds() {
    const mode = this.viewMode;
    if (mode === 'pieces') {
      const box = new Box3();
      for (const e of this.pieceEntries) box.expandByObject(e.mesh);
      if (!box.isEmpty()) return box;
    }
    if (mode === 'result' && this.resultMesh?.geometry.boundingBox) return this.resultMesh.geometry.boundingBox;
    return this.bounds;
  }

  /** Move the camera to look straight at a surface point. */
  lookAt(point, normal) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.controls.target.set(...point);
    this.camera.position.set(...point).addScaledVector(new Vector3(...normal), dist);
    this.controls.update();
    this.requestRender();
  }

  #hit(hits) {
    const h = hits[0];
    if (!h?.face) return null;
    const normal = h.face.normal.clone();
    if (h.object.matrixWorld) normal.transformDirection(h.object.matrixWorld);
    normal.normalize();
    return { point: h.point.toArray(), normal: this.#surfaceNormal(h.object, h.point, normal, h.faceIndex), object: h.object };
  }

  /**
   * The direction the model's surface faces at a hit: the mean over a small disc rather than the one triangle under
   * the cursor, so text clicked onto a lumpy, sculpted surface faces the way the surface does (see surfaceNormalAt).
   */
  #surfaceNormal(object, point, normal, faceIndex) {
    const geometry = object === this.baseMesh ? object.geometry : null;
    if (!geometry?.boundsTree || !Number.isInteger(faceIndex)) return normal.toArray();
    const index = geometry.index;
    const pos = geometry.attributes.position;
    const a = new Vector3().fromBufferAttribute(pos, index.getX(faceIndex * 3));
    const b = new Vector3().fromBufferAttribute(pos, index.getX(faceIndex * 3 + 1));
    const c = new Vector3().fromBufferAttribute(pos, index.getX(faceIndex * 3 + 2));
    const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    return surfaceNormalAt(geometry.boundsTree, point.toArray(), normal.toArray(), clickRadius(edge));
  }

  #ndc(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }

  #pickModel(event) {
    if (!this.baseMesh) return null;
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    return this.#hit(this.raycaster.intersectObject(this.baseMesh, false));
  }

  #pickOverlay(event) {
    const meshes = [...this.overlays.values()].filter((o) => o.mesh.visible).map((o) => o.mesh);
    if (!meshes.length) return null;
    this.raycaster.setFromCamera(this.#ndc(event), this.camera);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.itemId : null;
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null; // { x, y, t, cut }
    let drag = null; // { itemId } or { cutId, start, at, t0, p, n }

    // picking a place for a cut on a touch screen: a finger on the model puts the plane there and slides it (with nothing
    // to hover, that is how a touch screen picks), and anywhere else turns the view; a second finger makes the touch a
    // pinch or a pan of the view instead, and the plane is left as it was. Heard before the view's controls hear the
    // touch: they keep track of the finger on the model without turning the view, so a second one still zooms it
    const fingers = new Set();
    let oneFinger; // what one finger does to the view, put back once every finger is lifted
    el.addEventListener('pointerdown', (e) => {
      if (!this.aim || e.pointerType !== 'touch') return;
      fingers.add(e.pointerId);
      if (fingers.size === 1 && this.#pickModel(e)) {
        this.aimTouch = { pointerId: e.pointerId, before: this.aimHover };
        oneFinger ??= this.controls.touches.ONE;
        this.controls.touches.ONE = null;
        el.setPointerCapture(e.pointerId);
        this.#aimMove(e, { keep: true });
      } else this.#aimTouchEnd({ cancel: true });
    }, { capture: true });
    const lifted = (e) => {
      if (!fingers.delete(e.pointerId) || fingers.size) return;
      if (oneFinger !== undefined) this.controls.touches.ONE = oneFinger;
      oneFinger = undefined;
    };
    window.addEventListener('pointerup', lifted, true);
    window.addEventListener('pointercancel', lifted, true);

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), cut: null };
      // picking a place for a cut: a press never takes a handle or an item (a touch is heard above)
      if (this.aim) return;
      // a part's ring handle is drawn over everything too: pressing it starts to resize its circle
      const grip = this.#pickGrip(e);
      if (grip) {
        down.cut = grip.id;
        this.controls.enabled = false;
        if (this.onPartDrag) {
          drag = { partId: grip.id, axis: grip.axis, position: grip.position, start: grip.r, r: grip.r, active: false };
          el.setPointerCapture(e.pointerId);
        }
        return;
      }
      // a cut's handle comes first: it is drawn over everything, and pressing it always means that cut
      const cutId = this.#pickCut(e);
      if (cutId) {
        const c = this.cuts.get(cutId);
        down.cut = cutId;
        this.controls.enabled = false; // pressing a handle never orbits
        if (this.onCutDrag) {
          const p = c.handle.getWorldPosition(new Vector3()).toArray();
          const n = [0, 0, 0];
          n[c.axis] = 1;
          // measured from where the pointer pressed (the ray #pickCut just cast), so the plane does not jump to the pointer when the drag starts
          const t0 = offsetAlongRay(this.raycaster.ray.origin.toArray(), this.raycaster.ray.direction.toArray(), p, n);
          if (t0 !== null) {
            drag = { cutId, start: c.at, at: c.at, t0, p, n, active: false };
            el.setPointerCapture(e.pointerId);
          }
        }
        if (!c.selected) {
          // last, because the caller may re-render (and cast rays of its own) straight away
          for (const o of this.cuts.values()) o.selected = o.id === cutId;
          this.#styleCuts();
          this.onSelectCut?.(cutId);
        }
        return;
      }
      // pressing on the selected item arms a drag
      const id = this.#pickOverlay(e);
      const o = id ? this.overlays.get(id) : null;
      if (o?.selected && this.onDrag) {
        drag = { itemId: id, active: false };
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this.aimTouch) {
        if (e.pointerId === this.aimTouch.pointerId) this.#aimFrame(e, { keep: true });
        return;
      }
      if (drag && down) {
        if (!drag.active && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) {
          drag.active = true;
          this.controls.enabled = false;
          el.style.cursor = 'grabbing';
          if (drag.cutId) {
            this.cutDrag = { id: drag.cutId, at: drag.at };
            this.#styleCuts();
          }
        }
        if (drag.active && drag.cutId) {
          this.#dragCut(drag, e);
        } else if (drag.active && drag.partId) {
          this.#dragGrip(drag, e);
        } else if (drag.active) {
          const hit = this.#pickModel(e);
          if (hit) this.onDrag({ itemId: drag.itemId, point: hit.point, normal: hit.normal, done: false });
        }
        return;
      }
      this.#hover(e);
    });

    const finish = (e) => {
      const d = down;
      const dr = drag;
      down = null;
      drag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
      if (this.aimTouch?.pointerId === e.pointerId) {
        this.#aimTouchEnd({ event: e }); // the finger lifted: the plane stays for the caller to place the cut
        return;
      }
      if (this.aim) {
        // a click on the model places the cut where the plane shows it, as the plane follows a still pointer while the
        // view moves (#aimAgain); a drag turned the view, and a touch places it from the pinned plane
        const click = d && e.pointerType !== 'touch' && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= CLICK_PX && performance.now() - d.t <= CLICK_MS;
        const h = click ? this.#aimPoint(e) : null;
        if (h) this.onAimPick?.({ at: h.at, target: h.target, shift: e.shiftKey, point: h.point, free: h.free });
        else if (this.aimHover && !this.aimHover.pinned) el.style.cursor = 'crosshair';
        return;
      }
      if (dr?.cutId) {
        this.cutDrag = null;
        this.dragTarget = null;
        this.#styleCuts();
        this.#syncAim(); // the section under the handle goes
        if (dr.active) this.onCutDrag?.({ id: dr.cutId, at: dr.at, target: dr.target ?? null, done: true, screen: this.cutScreenPosition(dr.cutId) });
        return;
      }
      if (dr?.partId) {
        if (dr.active) this.onPartDrag?.({ id: dr.partId, r: dr.r, done: true });
        return;
      }
      if (d?.cut) return; // a click on a handle selected its cut when it was pressed
      if (dr?.active) {
        const hit = this.#pickModel(e);
        this.onDrag({ itemId: dr.itemId, point: hit?.point, normal: hit?.normal, done: true });
        return;
      }
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX || performance.now() - d.t > CLICK_MS) return;
      const itemId = this.#pickOverlay(e); // overlays are only visible, and so only picked, in the model view
      if (itemId) {
        this.onSelectItem?.(itemId);
        return;
      }
      if (this.viewMode === 'pieces') return; // the pieces are drawn pulled apart, away from the model a click would land on
      const hit = this.#pickModel(e);
      if (hit) this.onPick?.(hit);
    };
    el.addEventListener('pointerup', finish);
    // a press given up: by the browser (the pointer cancelled), or a handle's drag by Escape (`cancelCutDrag`)
    const cancel = ({ dragOnly = false } = {}) => {
      const dr = drag;
      if (dragOnly && !((dr?.cutId || dr?.partId) && dr.active)) return false;
      down = null;
      drag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
      // a ring handle let go of: the circle goes back to the size it had
      if (dr?.partId) {
        if (dr.active) this.onPartDrag?.({ id: dr.partId, r: dr.start, done: true, cancelled: true });
        return dr.active;
      }
      if (!dr?.cutId) return false;
      // the plane goes back where it was, and the caller hears the drag is over
      this.cutDrag = null;
      this.dragTarget = null;
      if (dr.active) {
        this.setCutOffset(dr.cutId, dr.start);
        this.onCutDrag?.({ id: dr.cutId, at: dr.start, target: null, done: true, screen: this.cutScreenPosition(dr.cutId) });
      }
      this.#styleCuts();
      this.#syncAim(); // the section under the handle goes
      return dr.active;
    };
    el.addEventListener('pointercancel', () => cancel());
    this.cancelDrag = () => cancel({ dragOnly: true });
    el.addEventListener('pointerleave', () => {
      this.marker.visible = false;
      if (this.hoverCutId) {
        this.hoverCutId = null;
        this.#styleCuts();
      }
      // the mouse gone from the view takes the plane with it, and a view moved meanwhile (framed from its button) brings
      // none back; a finger lifted leaves it pinned
      if (this.aim && !drag && !this.aimTouch && this.aimLast?.pointerType !== 'touch') this.aimLast = null;
      if (this.aim && this.aimHover && !this.aimHover.pinned && !drag && !this.aimTouch) {
        this.aimHover = null;
        this.#syncAim();
        this.onAim?.({ at: null });
      }
      this.requestRender();
    });
    // Alt pressed or let go places the cut being placed or dragged freely, or snaps it again, where the pointer is
    const alt = (e) => {
      if (e.key !== 'Alt' || !this.aimLast) return;
      const dragging = drag?.cutId && drag.active;
      if (!dragging && !(this.aim && this.aimHover && !this.aimHover.pinned)) return;
      e.preventDefault(); // and the browser's menu bar stays shut
      const at = { ...this.aimLast, altKey: e.type === 'keydown' };
      if (dragging) this.#dragCut(drag, at);
      else this.#aimMove(at);
    };
    window.addEventListener('keydown', alt);
    window.addEventListener('keyup', alt);
  }

  /** A move while picking, once per frame: the section of a dense model is worked out at most that often. */
  #aimFrame(e, options = {}) {
    this.aimNext = { e, options };
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const next = this.aimNext;
      this.aimNext = null;
      if (next && this.aim) this.#aimMove(next.e, next.options);
    });
  }

  #hover(e) {
    if (this.aim) {
      if (e.pointerType === 'touch') return;
      // over the model the plane follows the pointer (the latest move, once a frame); a press turns the view, and the
      // plane follows the pointer as it turns (#aimAgain)
      if (!e.buttons) this.#aimFrame(e);
      else this.aimLast = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, pointerType: e.pointerType };
      return;
    }
    const model = this.hoverEnabled && !!this.baseMesh;
    if ((!model && !this.cuts.size) || e.buttons || this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const grip = this.#pickGrip(e);
      const cutId = grip ? null : this.#pickCut(e);
      if (cutId !== this.hoverCutId) {
        this.hoverCutId = cutId;
        this.#styleCuts();
      }
      // over a ring handle, what it does
      this.renderer.domElement.title = grip ? GRIP_TITLE : '';
      if (grip) {
        this.marker.visible = false;
        this.renderer.domElement.style.cursor = 'grab';
        this.requestRender();
        return;
      }
      const overItem = cutId || !model ? null : this.#pickOverlay(e);
      // the marker shows where a click would land on the model, which the pieces view does not draw where it is
      const hit = cutId || overItem || !model || this.viewMode === 'pieces' ? null : this.#pickModel(e);
      this.marker.visible = !!hit;
      if (hit) {
        const radius = Math.max(this.bounds.getSize(new Vector3()).length() * 0.02, 0.5);
        this.marker.position.set(...hit.point);
        this.marker.scale.setScalar(radius);
        this.marker.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...hit.normal)));
      }
      const selectedOver = overItem && this.overlays.get(overItem)?.selected;
      this.renderer.domElement.style.cursor = cutId || selectedOver ? 'grab' : overItem ? 'pointer' : hit ? 'crosshair' : '';
      this.requestRender();
    });
  }

  #buildGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const extent = Math.max(this.bounds.getSize(new Vector3()).length() * 1.6, 100);
    const size = Math.ceil(extent / 10) * 10;
    this.grid = new GridHelper(size, size / 10, 0x7a869c, 0x7a869c);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.25;
    this.grid.rotation.x = Math.PI / 2;
    const c = this.bounds.getCenter(new Vector3());
    this.grid.position.set(Math.round(c.x / 10) * 10, Math.round(c.y / 10) * 10, this.bounds.min.z - 0.01);
    this.scene.add(this.grid);
  }

  /** The scale that draws a badge `px` CSS pixels tall (badges keep their size on screen, so it follows the canvas height). */
  #spriteScale(px) {
    return (2 * px * Math.tan((this.camera.fov * Math.PI) / 360)) / this.viewSize[1];
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.viewSize = [w, h]; // kept, so badges and the readout never read the layout back on every render
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const c of this.cuts.values()) c.badge.scale.setScalar(this.#spriteScale(c.badge.userData.px));
    for (const c of this.partCircles) c.badge.scale.setScalar(this.#spriteScale(c.badge.userData.px));
    for (const l of this.pieceLabels) l.sprite.scale.setScalar(this.#spriteScale(l.sprite.userData.px));
    this.aimParts.dot.scale.setScalar(this.#spriteScale(this.aimParts.dot.userData.px));
    this.requestRender();
  }
}

export { BufferGeometry };
