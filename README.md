# ◧ FilterLab

A web app for applying **non-AI, classic image-processing effects** to illustrations and photos — right in the browser, no server, no uploads, no machine learning. Every effect is honest pixel math on raw RGBA data via the Canvas API.

## Features

**Filters** (stack as many as you like, reorder them, toggle each on/off):

| Filter | What it does | Controls |
|---|---|---|
| Privacy Glass | Bathroom-window textured glass — a grid of tiny lenses distorting the image | cell size, distortion, irregularity, frost |
| Pixel Art | Retro 16/32-bit look: block pixelation + color quantization | pixel size, color depth, saturation |
| Dither (Bayer) | Ordered dithering with a positional threshold matrix — 1-bit / retro print look | 2×2/4×4/8×8 pattern, levels, dot scale, mono |
| Posterize + Outline | Flat color bands with Sobel-detected ink outlines | levels, outline strength, thickness, line color |
| Grain | Film-style noise texture | intensity, grain size, mono/color |
| Chromatic Aberration | RGB channel separation, radial (lens) or directional | mode, amount, focus point, angle |
| Gradient Map | Remap tones through a color gradient | 6 presets + fully custom 3-stop gradient, mix |
| Duotone Print | Two misaligned ink plates on colored paper, risograph style | 2 ink colors, paper color, misalign, angle |
| Halftone | Print-style rotated dot grid | dot spacing, angle, colored/mono dots, paper |
| Scanlines | CRT-monitor line texture | spacing, thickness, darkness |
| VHS | Wobbly row displacement, tracking-glitch bands, color bleed | wobble, frequency, bleed, tracking |
| Paper Texture | Procedural value-noise paper grain with fibers | intensity, coarseness, fibers |

**Tools**

- 🖌 **Mask painting** — choose where filters apply, with two tools: a **brush** (size, hardness, opacity) and a **freehand lasso** (feather), each in hide or reveal mode, plus invert/clear
- ◂ ▸ **Before / After** — draggable split slider
- Live preview — every slider updates the image instantly
- Open via file picker, **drag & drop**, or **paste from clipboard**
- **Export PNG** at the original full resolution (parameters are scaled so the export matches the preview)

## Run it

No build step, no dependencies. Either:

- open `index.html` directly in a browser, or
- serve the folder: `npx serve .`

## How it works

The image is downscaled to a ≤1100px preview for instant feedback. The filter stack is a list of pure functions `ImageData → ImageData`; on every parameter change the whole stack re-runs on the preview inside one `requestAnimationFrame`. On export, the same stack runs at native resolution with pixel-based parameters (cell size, dot spacing…) multiplied by the scale factor, so what you see is what you get.

The mask is a grayscale offscreen canvas (white = filtered, black = original) painted with a soft radial-gradient brush and blended per-pixel at composite time.

No AI anywhere — just loops over `Uint8ClampedArray`.

## Tech

Vanilla HTML/CSS/JavaScript. Canvas 2D API. ~1000 lines total.

---

Made by [Asu Azure](https://github.com/asu-azure) · MIT License
