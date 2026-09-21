// The ocean scene: one full-screen body of water whose depth, light, particles
// and parallax are driven from here. app.js decides *when* to dive; this file
// decides what diving looks like.

// ponytail: checks prefers-reduced-motion once at load rather than live-watching
// the media query; a mid-session OS toggle needs a reload to apply.
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Water colour per dive. Purely atmospheric: it tracks how many finds deep
// you are, not where the creature actually lives, so it's never labelled
// with real ocean zones or metres. Index 0 is the surface.
// `plates` is the opacity of each generated plate (zone 0, 2 and 4) at this
// depth. They stack rather than swap: each plate fades in over the one below,
// so there is never a frame where a half-faded plate lets the gradient show
// through. Scrolling between two zones lerps these, which is the crossfade.
const DEPTH_ZONES = [
  { bgStart: "#2393ae", bgEnd: "#0d5a73", accent: "#d4f6ff", rays: 1, plates: [1, 0, 0, 0, 0] },
  { bgStart: "#0d5a73", bgEnd: "#062331", accent: "#7fd6e8", rays: 0.8, plates: [1, 1, 0, 0, 0] },
  { bgStart: "#062331", bgEnd: "#03141d", accent: "#6fb8d6", rays: 0.35, plates: [1, 1, 1, 0, 0] },
  { bgStart: "#03141d", bgEnd: "#010a0f", accent: "#8aa6cc", rays: 0.1, plates: [1, 1, 1, 1, 0] },
  { bgStart: "#010a0f", bgEnd: "#000000", accent: "#7d93b8", rays: 0, plates: [1, 1, 1, 1, 1] },
];


// Particle character per zone: brisk, bright bubbles near the surface fade
// into slow, dim, twinkling marine snow by the abyss.
const PARTICLE_ZONES = [
  { count: 30, size: [2, 9], speed: [0.7, 2.4], opacity: 0.75, twinkle: 0 },
  { count: 26, size: [2, 9], speed: [0.6, 2.2], opacity: 0.7, twinkle: 0 },
  { count: 20, size: [1.5, 6], speed: [0.4, 1.4], opacity: 0.55, twinkle: 0 },
  { count: 14, size: [1, 3], speed: [0.2, 0.7], opacity: 0.4, twinkle: 1 },
  { count: 9, size: [0.6, 2], speed: [0.1, 0.35], opacity: 0.32, twinkle: 1 },
];

const PARTICLE_COLORS = ["#eaffff", "#bdeaf2", "#7fd6e8", "#dff9ff"];
const POOL_SIZE = Math.max(...PARTICLE_ZONES.map((z) => z.count));

const root = document.documentElement;
const plateEls = [...document.querySelectorAll(".ocean-plate")];
const readoutEl = document.getElementById("zone-readout");
const canvas = document.getElementById("particles");
const ctx = canvas.getContext("2d");

// Everything the particle loop reads each frame. GSAP tweens these numbers,
// so a depth change or a rush is just a tween on a plain object.
const scene = {
  count: 0,
  sizeMin: 1,
  sizeMax: 1,
  speedMin: 0,
  speedMax: 0,
  opacity: 0,
  twinkle: 0,
  rush: 0,
  light: 1,
};

// water.js is an ES module and can't see this file's script-scoped bindings.
window.oceanScene = scene;

