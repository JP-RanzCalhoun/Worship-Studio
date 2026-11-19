// Camera "looks": OBS-style 3D LUT colour grading on the GPU (WebGL2), baked into the preview and the recording.
//
// A look is a 3D lookup table (LUT): for every input colour, the output colour. Built-in looks are computed here
// from simple colour rules; any .cube file (the format OBS, Resolve and Premiere use) can be imported too.
// The camera picture is drawn through the LUT onto a canvas, and the canvas is the stream the app shows and records.

export interface Lut {
  size: number;
  /** size^3 RGB triples, red fastest (the .cube order), values 0..1 */
  data: Float32Array;
}

export type LookId = "none" | "clean" | "warm-film" | "night" | "teal-orange" | "soft-matte" | "bw" | `cube:${string}`;

export const BUILT_IN_LOOKS: { id: LookId; name: string; hint: string }[] = [
  { id: "none", name: "None", hint: "The camera's own picture" },
  { id: "clean", name: "Clean", hint: "A little more contrast and colour, nothing else" },
  { id: "warm-film", name: "Warm film", hint: "Soft blacks, warm highlights: cosy, filmic" },
  { id: "night", name: "Night", hint: "Deep blacks, slightly cool shadows, warm skin: moody evening" },
  { id: "teal-orange", name: "Teal & orange", hint: "Cinematic: teal shadows, warm skin" },
  { id: "soft-matte", name: "Soft matte", hint: "Faded blacks, gentle colour: calm and dreamy" },
  { id: "bw", name: "Black & white", hint: "Contrasty black and white" },
];

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** S-curve around the middle grey: amount 0 = straight line */
const sCurve = (x: number, amount: number) => clamp(x + amount * (x - 0.5) * (1 - Math.abs(2 * x - 1)));
const saturate = (r: number, g: number, b: number, s: number): [number, number, number] => {
  const l = luma(r, g, b);
  return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s];
};
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** The colour rule of each built-in look (input and output 0..1). */
function grade(id: LookId, r: number, g: number, b: number): [number, number, number] {
  switch (id) {
    case "clean": {
      [r, g, b] = saturate(r, g, b, 1.08);
      return [sCurve(r, 0.18), sCurve(g, 0.18), sCurve(b, 0.18)];
    }
    case "warm-film": {
      const l = luma(r, g, b);
      const hi = smooth(0.45, 1, l);
      [r, g, b] = saturate(r, g, b, 0.95);
      r += 0.035 * hi;
      g += 0.012 * hi;
      b -= 0.03 * hi;
      // lifted, slightly warm blacks; gentle roll-off
      const lift = (x: number, k: number) => 0.035 * k + x * (1 - 0.06);
      return [sCurve(clamp(lift(r, 1.1)), 0.15), sCurve(clamp(lift(g, 1)), 0.15), sCurve(clamp(lift(b, 0.8)), 0.15)];
    }
    case "night": {
      const l = luma(r, g, b);
      const sh = 1 - smooth(0, 0.45, l);
      const hi = smooth(0.5, 1, l);
      [r, g, b] = saturate(r, g, b, 0.92);
      r += -0.01 * sh + 0.03 * hi;
      g += 0.005 * sh + 0.01 * hi;
      b += 0.035 * sh - 0.025 * hi;
      // deeper blacks, contrast
      const deep = (x: number) => clamp((x - 0.025) / 0.975);
      return [sCurve(deep(r), 0.3), sCurve(deep(g), 0.3), sCurve(deep(b), 0.3)];
    }
    case "teal-orange": {
      const l = luma(r, g, b);
      const sh = 1 - smooth(0.1, 0.55, l);
      const hi = smooth(0.4, 0.95, l);
      [r, g, b] = saturate(r, g, b, 1.1);
      r += -0.04 * sh + 0.045 * hi;
      g += 0.015 * sh + 0.012 * hi;
      b += 0.05 * sh - 0.04 * hi;
      return [sCurve(clamp(r), 0.22), sCurve(clamp(g), 0.22), sCurve(clamp(b), 0.22)];
    }
    case "soft-matte": {
      [r, g, b] = saturate(r, g, b, 0.85);
      const m = (x: number) => 0.07 + x * 0.88;
      return [clamp(m(r) + 0.005), clamp(m(g)), clamp(m(b) + 0.01)];
    }
    case "bw": {
      const l = sCurve(luma(r, g, b), 0.35);
      return [l, l, l];
    }
    default:
      return [r, g, b];
  }
}

/** A built-in look as a 33-point LUT. */
/**
 * Colour fix from one frame (RGBA bytes): gains that make the average of the mid-tones neutral grey ("grey world"),
 * ignoring blown highlights and deep shadows (lamps, black clothes). Kept within 0.75..1.35 and normalised so the
 * brightness stays the same.
 */
