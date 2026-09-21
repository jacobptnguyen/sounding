// The living light on the water: one fullscreen fragment shader drawing
// caustics and god rays over the depth plates.
//
// This replaces what used to be a radial gradient pushed through an animated
// SVG feTurbulence filter. That faked moving light by distorting a flat colour
// layer, which is both expensive (a displacement primitive rasterizes per-pixel
// per-frame) and unconvincing on top of a photograph. Doing it in a shader is
// one GPU pass and looks like water.
//
// It deliberately does NOT render the plates themselves. The plates crossfade
// perfectly well as CSS layers with compositor-only opacity (see parallax.js),
// and pulling five 2560px textures into WebGL to reimplement that would cost
// ~56MB of VRAM to reproduce something that already works. This canvas is a
// transparent overlay, blended over them with `screen`.
//
// ponytail: procedural caustics, no displacement of the plate underneath.
// If the water should actually refract the photo, that needs the plates as
// textures in this shader — a much bigger change than it looks.

import { Renderer, Program, Mesh, Triangle } from "https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm";

const canvas = document.getElementById("water");

// Continuous fluid motion is a vestibular trigger, so under reduced motion the
// shader draws a single still frame instead of animating. parallax.js checks
// the same query, but it's a script-scoped const there and this is a module.
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const vertex = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uLight;   // how much sun reaches this depth (1 surface, 0 abyss)
  uniform vec2 uAspect;
  uniform vec3 uTint;

  // A ridge is brightest where the wave crosses zero, so summing a few
  // drifting gratings at incommensurate angles gives the branching filaments
  // real caustics make, without any texture lookup.
  float ridged(float v) { return 1.0 - abs(v); }

  float caustics(vec2 p, float t) {
    float a = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float ang = 0.7 + fi * 2.1;
      vec2 dir = vec2(cos(ang), sin(ang));
      a += ridged(sin(dot(p, dir) * (7.0 + fi * 4.3) + t * (0.4 + 0.13 * fi)));
    }
    return pow(a / 3.0, 6.0);
  }

  void main() {
    vec2 p = vUv * uAspect;

    // Two layers at different scales and drifts so the pattern never
    // visibly repeats or pulses in step with itself.
    float c = caustics(p, uTime) * 0.65 + caustics(p * 1.9 - 4.0, uTime * 0.7) * 0.35;

    // Caustics live near the surface and wash out with depth.
    c *= smoothstep(0.0, 0.45, uLight);

    // Shafts of light fanning down from above, fading out before mid-screen.
    float shafts = ridged(sin(p.x * 3.1 - 0.35 + uTime * 0.05));
    shafts = pow(max(shafts, 0.0), 14.0) * smoothstep(0.85, 0.05, vUv.y) * uLight * 0.5;

    // Everything fades toward the bottom of frame: light comes from up there.
    float depthFade = smoothstep(1.0, 0.15, vUv.y);
    float amount = (c * 0.5 + shafts) * depthFade;

    gl_FragColor = vec4(uTint * amount, amount);
  }
`;

// No WebGL (old browser, blocklisted GPU, hardware acceleration off) is not an
// error worth throwing: the plates and the gradient below carry the scene on
// their own, so the page just goes without the moving light.
let renderer;
try {
  renderer = new Renderer({ canvas, alpha: true, dpr: Math.min(window.devicePixelRatio || 1, 2) });
} catch (err) {
  canvas.remove();
  throw new Error("water: no WebGL, falling back to the CSS plates");
}
const gl = renderer.gl;

const program = new Program(gl, {
  vertex,
  fragment,
  uniforms: {
    uTime: { value: 0 },
    uLight: { value: 1 },
    uAspect: { value: [1, 1] },
    uTint: { value: [0.72, 0.96, 1.0] },
  },
  transparent: true,
});
const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  const a = window.innerWidth / window.innerHeight;
  program.uniforms.uAspect.value = [a * 2.4, 2.4];
}
window.addEventListener("resize", resize);
resize();

// parallax.js owns the depth state and publishes it; this only reads.
const scene = window.oceanScene;

let verified = false;

function draw(t) {
  program.uniforms.uTime.value = t * 0.001;
  program.uniforms.uLight.value = scene ? scene.light : 1;
  renderer.render({ scene: mesh });

  // tsParticles "ran" in this project across two major versions without ever
  // painting a pixel, and nothing noticed. So confirm the first frame actually
  // wrote something. This has to happen here, immediately after render and
  // before the buffer is composited away — a readPixels from outside the loop
  // always comes back empty, which looks exactly like a dead shader.
  if (!verified) {
    verified = true;
    const w = Math.min(64, gl.drawingBufferWidth);
    const h = Math.min(64, gl.drawingBufferHeight);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(
      Math.floor((gl.drawingBufferWidth - w) / 2),
      Math.floor((gl.drawingBufferHeight - h) / 2),
      w, h, gl.RGBA, gl.UNSIGNED_BYTE, px
    );
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
    canvas.dataset.painting = lit > 0 ? "true" : "blank";
    if (!lit) console.warn("water: shader compiled but painted nothing");
  }
}

if (REDUCED_MOTION) {
  // Still frame, redrawn only when the depth changes.
  draw(0);
  window.addEventListener("resize", () => draw(0));
  window.oceanWaterRedraw = () => draw(0);
} else {
  requestAnimationFrame(function loop(t) {
    requestAnimationFrame(loop);
    draw(t);
  });
}
