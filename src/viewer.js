import {
  AmbientLight,
  Box3,
  BufferGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  Matrix4,
  Triangle,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { geometryFromBuffers } from './mesh.js';

Mesh.prototype.raycast = acceleratedRaycast;

const COLORS = {
  model: 0x8aa4c8,
  passthrough: 0xe0a93a,
  emboss: 0xff8a2b,
  engrave: 0xff3b6b,
  detached: 0xb8bcc8, // an item that is not touching the model
  marker: 0x22d3a6,
};

const CLICK_PX = 5;
const CLICK_MS = 500;

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
 *
 * Renders on demand, so an idle page costs nothing.
 */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(60, -90, 70);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new HemisphereLight(0xffffff, 0x445066, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, -0.8, 1.2);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.materials = {
      model: new MeshStandardMaterial({ color: COLORS.model, roughness: 0.55, metalness: 0.05, side: DoubleSide }),
      passthrough: new MeshStandardMaterial({ color: COLORS.passthrough, roughness: 0.6, metalness: 0.05, side: DoubleSide }),
    };
    this.baseMesh = null;
    this.resultMesh = null;
    this.resultShown = false;
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

    this.grid = null;
    this.bounds = new Box3(new Vector3(-50, -50, 0), new Vector3(50, 50, 10));
    this.#buildGrid();

    this.raycaster = new Raycaster();
    this.raycaster.firstHitOnly = true;
    this.onPick = null; // ({ point, normal }) clicked bare model
    this.onSelectItem = null; // (itemId) clicked an item
    this.onDrag = null; // ({ itemId, point, normal, done })
    this.hoverEnabled = true;
    this.#bindPointer();

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
    let cursor = 0;
    for (const [start, count] of ranges) {
      if (start > cursor) geometry.addGroup(cursor * 3, (start - cursor) * 3, 0);
      geometry.addGroup(start * 3, count * 3, 1);
      cursor = start + count;
    }
    if (cursor < triangles) geometry.addGroup(cursor * 3, (triangles - cursor) * 3, 0);
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
    this.#disposeMesh(this.baseMesh);
    this.baseMesh = null;
    this.setResult(null);
    if (display && display.index.length) {
      this.baseMesh = this.#meshFromDisplay(display);
      this.scene.add(this.baseMesh);
      this.bounds.copy(this.baseMesh.geometry.boundingBox);
    } else {
      this.bounds.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 10));
    }
    this.#buildGrid();
    this.marker.visible = false;
    this.requestRender();
  }

  /** Show (or clear) the final result in place of the model. */
  setResult(display) {
    this.#disposeMesh(this.resultMesh);
    this.resultMesh = null;
    if (display && display.index.length) {
      this.resultMesh = this.#meshFromDisplay(display);
      this.scene.add(this.resultMesh);
    }
    this.showResult(this.resultShown);
  }

  showResult(on) {
    this.resultShown = !!on && !!this.resultMesh;
    if (this.resultMesh) this.resultMesh.visible = this.resultShown;
    if (this.baseMesh) this.baseMesh.visible = !this.resultShown;
    for (const o of this.overlays.values()) o.mesh.visible = !this.resultShown;
    this.requestRender();
  }

  get hasModel() {
    return !!this.baseMesh;
  }

  /* ---------------------------------------------------------- overlays */

  #overlayMaterial(mode) {
    return mode === 'engrave'
      ? new MeshStandardMaterial({ color: COLORS.engrave, roughness: 0.6, flatShading: true, transparent: true, opacity: 0.6, depthTest: false })
      : new MeshStandardMaterial({ color: COLORS.emboss, roughness: 0.45, flatShading: true, transparent: true, opacity: 1 });
  }

  #styleOverlay(o) {
    const base = o.mode === 'engrave' ? 0.6 : 1;
    const fade = o.selected ? 1 : 0.55;
    const stale = o.stale ? 0.7 : 1;
    const loose = o.detached ? 0.55 : 1;
    o.mesh.material.opacity = base * fade * stale * loose;
    o.mesh.material.color.set(o.detached ? COLORS.detached : o.mode === 'engrave' ? COLORS.engrave : COLORS.emboss);
    o.mesh.material.wireframe = !!o.detached;
    o.mesh.material.transparent = true;
    o.mesh.renderOrder = o.mode === 'engrave' ? 5 : 0;
    o.mesh.visible = !this.resultShown;
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
    return { point: found.point.toArray(), normal: normal.toArray() };
  }

  /** First model surface hit by a ray from `origin` along `direction`, or null. */
  raycastFrom(origin, direction) {
    if (!this.baseMesh) return null;
    this.raycaster.set(new Vector3(...origin), new Vector3(...direction).normalize());
    return this.#hit(this.raycaster.intersectObject(this.baseMesh, false));
  }

  /** Fit the camera to the model (or the empty build plate). */
  frame() {
    const center = this.bounds.getCenter(new Vector3());
    const radius = Math.max(this.bounds.getSize(new Vector3()).length() / 2, 5);
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
    return { point: h.point.toArray(), normal: normal.normalize().toArray(), object: h.object };
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
    let down = null;
    let drag = null; // { itemId }

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      // pressing on the selected item arms a drag
      const id = this.#pickOverlay(e);
      const o = id ? this.overlays.get(id) : null;
      if (o?.selected && this.onDrag) {
        drag = { itemId: id, active: false };
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (drag && down) {
        if (!drag.active && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) {
          drag.active = true;
          this.controls.enabled = false;
          el.style.cursor = 'grabbing';
        }
        if (drag.active) {
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
      if (dr?.active) {
        const hit = this.#pickModel(e);
        this.onDrag({ itemId: dr.itemId, point: hit?.point, normal: hit?.normal, done: true });
        return;
      }
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX || performance.now() - d.t > CLICK_MS) return;
      const itemId = this.#pickOverlay(e);
      if (itemId) {
        this.onSelectItem?.(itemId);
        return;
      }
      const hit = this.#pickModel(e);
      if (hit) this.onPick?.(hit);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => {
      down = null;
      drag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
    });
    el.addEventListener('pointerleave', () => {
      this.marker.visible = false;
      this.requestRender();
    });
  }

  #hover(e) {
    if (!this.hoverEnabled || !this.baseMesh || e.buttons || this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const overItem = this.#pickOverlay(e);
      const hit = overItem ? null : this.#pickModel(e);
      this.marker.visible = !!hit;
      if (hit) {
        const radius = Math.max(this.bounds.getSize(new Vector3()).length() * 0.02, 0.5);
        this.marker.position.set(...hit.point);
        this.marker.scale.setScalar(radius);
        this.marker.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...hit.normal)));
      }
      const selectedOver = overItem && this.overlays.get(overItem)?.selected;
      this.renderer.domElement.style.cursor = selectedOver ? 'grab' : overItem ? 'pointer' : hit ? 'crosshair' : '';
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

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }
}

export { BufferGeometry };