export function neutralGains(px: Uint8ClampedArray): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const mx = Math.max(px[i], px[i + 1], px[i + 2]),
      mn = Math.min(px[i], px[i + 1], px[i + 2]);
    if (mx > 235 || mn < 20) continue;
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
    n++;
  }
  if (n < 100) return [1, 1, 1];
  r /= n;
  g /= n;
  b /= n;
  const grey = (r + g + b) / 3;
  const lim = (x: number) => Math.min(1.35, Math.max(0.75, x));
  let gr = lim(grey / r),
    gg = lim(grey / g),
    gb = lim(grey / b);
  // keep the brightness: luma of the gains = 1
  const l = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
  gr /= l;
  gg /= l;
  gb /= l;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return [round(gr), round(gg), round(gb)];
}

export function builtInLut(id: LookId, size = 33): Lut {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = grade(id, ri / (size - 1), gi / (size - 1), bi / (size - 1));
        data[i++] = clamp(r);
        data[i++] = clamp(g);
        data[i++] = clamp(b);
      }
  return { size, data };
}

/** Reads a .cube file (Adobe/Resolve 3D LUT). Throws a readable message when it is not one. */
export function parseCube(text: string): Lut {
  let size = 0;
  let min = [0, 0, 0],
    max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") size = parseInt(parts[1], 10);
    else if (key === "LUT_1D_SIZE") throw new Error("This is a 1D LUT. Use a 3D .cube LUT.");
    else if (key === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number);
    else if (key === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number);
    else if (key === "TITLE" || /^[A-Z_]+$/.test(key)) continue;
    else if (parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || size < 2 || size > 128) throw new Error("Not a 3D .cube LUT (no LUT_3D_SIZE).");
  if (values.length !== size * size * size * 3)
    throw new Error(`The LUT should have ${size ** 3} colours but has ${values.length / 3}.`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = clamp((values[i] - min[c]) / (max[c] - min[c] || 1));
  }
  return { size, data };
}

// ---------- imported .cube files (kept in IndexedDB: they can be several MB) ----------

const DB = "wsa-looks";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("cubes");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveCube(name: string, text: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction("cubes", "readwrite");
    t.objectStore("cubes").put(text, name);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function listCubes(): Promise<string[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("cubes").objectStore("cubes").getAllKeys();
    r.onsuccess = () => resolve((r.result as IDBValidKey[]).map(String).sort());
    r.onerror = () => reject(r.error);
  });
}
export async function loadCube(name: string): Promise<string | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("cubes").objectStore("cubes").get(name);
    r.onsuccess = () => resolve((r.result as string) ?? null);
    r.onerror = () => reject(r.error);
  });
}
export async function removeCube(name: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction("cubes", "readwrite");
    t.objectStore("cubes").delete(name);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---------- the GPU pipeline ----------

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D cam;
uniform sampler3D lut;
uniform float size;
uniform float strength;
uniform vec3 gain;
in vec2 uv;
out vec4 o;
void main() {
  vec3 c = clamp(texture(cam, uv).rgb * gain, 0.0, 1.0); // colour fix first (removes a cast), then the look
  vec3 g = texture(lut, c * ((size - 1.0) / size) + 0.5 / size).rgb;
  o = vec4(mix(c, g, strength), 1.0);
}`;

/**
 * Draws a camera stream through a 3D LUT onto a canvas, every camera frame, and gives the canvas as a stream
 * (same size and frame rate as the camera). Call stop() when done.
 */
export class LookProcessor {
  readonly stream: MediaStream;
  private video = document.createElement("video");
  private canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private camTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private lutSize = 2;
  private strength = 1;
  private gains: [number, number, number] = [1, 1, 1];
  private alive = true;
  private frameHandle = 0;

  constructor(source: MediaStream, fps: number) {
    const st = source.getVideoTracks()[0]?.getSettings() ?? {};
    this.canvas.width = st.width ?? 1920;
    this.canvas.height = st.height ?? 1080;
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false, desynchronized: true });
    if (!gl) throw new Error("This PC cannot run camera looks (no WebGL2).");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Look shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("Look shader: " + gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.camTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(gl.getUniformLocation(prog, "cam"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "lut"), 1);
    this.setLut(builtInLut("none", 2));

    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = source;
    this.video.play().catch(() => {});
    this.stream = this.canvas.captureStream(fps);
    const draw = () => {
      if (!this.alive) return;
      this.render();
      this.frameHandle = this.video.requestVideoFrameCallback(draw);
    };
    this.frameHandle = this.video.requestVideoFrameCallback(draw);
  }

  setLut(lut: Lut) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    this.lutSize = lut.size;
  }

  /** Per-colour gains before the look (a colour fix for the room light). */
  setGains(g: [number, number, number]) {
    this.gains = g;
  }

  setStrength(s: number) {
    this.strength = Math.min(1, Math.max(0, s));
  }

  private render() {
    const gl = this.gl;
    const w = this.video.videoWidth,
      h = this.video.videoHeight;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
    gl.uniform1f(gl.getUniformLocation(this.prog, "size"), this.lutSize);
    gl.uniform1f(gl.getUniformLocation(this.prog, "strength"), this.strength);
    gl.uniform3f(gl.getUniformLocation(this.prog, "gain"), this.gains[0], this.gains[1], this.gains[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  stop() {
    this.alive = false;
    this.video.cancelVideoFrameCallback(this.frameHandle);
    this.stream.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
