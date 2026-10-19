import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Triangle,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
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
import { geometryFromBuffers } from './mesh.js';
import { clickRadius, surfaceNormalAt } from './surfaceNormal.js';
import {
  APART_COLOR, CUT_COLOR, PIECE_COLORS, PIN_COLOR, TOO_BIG_COLOR, axisCuts, cellSizes, cutPlane, explodeOffset, letterFor, offsetAlongRay, pieceColorIndex, snapTarget,
  triangleInBox,
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
    this.scene.add(this.cutGroup, this.cellGroup, this.pieceGroup, this.pieceLabelGroup);

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
    this.onAim = null; // ({ at, raw, target, point, screen, pinned }) the place under the pointer while picking, or ({ at: null }) none
    this.onAimPick = null; // ({ at, target, shift }) clicked the model while picking
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
   * @param {{ axis: number, snap?: boolean }|null} aim null ends it; `snap` false places it freely (a glued cut)
   */
  setAim(aim) {
    this.aim = aim ? { axis: aim.axis, snap: aim.snap !== false } : null;
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
    return { at: placedAt(raw, target), raw, target, point: hit.point, screen: [event.clientX - rect.left, event.clientY - rect.top] };
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
    p.plane.visible = !!shown && !shown.handle && model; // a dragged cut has its own plane
    p.section.visible = !!shown && model && !!this.baseMesh;
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
    const ticks = model && axis !== null && this.aimTargets.axis === axis && this.aimTargets.list.length > 0;
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
   * @param {{ positions: Float32Array, normals?: Float32Array, index: Uint32Array, passthroughRanges?: number[][],
   *           ranges: number[][], parts?: object[] }|null} display
   *   `ranges[r] = [triStart, triCount, vertStart, vertCount]`, each self-contained; `parts[r]` is
   *   `{ kind: 'piece', index }`, `{ kind: 'pin', cell }` (a half-cell, between its two pieces) or `{ kind: 'part', id, cell }`
   * @param {{ index: number, cell: number[], fits?: boolean }[]} [pieces] the result's pieces; `fits: false` tints a piece red
   * @param {number[]|null} [grid] the number of cuts on each axis (from the pieces' cells without it)
   */
  setPieces(display, pieces = [], grid = null) {
    this.#disposeMesh(this.resultMesh);
    this.resultMesh = null;
    this.#clearPieces();
    if (display?.index?.length && display.ranges?.length) this.#buildPieces(display, pieces ?? [], grid);
    this.showResult(this.resultShown);
  }

  #buildPieces(display, pieces, grid) {
    const info = new Map(pieces.map((p) => [p.index, p]));
    const passthrough = display.passthroughRanges ?? [];
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
      const loose = rangesWithin(passthrough, t0, tc);
      let mesh;
      if (loose.length) {
        // unrepaired triangles cut with the piece: drawn as in the model view, from both sides
        addGroups(geometry, loose, tc);
        mesh = new Mesh(geometry, [material, new MeshStandardMaterial({ color: COLORS.passthrough, roughness: 0.6, metalness: 0.05, side: DoubleSide })]);
      } else {
        mesh = new Mesh(geometry, material);
      }
      mesh.userData = { kind: part.kind, index: part.kind === 'piece' ? part.index : null };
      this.pieceGroup.add(mesh);
      this.pieceEntries.push({ mesh, kind: part.kind, index: part.kind === 'piece' ? part.index : null, cell, fits });
      all.union(geometry.boundingBox);
      if (part.kind === 'piece') {
        if (!boxes.has(part.index)) boxes.set(part.index, { box: new Box3(), cell, fits });
        boxes.get(part.index).box.union(geometry.boundingBox);
      }
    });
    this.pieceGrid = grid ?? [0, 1, 2].map((a) => Math.max(0, ...this.pieceEntries.filter((e) => e.kind === 'piece').map((e) => e.cell[a])));
    this.pieceBounds = all.isEmpty() ? null : all;
    for (const [index, { box, cell, fits }] of boxes) {
      const sprite = labelSprite(String(index), {
        fill: fits ? 'rgba(27, 34, 48, 0.82)' : cssColor(COLORS.tooBig),
        ring: cssColor(PIECE_COLORS[pieceColorIndex(cell)]),
        px: 24,
      });
      sprite.scale.setScalar(this.#spriteScale(sprite.userData.px));
      this.pieceLabelGroup.add(sprite);
      this.pieceLabels.push({ sprite, index, centre: box.getCenter(new Vector3()), cell });
    }
    this.#layoutPieces();
    this.#stylePieces();
  }

  #clearPieces() {
    for (const e of this.pieceEntries) {
      this.pieceGroup.remove(e.mesh);
      e.mesh.geometry.dispose();
      for (const m of [e.mesh.material].flat()) m.dispose();
    }
    for (const l of this.pieceLabels) {
      this.pieceLabelGroup.remove(l.sprite);
      disposeSprite(l.sprite);
    }
    this.pieceEntries = [];
    this.pieceLabels = [];
    this.pieceBounds = null;
    this.piecesStale = false; // the stale ones are gone
  }

  /** How far apart neighbouring pieces are drawn, in mm: Spread × 8 % of the diagonal, kept within 6–50 mm. */
  #explodeGap() {
    const box = this.pieceBounds ?? this.#cutBounds();
    return this.spread * clamp(0.08 * box.getSize(new Vector3()).length(), 6, 50);
  }

  #layoutPieces() {
    const gap = this.#explodeGap();
    for (const e of this.pieceEntries) e.mesh.position.fromArray(explodeOffset(e.cell, this.pieceGrid, gap));
    for (const l of this.pieceLabels) l.sprite.position.copy(l.centre).add(new Vector3(...explodeOffset(l.cell, this.pieceGrid, gap)));
  }

  #stylePieces() {
    const stale = this.piecesStale ? 0.6 : 1;
    const focus = this.pieceHighlight;
    for (const e of this.pieceEntries) {
      const shown = focus == null || e.index === focus;
      const opacity = stale * (shown ? 1 : 0.3);
      const materials = [e.mesh.material].flat();
      for (const m of materials) {
        if (m.transparent !== opacity < 1) m.needsUpdate = true;
        m.transparent = opacity < 1;
        m.opacity = opacity;
      }
      materials[0].emissive.setHex(!e.fits ? TOO_BIG_COLOR : focus != null && shown ? 0x262626 : 0);
    }
    for (const l of this.pieceLabels) l.sprite.material.opacity = focus == null || l.index === focus ? stale : 0.35;
    this.requestRender();
  }

  /** Spread the pieces apart: 0 (assembled) to 2; 1 is the default gap. */
  setSpread(f) {
    this.spread = clamp(Number(f) || 0, 0, 2);
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
    const box = this.#shownBounds();
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 5);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    this.camera.position.copy(center).add(new Vector3(0.55, -0.95, 0.75).normalize().multiplyScalar(dist * 1.05));
    this.camera.near = radius / 200;
    this.camera.far = radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
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
        if (h) this.onAimPick?.({ at: h.at, target: h.target, shift: e.shiftKey });
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
      if (dragOnly && !(dr?.cutId && dr.active)) return false;
      down = null;
      drag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
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
      const cutId = this.#pickCut(e);
      if (cutId !== this.hoverCutId) {
        this.hoverCutId = cutId;
        this.#styleCuts();
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
    for (const l of this.pieceLabels) l.sprite.scale.setScalar(this.#spriteScale(l.sprite.userData.px));
    this.aimParts.dot.scale.setScalar(this.#spriteScale(this.aimParts.dot.userData.px));
    this.requestRender();
  }
}

export { BufferGeometry };