let viewW = 0;
let viewH = 0;
const pool = [];
const bursts = [];

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = viewW * dpr;
  canvas.height = viewH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedPool() {
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push({
      x: Math.random() * viewW,
      y: Math.random() * viewH,
      sizeSeed: Math.random(),
      speedSeed: Math.random(),
      opacitySeed: Math.random(),
      wobble: 3 + Math.random() * 6,
      wobbleSpeed: 0.008 + Math.random() * 0.02,
      phase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.5 + Math.random(),
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
    });
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Rising bubbles / drifting plankton, hand-rolled on <canvas>.
//
// tsParticles (v3 and v4) was tried here first, but in testing it never
// painted a pixel: only clearRect ever ran, in headless and headful Chromium,
// on both major versions. This small loop was verified to actually paint.
function tick(time) {
  ctx.clearRect(0, 0, viewW, viewH);
  const margin = 20;

  for (let i = 0; i < pool.length; i++) {
    const presence = Math.min(1, Math.max(0, scene.count - i));
    if (presence === 0) continue;
    const p = pool[i];
    const drift = lerp(scene.speedMin, scene.speedMax, p.speedSeed);
    const rush = scene.rush * (0.6 + p.speedSeed);
    p.y -= drift + rush;
    p.phase += p.wobbleSpeed;
    if (p.y < -margin) {
      p.y = viewH + margin;
      p.x = Math.random() * viewW;
    } else if (p.y > viewH + margin) {
      p.y = -margin;
      p.x = Math.random() * viewW;
    }

    const r = lerp(scene.sizeMin, scene.sizeMax, p.sizeSeed);
    const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(time * 0.001 * p.twinkleSpeed + p.phase));
    const alpha = scene.opacity * (0.4 + 0.6 * p.opacitySeed) * lerp(1, twinkle, scene.twinkle) * presence;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    // Stretch along the direction of travel while rushing: reads as speed.
    ctx.ellipse(p.x + Math.sin(p.phase) * p.wobble, p.y, r, r + Math.abs(rush) * 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.x += b.vx;
    b.y += b.vy;
    b.vy *= 0.985;
    b.life -= 0.012;
    if (b.life <= 0) {
      bursts.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = b.life * 0.8;
    ctx.fillStyle = "#eaffff";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(tick);
}

// Bubbles shaken loose where the search bar breaks the water.
function emitBurst(x, y, width) {
  if (REDUCED_MOTION) return;
  for (let i = 0; i < 22; i++) {
    bursts.push({
      x: x + (Math.random() - 0.5) * width * 0.8,
      y: y + Math.random() * 12,
      vx: (Math.random() - 0.5) * 0.6,
      vy: -(2 + Math.random() * 4),
      r: 1.5 + Math.random() * 3,
      life: 0.7 + Math.random() * 0.3,
    });
  }
}

function applyZone(index, duration, ease) {
  const zone = DEPTH_ZONES[index];
  const particles = PARTICLE_ZONES[index];
  const vars = {
    "--zone-bg-start": zone.bgStart,
    "--zone-bg-end": zone.bgEnd,
    "--zone-accent": zone.accent,
    "--zone-rays-opacity": zone.rays,
  };
  zone.plates.forEach((o, i) => (vars[`--plate-${i}-opacity`] = o));
  const params = {
    count: particles.count,
    sizeMin: particles.size[0],
    sizeMax: particles.size[1],
    speedMin: particles.speed[0],
    speedMax: particles.speed[1],
    opacity: particles.opacity,
    twinkle: particles.twinkle,
    light: zone.rays,
  };
  if (duration === 0) {
    gsap.set(root, vars);
    Object.assign(scene, params);
    return;
  }
  gsap.to(root, { ...vars, duration, ease, overwrite: "auto" });
  gsap.to(scene, { ...params, duration, ease, overwrite: "auto" });
}

const PARTICLE_KEYS = "count,sizeMin,sizeMax,speedMin,speedMax,opacity,twinkle,light";

// Scroll-linked depth: z is a fractional zone index (e.g. 1.4 = 40% of the
// way from zone 1 to zone 2), so colour and particles blend continuously
// with the scroll position instead of switching per animal.
function applyDepthAt(z) {
  const lo = Math.floor(z);
  const hi = Math.min(lo + 1, DEPTH_ZONES.length - 1);
  const t = z - lo;
  const a = DEPTH_ZONES[lo];
  const b = DEPTH_ZONES[hi];
  const pa = PARTICLE_ZONES[lo];
  const pb = PARTICLE_ZONES[hi];
  const mix = gsap.utils.interpolate;

  gsap.killTweensOf(root);
  gsap.killTweensOf(scene, PARTICLE_KEYS);
  const vars = {
    "--zone-bg-start": mix(a.bgStart, b.bgStart, t),
    "--zone-bg-end": mix(a.bgEnd, b.bgEnd, t),
    "--zone-accent": mix(a.accent, b.accent, t),
    "--zone-rays-opacity": lerp(a.rays, b.rays, t),
  };
  a.plates.forEach((o, i) => (vars[`--plate-${i}-opacity`] = lerp(o, b.plates[i], t)));
  gsap.set(root, vars);
  Object.assign(scene, {
    count: lerp(pa.count, pb.count, t),
    sizeMin: lerp(pa.size[0], pb.size[0], t),
    sizeMax: lerp(pa.size[1], pb.size[1], t),
    speedMin: lerp(pa.speed[0], pb.speed[0], t),
    speedMax: lerp(pa.speed[1], pb.speed[1], t),
    opacity: lerp(pa.opacity, pb.opacity, t),
    twinkle: lerp(pa.twinkle, pb.twinkle, t),
    light: lerp(a.rays, b.rays, t),
  });
}

// Scrolling down pushes bubbles up past you (and vice versa), in proportion
// to scroll speed, then they drift back to rest once scrolling stops.
let rushIdle = 0;
function scrollRush(deltaPx) {
  if (REDUCED_MOTION) return;
  gsap.to(scene, { rush: gsap.utils.clamp(-9, 9, deltaPx * 0.12), duration: 0.3, ease: "power3.out", overwrite: "auto" });
  clearTimeout(rushIdle);
  rushIdle = setTimeout(settle, 140);
}

function setDepth(index) {
  applyZone(index, REDUCED_MOTION ? 0.4 : 1.6, "expo.inOut");
}

function setReadout(text) {
  if (readoutEl.textContent === text) return;
  if (REDUCED_MOTION) {
    readoutEl.textContent = text;
    return;
  }
  gsap.to(readoutEl, {
    opacity: 0,
    y: -4,
    duration: 0.15,
    ease: "expo.out",
    overwrite: "auto",
    onComplete: () => {
      readoutEl.textContent = text;
      gsap.fromTo(readoutEl, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" });
    },
  });
}

// direction: 1 = descending (bubbles rush up past you), -1 = ascending.
function startDescent(direction) {
  if (REDUCED_MOTION) return;
  gsap.to(scene, { rush: 7 * direction, duration: 0.5, ease: "power2.in", overwrite: "auto" });
}

function settle() {
  if (REDUCED_MOTION) return;
  gsap.to(scene, { rush: 0, duration: 1.2, ease: "expo.out", overwrite: "auto" });
}

// Each layer drifts with the mouse by a different amount, so the water reads
// as having depth even when nothing else is moving. #stage is deliberately
// excluded: transforming a scroll container makes Chrome reset its scroll.
function initPointerParallax() {
  const layers = [
    ...plateEls.map((el) => [el, 5]),
    [canvas, 28],
  ].map(([el, amount]) => ({
    amount,
    x: gsap.quickTo(el, "x", { duration: 0.9, ease: "power3.out" }),
    y: gsap.quickTo(el, "y", { duration: 0.9, ease: "power3.out" }),
  }));

  window.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const nx = event.clientX / window.innerWidth - 0.5;
    const ny = event.clientY / window.innerHeight - 0.5;
    for (const layer of layers) {
      layer.x(nx * layer.amount * 2);
      layer.y(ny * layer.amount * 2);
    }
  });
}

// No lazy-loading of the deeper plates: the browser fetches every layer's
// background-image at load regardless of opacity, and all five AVIFs together
// are ~300KB (the four deep ones are 92KB of it), so deferring them would be
// machinery for nothing. Only zone 0, at 208KB, gets a <link rel=preload>.

// A still plate reads as a still photo. A very slow scale loop — compositor
// only, no repaint — is most of what sells it as water instead.
function driftPlates() {
  plateEls.forEach((el, i) => {
    gsap.to(el, {
      scale: 1.08,
      duration: 34 + i * 7,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
  });
}

// The caustic SVG filter's <animate> runs globally (one shared <filter>
// in index.html) so it's paused once here.
(function initOcean() {
  applyZone(0, 0);
  readoutEl.textContent = "Surface";

  if (REDUCED_MOTION) {
    const svg = document.querySelector("svg.visually-hidden");
    if (svg && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
    return;
  }

  driftPlates();
  resizeCanvas();
  seedPool();
  window.addEventListener("resize", resizeCanvas);
  requestAnimationFrame(tick);
  initPointerParallax();
})();
