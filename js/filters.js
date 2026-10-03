'use strict';

/* FilterLab — filters.js
 *
 * Every effect is classic per-pixel image processing on raw RGBA data.
 * Each filter: { name, params: [...], apply(src, params, scale) -> ImageData }
 * `scale` converts pixel-based params from preview resolution to full
 * export resolution so the export matches what the preview shows.
 */

function clampN(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

// Deterministic 2D hash -> [0,1). Deterministic (unlike Math.random) so the
// image doesn't shimmer between re-renders while dragging sliders.
function hash2(x, y){
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function hexToRgb(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a, b, t){ return a + (b - a) * t; }

function copyOf(src){
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

// Bayer threshold matrix of size 2/4/8, values normalized to (0,1).
function bayerMatrix(size){
  let m = [[0]], n = 1;
  while (n < size){
    const next = Array.from({ length: n * 2 }, () => new Array(n * 2));
    for (let y = 0; y < n; y++){
      for (let x = 0; x < n; x++){
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next; n *= 2;
  }
  return m.map(row => row.map(v => (v + 0.5) / (n * n)));
}

// Smooth value noise in [0,1): bilinear interpolation over a hash lattice.
function valueNoise(x, y, seed){
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi + seed, yi), b = hash2(xi + 1 + seed, yi);
  const c = hash2(xi + seed, yi + 1), d = hash2(xi + 1 + seed, yi + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/* ------------------------------------------------------------------ */

const GRADIENT_PRESETS = {
  'Noir':    ['#050505', '#808080', '#fafafa'],
  'Sepia':   ['#241505', '#96693b', '#f5e7c9'],
  'Sunset':  ['#2b124c', '#e85a71', '#ffd97d'],
  'Ocean':   ['#03045e', '#0096c7', '#caf0f8'],
  'Neon':    ['#0d0221', '#f72585', '#c7f9ff'],
  'Emerald': ['#04150d', '#0e9f6e', '#d1fae5'],
};

const FILTERS = {

  /* Privacy / patterned glass: the image is divided into a grid of small
     "lenses". Each output pixel samples the source displaced toward the
     edge of its cell (refraction), plus a per-cell random offset. */
  glass: {
    name: 'Privacy Glass',
    params: [
      { type: 'range', key: 'cellSize', label: 'Cell size',    min: 4, max: 100, step: 1, value: 18 },
      { type: 'range', key: 'strength', label: 'Distortion',   min: 0, max: 100, step: 1, value: 55 },
      { type: 'range', key: 'jitter',   label: 'Irregularity', min: 0, max: 100, step: 1, value: 30 },
      { type: 'range', key: 'frost',    label: 'Frost',        min: 0, max: 100, step: 1, value: 15 },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const cs = Math.max(2, Math.round(p.cellSize * scale));
      const bend = (p.strength / 100) * cs * 0.9;
      const jit = (p.jitter / 100) * cs * 0.8;
      const frost = (p.frost / 100) * 6 * scale;
      for (let y = 0; y < h; y++){
        const cy = (y / cs) | 0;
        const v = (y - cy * cs) / cs - 0.5;
        for (let x = 0; x < w; x++){
          const cx = (x / cs) | 0;
          const u = (x - cx * cs) / cs - 0.5;
          let sx = x + u * 2 * bend + (hash2(cx, cy) - 0.5) * 2 * jit;
          let sy = y + v * 2 * bend + (hash2(cx + 9173, cy + 3717) - 0.5) * 2 * jit;
          if (frost > 0){
            sx += (hash2(x, y * 2 + 1) - 0.5) * frost;
            sy += (hash2(x * 2 + 1, y) - 0.5) * frost;
          }
          const ix = clampN(Math.round(sx), 0, w - 1);
          const iy = clampN(Math.round(sy), 0, h - 1);
          const si = (iy * w + ix) * 4, di = (y * w + x) * 4;
          o[di] = d[si]; o[di + 1] = d[si + 1]; o[di + 2] = d[si + 2]; o[di + 3] = d[si + 3];
        }
      }
      return out;
    },
  },

  /* Retro pixelation: block-average downsampling + color quantization,
     with a saturation control for that punchy 16-bit palette look. */
  pixelate: {
    name: 'Pixel Art',
    params: [
      { type: 'range', key: 'pixelSize',  label: 'Pixel size', min: 2, max: 64,  step: 1, value: 10 },
      { type: 'range', key: 'colors',     label: 'Color depth', min: 2, max: 32, step: 1, value: 16 },
      { type: 'range', key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, value: 110 },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const ps = Math.max(1, Math.round(p.pixelSize * scale));
      const levels = Math.round(p.colors);
      const sat = p.saturation / 100;
      const q = v => Math.round(v / 255 * (levels - 1)) / (levels - 1) * 255;
      for (let by = 0; by < h; by += ps){
        const bh = Math.min(ps, h - by);
        for (let bx = 0; bx < w; bx += ps){
          const bw = Math.min(ps, w - bx);
          let r = 0, g = 0, b = 0, a = 0;
          const n = bw * bh;
          for (let y = 0; y < bh; y++){
            let i = ((by + y) * w + bx) * 4;
            for (let x = 0; x < bw; x++, i += 4){
              r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3];
            }
          }
          r /= n; g /= n; b /= n; a /= n;
          const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = q(clampN(gray + (r - gray) * sat, 0, 255));
          g = q(clampN(gray + (g - gray) * sat, 0, 255));
          b = q(clampN(gray + (b - gray) * sat, 0, 255));
          for (let y = 0; y < bh; y++){
            let i = ((by + y) * w + bx) * 4;
            for (let x = 0; x < bw; x++, i += 4){
              o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = a;
            }
          }
        }
      }
      return out;
    },
  },

  /* Film grain: deterministic noise added per pixel (or per noise block
     when size > 1), monochrome or per-channel colored. */
  grain: {
    name: 'Grain',
    params: [
      { type: 'range',    key: 'intensity', label: 'Intensity',  min: 0, max: 100, step: 1, value: 25 },
      { type: 'range',    key: 'size',      label: 'Grain size', min: 1, max: 6,   step: 1, value: 1 },
      { type: 'checkbox', key: 'colored',   label: 'Colored grain', value: false },
    ],
    apply(src, p, scale = 1){
      const out = copyOf(src);
      const w = out.width, h = out.height, d = out.data;
      const amt = (p.intensity / 100) * 110;
      const size = Math.max(1, Math.round(p.size * scale));
      for (let y = 0; y < h; y++){
        const ny = (y / size) | 0;
        for (let x = 0; x < w; x++){
          const nx = (x / size) | 0;
          const i = (y * w + x) * 4;
          if (p.colored){
            d[i]     += (hash2(nx, ny) - 0.5) * 2 * amt;
            d[i + 1] += (hash2(nx + 7331, ny) - 0.5) * 2 * amt;
            d[i + 2] += (hash2(nx, ny + 7331) - 0.5) * 2 * amt;
          } else {
            const nz = (hash2(nx, ny) - 0.5) * 2 * amt;
            d[i] += nz; d[i + 1] += nz; d[i + 2] += nz;
          }
        }
      }
      return out;
    },
  },

  /* Chromatic aberration: red and blue channels sampled at offset
     positions — radially away from a focus point, or in a fixed direction. */
  chroma: {
    name: 'Chromatic Aberration',
    params: [
      { type: 'select', key: 'mode',    label: 'Mode', options: ['Radial', 'Linear'], value: 'Radial' },
      { type: 'range',  key: 'amount',  label: 'Amount',    min: 0, max: 100, step: 1, value: 30 },
      { type: 'range',  key: 'centerX', label: 'Focus X %', min: 0, max: 100, step: 1, value: 50 },
      { type: 'range',  key: 'centerY', label: 'Focus Y %', min: 0, max: 100, step: 1, value: 50 },
      { type: 'range',  key: 'angle',   label: 'Angle (linear)', min: 0, max: 360, step: 1, value: 0 },
    ],
    apply(src, p){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const linear = p.mode === 'Linear';
      const cx = p.centerX / 100 * w, cy = p.centerY / 100 * h;
      const s = (p.amount / 100) * 0.06;
      const ang = p.angle * Math.PI / 180;
      const maxDim = Math.max(w, h);
      const lx = Math.cos(ang) * (p.amount / 100) * maxDim * 0.04;
      const ly = Math.sin(ang) * (p.amount / 100) * maxDim * 0.04;
      for (let y = 0; y < h; y++){
        for (let x = 0; x < w; x++){
          let rX, rY, bX, bY;
          if (linear){
            rX = x - lx; rY = y - ly; bX = x + lx; bY = y + ly;
          } else {
            const dx = x - cx, dy = y - cy;
            rX = x - dx * s; rY = y - dy * s;
            bX = x + dx * s; bY = y + dy * s;
          }
          const ri = (clampN(Math.round(rY), 0, h - 1) * w + clampN(Math.round(rX), 0, w - 1)) * 4;
          const bi = (clampN(Math.round(bY), 0, h - 1) * w + clampN(Math.round(bX), 0, w - 1)) * 4;
          const i = (y * w + x) * 4;
          o[i] = d[ri]; o[i + 1] = d[i + 1]; o[i + 2] = d[bi + 2]; o[i + 3] = d[i + 3];
        }
      }
      return out;
    },
  },

  /* Gradient map: pixel luminance indexes into a 3-stop gradient LUT.
     Editing any color switches the preset to Custom (handled by sync). */
  gradient: {
    name: 'Gradient Map',
    params: [
      { type: 'select', key: 'preset',    label: 'Preset', options: [...Object.keys(GRADIENT_PRESETS), 'Custom'], value: 'Noir' },
      { type: 'color',  key: 'shadow',    label: 'Shadows',    value: '#050505' },
      { type: 'color',  key: 'mid',       label: 'Midtones',   value: '#808080' },
      { type: 'color',  key: 'highlight', label: 'Highlights', value: '#fafafa' },
      { type: 'range',  key: 'mix',       label: 'Mix', min: 0, max: 100, step: 1, value: 100 },
    ],
    sync(p, changedKey){
      if (changedKey === 'preset'){
        const pr = GRADIENT_PRESETS[p.preset];
        if (pr){ p.shadow = pr[0]; p.mid = pr[1]; p.highlight = pr[2]; }
      } else if (changedKey === 'shadow' || changedKey === 'mid' || changedKey === 'highlight'){
        p.preset = 'Custom';
      }
    },
    apply(src, p){
      const c0 = hexToRgb(p.shadow), c1 = hexToRgb(p.mid), c2 = hexToRgb(p.highlight);
      const lut = new Uint8ClampedArray(256 * 3);
      for (let t = 0; t < 256; t++){
        const tt = t / 255;
        const [a, b, f] = tt <= 0.5 ? [c0, c1, tt * 2] : [c1, c2, (tt - 0.5) * 2];
        lut[t * 3]     = lerp(a[0], b[0], f);
        lut[t * 3 + 1] = lerp(a[1], b[1], f);
        lut[t * 3 + 2] = lerp(a[2], b[2], f);
      }
      const out = copyOf(src), d = out.data;
      const mix = p.mix / 100;
      for (let i = 0; i < d.length; i += 4){
        const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) | 0;
        d[i]     += (lut[lum * 3]     - d[i])     * mix;
        d[i + 1] += (lut[lum * 3 + 1] - d[i + 1]) * mix;
        d[i + 2] += (lut[lum * 3 + 2] - d[i + 2]) * mix;
      }
      return out;
    },
  },

  /* Print-style halftone: a rotated grid of dots whose radius follows
     the sampled luminance (sqrt for even tonal coverage). */
  halftone: {
    name: 'Halftone',
    params: [
      { type: 'range',    key: 'spacing', label: 'Dot spacing', min: 4, max: 24, step: 1, value: 8 },
      { type: 'range',    key: 'angle',   label: 'Angle',       min: 0, max: 90, step: 1, value: 45 },
      { type: 'checkbox', key: 'colored', label: 'Colored dots', value: true },
      { type: 'select',   key: 'paper',   label: 'Paper', options: ['White', 'Black'], value: 'White' },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const spacing = Math.max(3, p.spacing * scale);
      const ang = p.angle * Math.PI / 180;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const dark = p.paper === 'Black';
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = dark ? '#0b0b0d' : '#f7f5f1';
      ctx.fillRect(0, 0, w, h);
      const half = Math.ceil(Math.hypot(w, h) / 2 / spacing) + 1;
      const cxm = w / 2, cym = h / 2;
      for (let j = -half; j <= half; j++){
        for (let i = -half; i <= half; i++){
          const x = cxm + (i * cosA - j * sinA) * spacing;
          const y = cym + (i * sinA + j * cosA) * spacing;
          if (x < -spacing || x > w + spacing || y < -spacing || y > h + spacing) continue;
          const px = clampN(Math.round(x), 0, w - 1);
          const py = clampN(Math.round(y), 0, h - 1);
          const si = (py * w + px) * 4;
          const r = d[si], g = d[si + 1], b = d[si + 2];
          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const cov = dark ? lum : 1 - lum;
          const rad = spacing * 0.66 * Math.sqrt(cov);
          if (rad < 0.25) continue;
          ctx.fillStyle = p.colored ? `rgb(${r},${g},${b})` : (dark ? '#f2f2f2' : '#141414');
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, 6.2832);
          ctx.fill();
        }
      }
      return ctx.getImageData(0, 0, w, h);
    },
  },

  /* CRT-style scanlines: darken every Nth row. */
  scanlines: {
    name: 'Scanlines',
    params: [
      { type: 'range', key: 'spacing',   label: 'Spacing',   min: 2, max: 16,  step: 1, value: 4 },
      { type: 'range', key: 'thickness', label: 'Thickness', min: 1, max: 6,   step: 1, value: 1 },
      { type: 'range', key: 'strength',  label: 'Darkness',  min: 0, max: 100, step: 1, value: 40 },
    ],
    apply(src, p, scale = 1){
      const out = copyOf(src);
      const w = out.width, h = out.height, d = out.data;
      const spacing = Math.max(2, Math.round(p.spacing * scale));
      const thick = Math.min(spacing - 1, Math.max(1, Math.round(p.thickness * scale)));
      const mul = 1 - p.strength / 100;
      for (let y = 0; y < h; y++){
        if (y % spacing >= thick) continue;
        let i = y * w * 4;
        for (let x = 0; x < w; x++, i += 4){
          d[i] *= mul; d[i + 1] *= mul; d[i + 2] *= mul;
        }
      }
      return out;
    },
  },
  /* Ordered (Bayer) dithering: each pixel is quantized with a positional
     threshold from a Bayer matrix — the classic 1-bit / retro print look.
     Source is sampled at cell resolution for a chunky, even pattern. */
  dither: {
    name: 'Dither (Bayer)',
    params: [
      { type: 'select',   key: 'pattern', label: 'Pattern', options: ['2×2', '4×4', '8×8'], value: '4×4' },
      { type: 'range',    key: 'levels',  label: 'Levels',    min: 2, max: 8, step: 1, value: 2 },
      { type: 'range',    key: 'scale',   label: 'Dot scale', min: 1, max: 6, step: 1, value: 2 },
      { type: 'checkbox', key: 'mono',    label: 'Monochrome', value: false },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const size = { '2×2': 2, '4×4': 4, '8×8': 8 }[p.pattern];
      const m = bayerMatrix(size);
      const cell = Math.max(1, Math.round(p.scale * scale));
      const spread = 255 / (p.levels - 1);
      for (let y = 0; y < h; y++){
        const cy = ((y / cell) | 0);
        const sy = Math.min(h - 1, cy * cell);
        for (let x = 0; x < w; x++){
          const cx = ((x / cell) | 0);
          const sx = Math.min(w - 1, cx * cell);
          const t = m[cy % size][cx % size] - 0.5;
          const si = (sy * w + sx) * 4, i = (y * w + x) * 4;
          if (p.mono){
            const lum = 0.2126 * d[si] + 0.7152 * d[si + 1] + 0.0722 * d[si + 2];
            const q = clampN(Math.round((lum + t * spread) / spread) * spread, 0, 255);
            o[i] = o[i + 1] = o[i + 2] = q;
          } else {
            for (let c = 0; c < 3; c++){
              o[i + c] = clampN(Math.round((d[si + c] + t * spread) / spread) * spread, 0, 255);
            }
          }
          o[i + 3] = d[i + 3];
        }
      }
      return out;
    },
  },

  /* Posterize with outlines: quantize colors into flat bands, then run a
     Sobel edge detector on the result and draw the edges as ink lines. */
  posterize: {
    name: 'Posterize + Outline',
    params: [
      { type: 'range', key: 'levels',    label: 'Levels',    min: 2, max: 8,   step: 1, value: 4 },
      { type: 'range', key: 'outline',   label: 'Outline',   min: 0, max: 100, step: 1, value: 60 },
      { type: 'range', key: 'thickness', label: 'Thickness', min: 1, max: 4,   step: 1, value: 1 },
      { type: 'color', key: 'color',     label: 'Line color', value: '#141414' },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const levels = Math.round(p.levels);
      const spread = 255 / (levels - 1);
      const lum = new Float32Array(w * h);
      for (let j = 0; j < w * h; j++){
        const i = j * 4;
        const r = Math.round(d[i] / spread) * spread;
        const g = Math.round(d[i + 1] / spread) * spread;
        const b = Math.round(d[i + 2] / spread) * spread;
        o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = d[i + 3];
        lum[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      const strength = p.outline / 100;
      if (strength <= 0) return out;

      // Sobel on the posterized luminance so lines follow the flat bands
      let edge = new Uint8Array(w * h);
      const thr = spread * 0.45;
      for (let y = 1; y < h - 1; y++){
        for (let x = 1; x < w - 1; x++){
          const j = y * w + x;
          const gx = (lum[j - w + 1] + 2 * lum[j + 1] + lum[j + w + 1])
                   - (lum[j - w - 1] + 2 * lum[j - 1] + lum[j + w - 1]);
          const gy = (lum[j + w - 1] + 2 * lum[j + w] + lum[j + w + 1])
                   - (lum[j - w - 1] + 2 * lum[j - w] + lum[j - w + 1]);
          if (Math.abs(gx) + Math.abs(gy) > thr) edge[j] = 1;
        }
      }
      // separable box dilation to thicken lines
      const rad = Math.max(0, Math.round(p.thickness * scale) - 1);
      if (rad > 0){
        const tmp = new Uint8Array(w * h);
        for (let y = 0; y < h; y++){
          for (let x = 0; x < w; x++){
            let v = 0;
            for (let k = -rad; k <= rad && !v; k++){
              const xx = x + k;
              if (xx >= 0 && xx < w && edge[y * w + xx]) v = 1;
            }
            tmp[y * w + x] = v;
          }
        }
        const dil = new Uint8Array(w * h);
        for (let y = 0; y < h; y++){
          for (let x = 0; x < w; x++){
            let v = 0;
            for (let k = -rad; k <= rad && !v; k++){
              const yy = y + k;
              if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
            }
            dil[y * w + x] = v;
          }
        }
        edge = dil;
      }
      const [lr, lg, lb] = hexToRgb(p.color);
      for (let j = 0; j < w * h; j++){
        if (!edge[j]) continue;
        const i = j * 4;
        o[i]     += (lr - o[i])     * strength;
        o[i + 1] += (lg - o[i + 1]) * strength;
        o[i + 2] += (lb - o[i + 2]) * strength;
      }
      return out;
    },
  },

  /* Duotone print misregistration: the image becomes two ink plates
     (coverage = darkness) printed on colored paper with a multiplicative
     ink model, each plate shifted in opposite directions like a
     misaligned risograph print. */
  duotone: {
    name: 'Duotone Print',
    params: [
      { type: 'color', key: 'inkA',   label: 'Ink 1', value: '#1b2a6b' },
      { type: 'color', key: 'inkB',   label: 'Ink 2', value: '#e63946' },
      { type: 'color', key: 'paper',  label: 'Paper', value: '#f4efe6' },
      { type: 'range', key: 'offset', label: 'Misalign', min: 0, max: 40,  step: 1, value: 10 },
      { type: 'range', key: 'angle',  label: 'Angle',    min: 0, max: 360, step: 1, value: 30 },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const A = hexToRgb(p.inkA), B = hexToRgb(p.inkB), P = hexToRgb(p.paper);
      const ang = p.angle * Math.PI / 180;
      const ox = Math.cos(ang) * p.offset * scale / 2;
      const oy = Math.sin(ang) * p.offset * scale / 2;
      const lumAt = (x, y) => {
        const i = (clampN(Math.round(y), 0, h - 1) * w + clampN(Math.round(x), 0, w - 1)) * 4;
        return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      };
      for (let y = 0; y < h; y++){
        for (let x = 0; x < w; x++){
          const covA = 1 - lumAt(x - ox, y - oy) / 255;
          const covB = 1 - lumAt(x + ox, y + oy) / 255;
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++){
            const fA = 1 - covA * (1 - A[c] / 255);
            const fB = 1 - covB * (1 - B[c] / 255);
            o[i + c] = P[c] * fA * fB;
          }
          o[i + 3] = d[i + 3];
        }
      }
      return out;
    },
  },

  /* VHS wobble: sine-based horizontal row displacement, hash-picked
     tracking-glitch bands with extra offset and static, and per-channel
     horizontal color bleed. */
  vhs: {
    name: 'VHS',
    params: [
      { type: 'range', key: 'wobble',    label: 'Wobble',      min: 0, max: 100, step: 1, value: 30 },
      { type: 'range', key: 'frequency', label: 'Frequency',   min: 1, max: 100, step: 1, value: 40 },
      { type: 'range', key: 'bleed',     label: 'Color bleed', min: 0, max: 20,  step: 1, value: 4 },
      { type: 'range', key: 'noise',     label: 'Tracking',    min: 0, max: 100, step: 1, value: 30 },
    ],
    apply(src, p, scale = 1){
      const w = src.width, h = src.height, d = src.data;
      const out = new ImageData(w, h), o = out.data;
      const amp = (p.wobble / 100) * 18 * scale;
      const fq = (p.frequency / 100) * 4;
      const bleed = p.bleed * scale;
      const noiseP = p.noise / 100;
      const bandH = Math.max(1, Math.round(12 * scale));
      for (let y = 0; y < h; y++){
        let off = Math.sin(y * 0.045 * fq + 2.2 * Math.sin(y * 0.011 * fq)) * amp;
        const band = (y / bandH) | 0;
        const gb = hash2(band, 911);
        const glitch = gb > 1 - noiseP * 0.28;
        if (glitch){
          off += (hash2(band, 17) - 0.5) * amp * 7 + (hash2(y, 31) - 0.5) * 6 * scale;
        }
        const row = y * w;
        for (let x = 0; x < w; x++){
          const rX = clampN(Math.round(x - off - bleed), 0, w - 1);
          const gX = clampN(Math.round(x - off), 0, w - 1);
          const bX = clampN(Math.round(x - off + bleed), 0, w - 1);
          const i = (row + x) * 4;
          o[i]     = d[(row + rX) * 4];
          o[i + 1] = d[(row + gX) * 4 + 1];
          o[i + 2] = d[(row + bX) * 4 + 2];
          o[i + 3] = d[i + 3];
          if (glitch){
            const n = (hash2(x, y) - 0.5) * 90 * noiseP;
            o[i] += n; o[i + 1] += n; o[i + 2] += n;
          }
        }
      }
      return out;
    },
  },

  /* Paper texture: multi-octave value noise multiplied over the image,
     with an optional horizontally-stretched octave for paper fibers. */
  paper: {
    name: 'Paper Texture',
    params: [
      { type: 'range', key: 'intensity',  label: 'Intensity',  min: 0, max: 100, step: 1, value: 40 },
      { type: 'range', key: 'grainScale', label: 'Coarseness', min: 1, max: 10,  step: 1, value: 3 },
      { type: 'range', key: 'fibers',     label: 'Fibers',     min: 0, max: 100, step: 1, value: 30 },
    ],
    apply(src, p, scale = 1){
      const out = copyOf(src);
      const w = out.width, h = out.height, d = out.data;
      const gs = Math.max(1, p.grainScale * scale);
      const inten = p.intensity / 100;
      const fib = p.fibers / 100;
      for (let y = 0; y < h; y++){
        for (let x = 0; x < w; x++){
          let n = valueNoise(x / gs, y / gs, 101) * 0.6
                + valueNoise(x / (gs * 3), y / (gs * 3), 202) * 0.4;
          if (fib > 0){
            n = lerp(n, valueNoise(x / (gs * 14), y / (gs * 1.6), 303), fib * 0.5);
          }
          const f = 1 + (n - 0.5) * 0.7 * inten;
          const i = (y * w + x) * 4;
          d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
        }
      }
      return out;
    },
  },
};

const FILTER_ORDER = [
  'glass', 'pixelate', 'dither', 'posterize', 'grain', 'chroma',
  'gradient', 'duotone', 'halftone', 'scanlines', 'vhs', 'paper',
];
