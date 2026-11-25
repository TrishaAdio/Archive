const VERTEX_SOURCE = "attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}";

const FRAGMENT_SOURCE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;
uniform float uFlow;
uniform float uIntensity;
uniform vec3 uPointer;
uniform vec3 uRipples[3];
uniform vec3 uBloom;

vec2 toScene(vec2 uv, float aspect) {
  return vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 scene = toScene(uv, aspect);
  float t = uTime * 0.16;

  vec2 pointer = toScene(uPointer.xy, aspect);
  vec2 toPointer = scene - pointer;
  float pull = exp(-dot(toPointer, toPointer) * 22.0) * uPointer.z;
  vec2 p = scene - toPointer * pull * 0.5;

  float ripple = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 drop = uRipples[i];
    float age = uTime - drop.z;
    if (age > 0.0 && age < 2.6) {
      vec2 away = scene - toScene(drop.xy, aspect);
      float dist = length(away);
      float ring = exp(-pow((dist - age * 0.55) * 11.0, 2.0)) * (1.0 - age / 2.6);
      ripple += ring;
      p += away / (dist + 0.0001) * ring * 0.06;
    }
  }

  p = p * 3.1 + vec2(0.0, uFlow * 3.1);
  for (int i = 1; i < 6; i++) {
    float fi = float(i);
    p.x += 0.62 / fi * sin(fi * p.y + t + 0.9 * fi) + 0.11;
    p.y += 0.48 / fi * cos(fi * p.x * 0.8 + t * 1.2 + 1.7 * fi) - 0.07;
  }

  float wave = sin(p.x * 1.15 + p.y * 0.55);
  float fold = 0.5 + 0.5 * wave;
  float body = smoothstep(0.05, 0.95, fold);
  float crest = pow(fold, 18.0);
  float glint = pow(fold, 60.0);
  float tone = 0.5 + 0.5 * sin(p.x * 0.42 - p.y * 0.31 + t * 0.6);
  float cool = 0.5 + 0.5 * sin(p.y * 0.37 + 2.0 - t * 0.4);

  vec3 ink = vec3(0.035, 0.027, 0.047);
  vec3 plum = vec3(0.24, 0.045, 0.2);
  vec3 wine = vec3(0.36, 0.05, 0.16);
  vec3 indigo = vec3(0.12, 0.08, 0.34);
  vec3 rose = vec3(1.0, 0.37, 0.58);
  vec3 peach = vec3(1.0, 0.7, 0.56);
  vec3 lagoon = vec3(0.5, 0.82, 0.92);

  vec3 cloth = mix(mix(plum, wine, tone), indigo, cool * 0.55);
  vec3 col = mix(ink, cloth, body * 0.62);
  col += mix(rose, peach, tone) * crest * 0.24;
  col += mix(vec3(1.0, 0.9, 0.94), lagoon, cool * 0.6) * glint * 0.16;

  float vignette = 1.0 - smoothstep(0.25, 0.9, length((uv - 0.5) * vec2(1.0, 1.15)));
  col = ink + (col - ink) * uIntensity * mix(0.42, 1.0, vignette);

  col += mix(rose, peach, 0.4) * (pull * 0.16 + ripple * 0.14);

  if (uBloom.z > 0.0) {
    vec2 away = scene - toScene(uBloom.xy, aspect);
    float dist2 = dot(away, away);
    col += mix(rose, vec3(1.0, 0.86, 0.92), 0.3) * uBloom.z * (exp(-dist2 * 3.0) * 0.8 + 0.1);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const RIPPLE_SLOTS = 3;
const IDLE_FRAME_MS = 1000 / 30;
const noop = { bloom() {}, settle() {}, ripple() {}, active: false };

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return program;
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function startSilk({ intensity = 1, flowRate = 0.12 } = {}) {
  if (typeof window === "undefined" || document.querySelector("canvas.silk")) return noop;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const downscale = (navigator.hardwareConcurrency ?? 4) <= 4 ? 7 : 5;

  const canvas = document.createElement("canvas");
  canvas.className = "silk";
  canvas.setAttribute("aria-hidden", "true");

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) return noop;

  const program = buildProgram(gl);
  if (!program) return noop;

  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const u = {
    res: uniform("uRes"),
    time: uniform("uTime"),
    flow: uniform("uFlow"),
    intensity: uniform("uIntensity"),
    pointer: uniform("uPointer"),
    ripples: uniform("uRipples[0]"),
    bloom: uniform("uBloom"),
  };

  const startedAt = performance.now();
  const seconds = (now = performance.now()) => (now - startedAt) / 1000;
  const pointer = { x: 0.5, y: 0.6, tx: 0.5, ty: 0.6, glow: 0, down: false, movedAt: -1e9 };
  const ripples = new Float32Array(RIPPLE_SLOTS * 3).fill(-100);
  let rippleSlot = 0;
  const bloom = { x: 0.5, y: 0.7, from: 0, to: 0, startedAt: 0, duration: 1, value: 0 };
  const scroll = { current: 0, target: 0 };

  let frameHandle = 0;
  let lastFrame = 0;
  let lastDraw = 0;
  let running = false;
  let alive = true;

  function resize() {
    const width = Math.max(48, Math.round(window.innerWidth / downscale));
    const height = Math.max(48, Math.round(window.innerHeight / downscale));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    return true;
  }

  function draw(now) {
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, reduced ? 24 : seconds(now));
    gl.uniform1f(u.flow, scroll.current);
    gl.uniform1f(u.intensity, intensity);
    gl.uniform3f(u.pointer, pointer.x, pointer.y, pointer.glow);
    gl.uniform3fv(u.ripples, ripples);
    gl.uniform3f(u.bloom, bloom.x, bloom.y, bloom.value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function ripplesLive(time) {
    for (let index = 0; index < RIPPLE_SLOTS; index++) {
      if (time - ripples[index * 3 + 2] < 2.6) return true;
    }
    return false;
  }

  function step(now) {
    if (!running) return;
    frameHandle = requestAnimationFrame(step);

    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    const time = seconds(now);

    const glowTarget = pointer.down ? 1 : now - pointer.movedAt < 900 ? (finePointer ? 0.55 : 0.75) : 0;
    const follow = 1 - Math.exp(-dt * 5.5);
    pointer.x += (pointer.tx - pointer.x) * follow;
    pointer.y += (pointer.ty - pointer.y) * follow;
    pointer.glow += (glowTarget - pointer.glow) * (1 - Math.exp(-dt * (glowTarget > pointer.glow ? 7 : 1.6)));
    scroll.current += (scroll.target - scroll.current) * (1 - Math.exp(-dt * 4));

    if (bloom.duration > 0) {
      const progress = Math.min(1, (now - bloom.startedAt) / bloom.duration);
      bloom.value = bloom.from + (bloom.to - bloom.from) * easeOutCubic(progress);
    }

    const busy =
      pointer.glow > 0.01 ||
      ripplesLive(time) ||
      Math.abs(scroll.target - scroll.current) > 0.0005 ||
      (bloom.duration > 0 && now - bloom.startedAt < bloom.duration);

    if (!busy && now - lastDraw < IDLE_FRAME_MS - 2) return;
    lastDraw = now;
    draw(now);
  }

  function start() {
    if (running || !alive || reduced) return;
    running = true;
    lastFrame = performance.now();
    frameHandle = requestAnimationFrame(step);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frameHandle);
  }

  function toUv(clientX, clientY) {
    return [clientX / window.innerWidth, 1 - clientY / window.innerHeight];
  }

  function addRipple(clientX, clientY) {
    if (reduced || !alive) return;
    const [x, y] = toUv(clientX, clientY);
    ripples[rippleSlot * 3] = x;
    ripples[rippleSlot * 3 + 1] = y;
    ripples[rippleSlot * 3 + 2] = seconds();
    rippleSlot = (rippleSlot + 1) % RIPPLE_SLOTS;
  }

  function setBloom(clientX, clientY, from, to, duration) {
    const [x, y] = toUv(clientX, clientY);
    Object.assign(bloom, { x, y, from, to, duration, startedAt: performance.now(), value: from });
    if (reduced) {
      bloom.value = to;
      draw(performance.now());
    }
  }

  if (!reduced) {
    const track = (event) => {
      const [x, y] = toUv(event.clientX, event.clientY);
      pointer.tx = x;
      pointer.ty = y;
    };
    window.addEventListener(
      "pointerdown",
      (event) => {
        track(event);
        if (pointer.glow < 0.05) {
          pointer.x = pointer.tx;
          pointer.y = pointer.ty;
        }
        pointer.down = true;
        pointer.movedAt = performance.now();
        addRipple(event.clientX, event.clientY);
      },
      { passive: true },
    );
    window.addEventListener(
      "pointermove",
      (event) => {
        track(event);
        pointer.movedAt = performance.now();
      },
      { passive: true },
    );
    const release = () => {
      pointer.down = false;
      pointer.movedAt = performance.now();
    };
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener(
      "scroll",
      () => {
        scroll.target = (window.scrollY / Math.max(1, window.innerHeight)) * flowRate;
      },
      { passive: true },
    );
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  }

  window.addEventListener("resize", () => {
    if (resize() && !running) draw(performance.now());
  });

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    alive = false;
    stop();
    canvas.remove();
    document.documentElement.classList.remove("has-silk");
  });

  resize();
  document.body.prepend(canvas);
  draw(performance.now());
  document.documentElement.classList.add("has-silk");
  requestAnimationFrame(() => canvas.classList.add("is-on"));
  start();

  return {
    active: true,
    ripple: addRipple,
    bloom(clientX, clientY, { duration = 1600 } = {}) {
      setBloom(clientX, clientY, bloom.value, 1, duration);
    },
    settle(clientX, clientY, { duration = 2200 } = {}) {
      setBloom(clientX, clientY, 1, 0, duration);
    },
  };
}

export { startSilk };
