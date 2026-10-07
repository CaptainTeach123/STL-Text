import {
  AmbientLight,
  Box3,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  MeshBasicMaterial,
  CylinderGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

const COLORS = {
  model: 0x8aa4c8,
  emboss: 0xff8a2b,
  engrave: 0xff3b6b,
  marker: 0x22d3a6,
};

/**
 * Three.js scene for the editor. Z is up (like STL files and slicers).
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

    this.modelMaterial = new MeshStandardMaterial({
      color: COLORS.model,
      roughness: 0.55,
      metalness: 0.05,
      side: DoubleSide,
    });
    this.modelMesh = null;
    this.textMesh = null;
    this.textMaterials = {
      emboss: new MeshStandardMaterial({ color: COLORS.emboss, roughness: 0.45, flatShading: true }),
      engrave: new MeshStandardMaterial({
        color: COLORS.engrave,
        roughness: 0.6,
        flatShading: true,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      }),
    };

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
    this.onPick = null;
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

  /** Show `geometry` (with normals) as the model, or nothing for null. */
  setModel(geometry) {
    if (this.modelMesh) {
      this.scene.remove(this.modelMesh);
      this.modelMesh.geometry.disposeBoundsTree?.();
      this.modelMesh.geometry.dispose();
      this.modelMesh = null;
    }
    if (geometry) {
      geometry.computeBoundsTree();
      geometry.computeBoundingBox();
      this.modelMesh = new Mesh(geometry, this.modelMaterial);
      this.scene.add(this.modelMesh);
      this.bounds.copy(geometry.boundingBox);
    } else {
      this.bounds.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 10));
    }
    this.#buildGrid();
    this.marker.visible = false;
    this.requestRender();
  }

  /** Show the text solid: `matrix` is its placement, `mode` styles it. */
  setText(geometry, matrix, mode) {
    if (this.textMesh) {
      this.scene.remove(this.textMesh);
      this.textMesh.geometry.dispose();
      this.textMesh = null;
    }
    if (geometry) {
      const flat = geometry.toNonIndexed();
      flat.computeVertexNormals();
      this.textMesh = new Mesh(flat, this.textMaterials[mode] ?? this.textMaterials.emboss);
      this.textMesh.renderOrder = mode === 'engrave' ? 5 : 0;
      this.textMesh.matrixAutoUpdate = false;
      this.textMesh.matrix.copy(matrix);
      this.scene.add(this.textMesh);
    }
    this.requestRender();
  }

  setTextMatrix(matrix) {
    if (!this.textMesh) return;
    this.textMesh.matrix.copy(matrix);
    this.requestRender();
  }

  setHoverEnabled(enabled) {
    this.hoverEnabled = enabled;
    if (!enabled) {
      this.marker.visible = false;
      this.requestRender();
    }
  }

  /** First surface hit by a ray from `origin` along `direction`, or null. */
  raycastFrom(origin, direction) {
    if (!this.modelMesh) return null;
    this.raycaster.set(new Vector3(...origin), new Vector3(...direction).normalize());
    return this.#hit(this.raycaster.intersectObject(this.modelMesh, false));
  }

  /** Fit the camera to the model (or the empty build plate). */
  frame() {
    const center = this.bounds.getCenter(new Vector3());
    const radius = Math.max(this.bounds.getSize(new Vector3()).length() / 2, 5);
    // fit to whichever field of view is narrower (horizontal on portrait screens)
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
    return { point: h.point.toArray(), normal: h.face.normal.clone().normalize().toArray() };
  }

  #pick(event) {
    if (!this.modelMesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.#hit(this.raycaster.intersectObject(this.modelMesh, false));
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    });
    el.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      // a click, not an orbit/pan drag
      if (!d || d.button !== 0 || !this.onPick) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
      const hit = this.#pick(e);
      if (hit) this.onPick(hit);
    });
    let hoverQueued = false;
    el.addEventListener('pointermove', (e) => {
      if (!this.hoverEnabled || !this.modelMesh || e.buttons || hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        const hit = this.#pick(e);
        this.marker.visible = !!hit;
        if (hit) {
          const radius = Math.max(this.bounds.getSize(new Vector3()).length() * 0.02, 0.5);
          this.marker.position.set(...hit.point);
          this.marker.scale.setScalar(radius);
          this.marker.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...hit.normal)));
        }
        el.style.cursor = hit ? 'crosshair' : '';
        this.requestRender();
      });
    });
    el.addEventListener('pointerleave', () => {
      this.marker.visible = false;
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
