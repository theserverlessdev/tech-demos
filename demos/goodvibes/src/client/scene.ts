import * as THREE from "three";
import { ARENA, clampPos, type Player } from "../shared/types";

type Marker = {
  group: THREE.Group;
  body: THREE.Mesh;
  ring: THREE.Mesh;
  target: THREE.Vector3;
  label: THREE.Sprite;
};

const SPEED = 5.6;
const REMOTE_LERP = 10;

function nameSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(14, 14, 17, 0.78)";
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 8);
  ctx.arcTo(248, 8, 248, 56, r);
  ctx.arcTo(248, 56, 8, 56, r);
  ctx.arcTo(8, 56, 8, 8, r);
  ctx.arcTo(8, 8, 248, 8, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#e8e8e4";
  ctx.font = "600 28px 'Hanken Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.slice(0, 18), 128, 34);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.15;
  sprite.renderOrder = 2;
  return sprite;
}

function makeMarker(player: Player, self: boolean): Marker {
  const group = new THREE.Group();
  group.position.set(player.x, 0, player.z);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.85, 6, 14),
    new THREE.MeshStandardMaterial({
      color: player.color,
      roughness: 0.42,
      metalness: 0.08,
      emissive: new THREE.Color(player.color),
      emissiveIntensity: self ? 0.28 : 0.14,
    }),
  );
  body.position.y = 0.75;
  body.castShadow = false;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({
      color: "#e8e8e4",
      roughness: 0.5,
      emissive: new THREE.Color(player.color),
      emissiveIntensity: 0.08,
    }),
  );
  head.position.y = 1.42;
  group.add(head);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.62, 32),
    new THREE.MeshBasicMaterial({
      color: self ? "#c2410c" : player.color,
      transparent: true,
      opacity: self ? 0.9 : 0.4,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  const label = nameSprite(player.name);
  group.add(label);

  return { group, body, ring, label, target: new THREE.Vector3(player.x, 0, player.z) };
}

export class LobbyScene {
  readonly keys = new Set<string>();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly floor: THREE.Mesh;
  private readonly markers = new Map<string, Marker>();
  private readonly clock = new THREE.Clock();
  private localId: string | null = null;
  private walkTarget: THREE.Vector3 | null = null;
  private raf = 0;
  private onMove: ((x: number, z: number) => void) | null = null;
  private lastSent = 0;
  private lastX = 0;
  private lastZ = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0e0e11, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e0e11);
    this.scene.fog = new THREE.Fog(0x0e0e11, 18, 42);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
    this.camera.position.set(0, 16.5, 17.5);
    this.camera.lookAt(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0xf5efe6, 0x1a1512, 1.05);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xe8e8e4, 0.85);
    key.position.set(8, 18, 6);
    this.scene.add(key);
    const ember = new THREE.PointLight(0xc2410c, 18, 28, 2);
    ember.position.set(-4, 5, 3);
    this.scene.add(ember);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA + 1.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.92, metalness: 0.04 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.floor = ground;

    const grid = new THREE.GridHelper(ARENA * 2, 24, 0x3a2a24, 0x222226);
    const gridMat = grid.material;
    if (!Array.isArray(gridMat)) {
      gridMat.transparent = true;
      gridMat.opacity = 0.55;
    }
    this.scene.add(grid);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA + 0.2, 0.06, 8, 64),
      new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.4, emissive: 0xc2410c, emissiveIntensity: 0.35 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.04;
    this.scene.add(rim);

    this.resize();
    window.addEventListener("resize", this.resize);
    canvas.addEventListener("pointerdown", this.onPointer);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.tick();
  }

  setMover(fn: (x: number, z: number) => void): void {
    this.onMove = fn;
  }

  setLocal(player: Player): void {
    this.localId = player.id;
    this.upsert(player, true);
    this.lastX = player.x;
    this.lastZ = player.z;
  }

  upsert(player: Player, snap = false): void {
    let marker = this.markers.get(player.id);
    if (!marker) {
      marker = makeMarker(player, player.id === this.localId);
      this.markers.set(player.id, marker);
      this.scene.add(marker.group);
    }
    marker.target.set(player.x, 0, player.z);
    if (snap) marker.group.position.copy(marker.target);
  }

  remove(id: string): void {
    const marker = this.markers.get(id);
    if (!marker) return;
    this.scene.remove(marker.group);
    this.markers.delete(id);
  }

  localPosition(): { x: number; z: number } | null {
    if (!this.localId) return null;
    const marker = this.markers.get(this.localId);
    if (!marker) return null;
    return { x: marker.group.position.x, z: marker.group.position.z };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointer);
    this.renderer.dispose();
    this.markers.clear();
  }

  private readonly resize = (): void => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    this.camera.aspect = Math.max(w / Math.max(h, 1), 0.4);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  private readonly onPointer = (ev: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.floor);
    const hit = hits[0];
    if (!hit) return;
    this.walkTarget = new THREE.Vector3(clampPos(hit.point.x), 0, clampPos(hit.point.z));
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const key = ev.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
      ev.preventDefault();
      this.keys.add(key);
      this.walkTarget = null;
    }
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    this.keys.delete(ev.key.toLowerCase());
  };

  private tick = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    const local = this.localId ? this.markers.get(this.localId) : undefined;
    if (local) {
      let dx = 0;
      let dz = 0;
      if (this.keys.has("w") || this.keys.has("arrowup")) dz -= 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) dz += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
      if (dx || dz) {
        const len = Math.hypot(dx, dz) || 1;
        local.group.position.x = clampPos(local.group.position.x + (dx / len) * SPEED * dt);
        local.group.position.z = clampPos(local.group.position.z + (dz / len) * SPEED * dt);
        local.target.copy(local.group.position);
      } else if (this.walkTarget) {
        const to = this.walkTarget.clone().sub(local.group.position);
        to.y = 0;
        const dist = to.length();
        if (dist < 0.05) {
          local.group.position.copy(this.walkTarget);
          this.walkTarget = null;
        } else {
          to.setLength(Math.min(dist, SPEED * dt));
          local.group.position.x = clampPos(local.group.position.x + to.x);
          local.group.position.z = clampPos(local.group.position.z + to.z);
        }
        local.target.copy(local.group.position);
      }
      const now = performance.now();
      const moved = Math.hypot(local.group.position.x - this.lastX, local.group.position.z - this.lastZ);
      if (moved > 0.02 && now - this.lastSent > 50) {
        this.lastSent = now;
        this.lastX = local.group.position.x;
        this.lastZ = local.group.position.z;
        this.onMove?.(this.lastX, this.lastZ);
      }
      local.ring.rotation.z += dt * 0.8;
    }

    for (const [id, marker] of this.markers) {
      if (id === this.localId) continue;
      marker.group.position.lerp(marker.target, 1 - Math.exp(-REMOTE_LERP * dt));
    }

    this.renderer.render(this.scene, this.camera);
  };
}
