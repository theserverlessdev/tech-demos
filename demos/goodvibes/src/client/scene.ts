import * as THREE from "three";
import { ARENA, clampPos, type Player } from "../shared/types";

type Marker3 = {
  group: THREE.Group;
  ring: THREE.Mesh;
  target: THREE.Vector3;
};

const SPEED = 5.6;
const REMOTE_LERP = 10;

function nameSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
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

function makeMarker(player: Player, self: boolean): Marker3 {
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
  group.add(nameSprite(player.name));

  return { group, ring, target: new THREE.Vector3(player.x, 0, player.z) };
}

function tryWebGL(canvas: HTMLCanvasElement): WebGLRenderingContext | WebGL2RenderingContext | null {
  const opts: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: true,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "default",
    preserveDrawingBuffer: true,
  };
  try {
    return canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts);
  } catch {
    return null;
  }
}

type Flat = { x: number; z: number; color: string; name: string; self: boolean; tx: number; tz: number };

export class LobbyScene {
  readonly keys = new Set<string>();
  readonly webgl: boolean;
  private readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private raycaster: THREE.Raycaster | null = null;
  private floor: THREE.Mesh | null = null;
  private readonly pointer = new THREE.Vector2();
  private readonly markers = new Map<string, Marker3>();
  private readonly flats = new Map<string, Flat>();
  private readonly clock = new THREE.Clock();
  private ctx2d: CanvasRenderingContext2D | null = null;
  private localId: string | null = null;
  private walkTarget: { x: number; z: number } | null = null;
  private raf = 0;
  private onMove: ((x: number, z: number) => void) | null = null;
  private lastSent = 0;
  private lastX = 0;
  private lastZ = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const probe = document.createElement("canvas");
    const glOk = Boolean(tryWebGL(probe));
    this.webgl = false;
    if (glOk) {
      try {
        const gl = tryWebGL(canvas);
        if (!gl) throw new Error("no gl");
        this.initWebGL(gl);
        this.webgl = true;
      } catch {
        this.ctx2d = canvas.getContext("2d");
      }
    } else {
      this.ctx2d = canvas.getContext("2d");
    }
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
    this.flats.set(player.id, {
      x: snap ? player.x : (this.flats.get(player.id)?.x ?? player.x),
      z: snap ? player.z : (this.flats.get(player.id)?.z ?? player.z),
      tx: player.x,
      tz: player.z,
      color: player.color,
      name: player.name,
      self: player.id === this.localId,
    });
    if (!this.webgl || !this.scene) return;
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
    this.flats.delete(id);
    const marker = this.markers.get(id);
    if (!marker || !this.scene) return;
    this.scene.remove(marker.group);
    this.markers.delete(id);
  }

  localPosition(): { x: number; z: number } | null {
    if (this.localId && this.webgl) {
      const marker = this.markers.get(this.localId);
      if (marker) return { x: marker.group.position.x, z: marker.group.position.z };
    }
    if (this.localId) {
      const flat = this.flats.get(this.localId);
      if (flat) return { x: flat.x, z: flat.z };
    }
    return null;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("pointerdown", this.onPointer);
    this.renderer?.dispose();
    this.markers.clear();
    this.flats.clear();
  }

  private initWebGL(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      context: gl,
      antialias: false,
      alpha: false,
      powerPreference: "default",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0e0e11, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e0e11);
    scene.fog = new THREE.Fog(0x0e0e11, 18, 42);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
    camera.position.set(0, 16.5, 17.5);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    scene.add(new THREE.HemisphereLight(0xf5efe6, 0x1a1512, 1.05));
    const key = new THREE.DirectionalLight(0xe8e8e4, 0.85);
    key.position.set(8, 18, 6);
    scene.add(key);
    const ember = new THREE.PointLight(0xc2410c, 18, 28, 2);
    ember.position.set(-4, 5, 3);
    scene.add(ember);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA + 1.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.92, metalness: 0.04 }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    this.floor = ground;
    this.raycaster = new THREE.Raycaster();

    const grid = new THREE.GridHelper(ARENA * 2, 24, 0x3a2a24, 0x222226);
    const gridMat = grid.material;
    if (!Array.isArray(gridMat)) {
      gridMat.transparent = true;
      gridMat.opacity = 0.55;
    }
    scene.add(grid);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA + 0.2, 0.06, 8, 64),
      new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.4, emissive: 0xc2410c, emissiveIntensity: 0.35 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.04;
    scene.add(rim);
  }

  private readonly resize = (): void => {
    const parent = this.canvas.parentElement;
    const w = Math.max(parent?.clientWidth || window.innerWidth, 1);
    const h = Math.max(parent?.clientHeight || window.innerHeight, 1);
    if (this.renderer && this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
  };

  private worldFromEvent(ev: PointerEvent): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    if (this.webgl && this.camera && this.raycaster && this.floor) {
      this.pointer.set(nx, ny);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.floor)[0];
      if (!hit) return null;
      return { x: clampPos(hit.point.x), z: clampPos(hit.point.z) };
    }
    const { originX, originY, scale } = this.flatMap();
    const dpr = this.canvas.width / Math.max(rect.width, 1);
    const px = (ev.clientX - rect.left) * dpr;
    const py = (ev.clientY - rect.top) * dpr;
    return { x: clampPos((px - originX) / scale), z: clampPos((py - originY) / scale) };
  }

  private readonly onPointer = (ev: PointerEvent): void => {
    const hit = this.worldFromEvent(ev);
    if (!hit) return;
    this.walkTarget = hit;
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

  private stepLocal(dt: number): { x: number; z: number } | null {
    let x: number;
    let z: number;
    if (this.webgl && this.localId) {
      const marker = this.markers.get(this.localId);
      if (!marker) return null;
      x = marker.group.position.x;
      z = marker.group.position.z;
    } else if (this.localId) {
      const flat = this.flats.get(this.localId);
      if (!flat) return null;
      x = flat.x;
      z = flat.z;
    } else {
      return null;
    }

    let dx = 0;
    let dz = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) dz -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dz += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    if (dx || dz) {
      const len = Math.hypot(dx, dz) || 1;
      x = clampPos(x + (dx / len) * SPEED * dt);
      z = clampPos(z + (dz / len) * SPEED * dt);
    } else if (this.walkTarget) {
      const tx = this.walkTarget.x - x;
      const tz = this.walkTarget.z - z;
      const dist = Math.hypot(tx, tz);
      if (dist < 0.05) {
        x = this.walkTarget.x;
        z = this.walkTarget.z;
        this.walkTarget = null;
      } else {
        const step = Math.min(dist, SPEED * dt);
        x = clampPos(x + (tx / dist) * step);
        z = clampPos(z + (tz / dist) * step);
      }
    }

    if (this.webgl && this.localId) {
      const marker = this.markers.get(this.localId);
      if (marker) {
        marker.group.position.set(x, 0, z);
        marker.target.set(x, 0, z);
        marker.ring.rotation.z += dt * 0.8;
      }
    }
    const flat = this.localId ? this.flats.get(this.localId) : undefined;
    if (flat) {
      flat.x = x;
      flat.z = z;
      flat.tx = x;
      flat.tz = z;
    }
    return { x, z };
  }

  private flatMap(): { originX: number; originY: number; scale: number } {
    const pad = 48;
    const size = Math.min(this.canvas.width, this.canvas.height) - pad * 2;
    const scale = size / (ARENA * 2 + 2);
    return { originX: this.canvas.width / 2, originY: this.canvas.height / 2, scale };
  }

  private drawFlat(dt: number): void {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const { originX, originY, scale } = this.flatMap();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0e0e11";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.translate(originX, originY);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = -ARENA; i <= ARENA; i += 2) {
      ctx.beginPath();
      ctx.moveTo(i * scale, -ARENA * scale);
      ctx.lineTo(i * scale, ARENA * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-ARENA * scale, i * scale);
      ctx.lineTo(ARENA * scale, i * scale);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, (ARENA + 0.2) * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "#c2410c";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    const k = 1 - Math.exp(-REMOTE_LERP * dt);
    for (const [id, p] of this.flats) {
      if (id !== this.localId) {
        p.x += (p.tx - p.x) * k;
        p.z += (p.tz - p.z) * k;
      }
      const sx = originX + p.x * scale;
      const sy = originY + p.z * scale;
      ctx.beginPath();
      ctx.arc(sx, sy, p.self ? 16 : 13, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      if (p.self) {
        ctx.strokeStyle = "#e2622e";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, 22, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.font = "600 14px 'Hanken Grotesk', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#e8e8e4";
      ctx.fillText(p.name.slice(0, 18), sx, sy - 28);
    }

    ctx.font = "500 12px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillStyle = "#8a8a85";
    ctx.textAlign = "left";
    ctx.fillText("2D fallback · WebGL unavailable in this browser", 16, this.canvas.height - 18);
  }

  private tick = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const local = this.stepLocal(dt);
    if (local) {
      const now = performance.now();
      const moved = Math.hypot(local.x - this.lastX, local.z - this.lastZ);
      if (moved > 0.02 && now - this.lastSent > 50) {
        this.lastSent = now;
        this.lastX = local.x;
        this.lastZ = local.z;
        this.onMove?.(local.x, local.z);
      }
    }
    if (this.webgl && this.renderer && this.scene && this.camera) {
      for (const [id, marker] of this.markers) {
        if (id === this.localId) continue;
        marker.group.position.lerp(marker.target, 1 - Math.exp(-REMOTE_LERP * dt));
      }
      this.renderer.render(this.scene, this.camera);
    } else {
      this.drawFlat(dt);
    }
  };
}
