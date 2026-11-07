import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SimKit, SimLabel, SimPoint, SimSegment, SimTrail } from "./types.ts";

export function createKit(
  renderer: THREE.WebGLRenderer,
  view: "3d" | "2d",
  invalidate: () => void,
): SimKit {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#000000");
  const camera =
    view === "2d"
      ? new THREE.OrthographicCamera(-3, 3, 3, -3, 0.01, 1000)
      : new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(view === "2d" ? 0 : 3, view === "2d" ? 0 : 2, 6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enableRotate = view === "3d";
  controls.addEventListener("change", invalidate);
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(3, 5, 4);
  scene.add(light);
  function add<T extends THREE.Object3D>(object: T, position?: SimPoint): T {
    if (position) object.position.fromArray(position);
    scene.add(object);
    return object;
  }
  function segment(
    update: (group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3) => void,
    from: SimPoint,
    to: SimPoint,
    position?: SimPoint,
  ): SimSegment {
    const group = Object.assign(new THREE.Group(), {
      setEndpoints: (a: SimPoint, b: SimPoint) =>
        update(group, new THREE.Vector3(...a), new THREE.Vector3(...b)),
    });
    group.setEndpoints(from, to);
    return add(group, position);
  }
  return {
    THREE,
    scene,
    camera,
    controls,
    sphere: (radius = 0.1, options = {}) =>
      add(
        new THREE.Mesh(
          new THREE.SphereGeometry(radius, 24, 16),
          new THREE.MeshStandardMaterial({ color: options.color ?? "white" }),
        ),
        options.position,
      ),
    box: (size = [1, 1, 1], options = {}) =>
      add(
        new THREE.Mesh(
          new THREE.BoxGeometry(...size),
          new THREE.MeshStandardMaterial({ color: options.color ?? "white" }),
        ),
        options.position,
      ),
    rod: (from, to, options = {}) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(options.radius ?? 0.015, options.radius ?? 0.015, 1, 12),
        new THREE.MeshStandardMaterial({ color: options.color ?? "#999999" }),
      );
      return segment(
        (group, a, b) => {
          if (!mesh.parent) group.add(mesh);
          const delta = b.clone().sub(a);
          mesh.position.copy(a).add(b).multiplyScalar(0.5);
          mesh.scale.y = delta.length();
          if (delta.lengthSq())
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
        },
        from,
        to,
        options.position,
      );
    },
    spring: (from, to, options = {}) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: options.color ?? "#aaaaaa" }),
      );
      return segment(
        (group, a, b) => {
          if (!line.parent) group.add(line);
          const axis = b.clone().sub(a);
          const u = axis
            .clone()
            .normalize()
            .cross(new THREE.Vector3(0, 0, 1));
          if (u.lengthSq() < 0.001)
            u.copy(axis)
              .normalize()
              .cross(new THREE.Vector3(0, 1, 0));
          u.normalize();
          const v = axis.clone().normalize().cross(u);
          const turns = options.turns ?? 10;
          const count = Math.max(32, Math.min(2048, Math.ceil(turns * 16)));
          const points = Array.from({ length: count + 1 }, (_, i) => {
            const f = i / count;
            const radius = (options.radius ?? 0.05) * Math.sin(Math.PI * f);
            return a
              .clone()
              .addScaledVector(axis, f)
              .addScaledVector(u, radius * Math.cos(f * turns * Math.PI * 2))
              .addScaledVector(v, radius * Math.sin(f * turns * Math.PI * 2));
          });
          line.geometry.dispose();
          line.geometry = new THREE.BufferGeometry().setFromPoints(points);
        },
        from,
        to,
        options.position,
      );
    },
    arrow: (from, to, options = {}) => {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        1,
        options.color ?? "white",
      );
      return segment(
        (group, a, b) => {
          if (!arrow.parent) group.add(arrow);
          const delta = b.clone().sub(a);
          arrow.position.copy(a);
          const length = delta.length();
          arrow.visible = length > 0;
          if (length) {
            arrow.setDirection(delta.normalize());
            arrow.setLength(length, Math.min(length / 4, 0.15), Math.min(length / 8, 0.08));
          }
        },
        from,
        to,
        options.position,
      );
    },
    trail: (options = {}) => {
      const points: THREE.Vector3[] = [];
      const line = Object.assign(
        new THREE.Line(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: options.color ?? "#888888" }),
        ),
        {
          push: (point: SimPoint) => {
            points.push(new THREE.Vector3(...point));
            if (points.length > (options.maxPoints ?? 500)) points.shift();
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry().setFromPoints(points);
          },
          clearPoints: () => {
            points.length = 0;
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry();
          },
        },
      ) satisfies SimTrail;
      return add(line, options.position);
    },
    grid: (size = 10, divisions = 20) => {
      const grid = new THREE.GridHelper(size, divisions, "#777777", "#333333");
      if (view === "2d") grid.rotation.x = Math.PI / 2;
      return add(grid);
    },
    label: (text, options = {}) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const material = new THREE.SpriteMaterial({ transparent: true, depthTest: false });
      let previousText: string | undefined;
      const sprite = Object.assign(new THREE.Sprite(material), {
        setText: (value: string) => {
          if (previousText === value) return;
          previousText = value;
          ctx.font = "28px sans-serif";
          canvas.width = Math.max(1, Math.ceil(ctx.measureText(value).width) + 16);
          canvas.height = 48;
          ctx.font = "28px sans-serif";
          ctx.fillStyle = typeof options.color === "string" ? options.color : "white";
          ctx.textBaseline = "middle";
          ctx.fillText(value, 8, 24);
          material.map?.dispose();
          material.map = new THREE.CanvasTexture(canvas);
          material.needsUpdate = true;
          const height = options.height ?? 0.18;
          sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
        },
      }) satisfies SimLabel;
      sprite.setText(text);
      return add(sprite, options.position);
    },
  };
}

export function disposeKit(kit: SimKit): void {
  kit.controls.dispose();
  kit.scene.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Sprite
    ) {
      if ("geometry" in object) object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if ("map" in material && material.map instanceof THREE.Texture) material.map.dispose();
        material.dispose();
      }
    }
  });
  kit.scene.clear();
}
