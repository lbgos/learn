/// <reference path="./physics-sim.d.ts" />
// Angles in radians, length in metres, mass in kilograms, time in seconds.
let bob, rod, trail, caption;
export default defineSim({
  title: "Damped pendulum",
  view: "3d",
  params: {
    L: { value: 1, min: 0.1, max: 3, step: 0.01, unit: "m", label: "Length" },
    m: { value: 1, min: 0.1, max: 5, step: 0.1, unit: "kg", label: "Mass" },
    damping: { value: 0.08, min: 0, max: 1, step: 0.01, unit: "s⁻¹", label: "Damping" },
    theta0: { value: 0.6, min: -2.8, max: 2.8, step: 0.01, unit: "rad", label: "Initial angle" },
  },
  dt: 1 / 240,
  integrator: "rk4",
  init: (p) => ({ theta: p.theta0, omega: 0 }),
  derive: (s, p) => ({
    theta: s.omega,
    omega: (-9.81 / p.L) * Math.sin(s.theta) - p.damping * s.omega,
  }),
  setup: (kit, s, p) => {
    kit.camera.position.set(2.5, 1.2, 4);
    kit.controls.target.set(0, -p.L / 2, 0);
    kit.controls.update();
    kit.grid(8, 16).position.y = -3.1;
    kit.sphere(0.035, { color: "#888888" });
    bob = kit.sphere(0.1, { color: "#ffffff" });
    bob.name = "bob"; // probe readouts use object names
    rod = kit.rod([0, 0, 0], [0, -p.L, 0]);
    trail = kit.trail({ color: "#555555", maxPoints: 300 });
    caption = kit.label("", { position: [0, 0.35, 0], height: 0.16 });
  },
  render: (kit, s, p, t) => {
    const position = [p.L * Math.sin(s.theta), -p.L * Math.cos(s.theta), 0];
    bob.position.set(...position);
    rod.setEndpoints([0, 0, 0], position);
    // Rendering can repeat while paused; only add a trail point when time changes.
    if (trail.userData.lastTime !== t) {
      trail.push(position);
      trail.userData.lastTime = t;
    }
    caption.setText(`t = ${t.toFixed(2)} s   θ = ${s.theta.toFixed(2)} rad`);
  },
  observables: {
    "θ (rad)": (s) => s.theta,
    "ω (rad/s)": (s) => s.omega,
    "E (J)": (s, p) =>
      0.5 * p.m * (p.L * s.omega) ** 2 + p.m * 9.81 * p.L * (1 - Math.cos(s.theta)),
  },
  plots: [["θ (rad)"], ["E (J)"]],
});
