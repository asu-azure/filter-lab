'use strict';

/* FilterLab — app.js
 * State, rendering pipeline, and all UI wiring.
 * Preview runs on a downscaled copy (max 1100px) for instant feedback;
 * export re-runs the full pipeline at native resolution.
 */

const PREVIEW_MAX = 1100;

const $ = id => document.getElementById(id);
const els = {
  fileInput: $('file-input'),
  btnOpen: $('btn-open'),
  btnExport: $('btn-export'),
  btnCompare: $('btn-compare'),
  canvasArea: $('canvas-area'),
  dropzone: $('dropzone'),
  canvasWrap: $('canvas-wrap'),
  view: $('view'),
  compareHandle: $('compare-handle'),
  brushCursor: $('brush-cursor'),
  filterSelect: $('filter-select'),
  btnAdd: $('btn-add'),
  stack: $('stack'),
  btnMaskMode: $('btn-mask-mode'),
  maskControls: $('mask-controls'),
  brushOpts: $('brush-opts'),
  lassoOpts: $('lasso-opts'),
  brushSize: $('brush-size'),
  brushHardness: $('brush-hardness'),
  brushOpacity: $('brush-opacity'),
  lassoFeather: $('lasso-feather'),
  btnMaskInvert: $('btn-mask-invert'),
  btnMaskClear: $('btn-mask-clear'),
};

const viewCtx = els.view.getContext('2d', { willReadFrequently: true });

const state = {
  full: null,          // full-resolution source canvas
  original: null,      // preview-resolution ImageData (untouched source)
  stack: [],           // [{ id, type, enabled, params }]
  maskCanvas: null,    // preview-size canvas; white = filters apply, black = hidden
  maskCtx: null,
  maskUsed: false,
  maskMode: false,
  maskTool: 'brush',
  brushMode: 'hide',
  compare: false,
  comparePos: 0.5,
};
let uid = 0;

/* ---------------- rendering ---------------- */

let renderQueued = false;
function requestRender(){
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render(){
  if (!state.original) return;
  const w = state.original.width, h = state.original.height;
  let img = new ImageData(new Uint8ClampedArray(state.original.data), w, h);
  for (const f of state.stack){
    if (f.enabled) img = FILTERS[f.type].apply(img, f.params, 1);
  }
  const needMask = state.maskUsed || state.maskMode;
  if (needMask){
    const m = state.maskCtx.getImageData(0, 0, w, h).data;
    const d = img.data, s = state.original.data;
    for (let i = 0; i < d.length; i += 4){
      const a = m[i] / 255;
      if (a < 1){
        const ia = 1 - a;
        d[i]     = d[i]     * a + s[i]     * ia;
        d[i + 1] = d[i + 1] * a + s[i + 1] * ia;
        d[i + 2] = d[i + 2] * a + s[i + 2] * ia;
      }
      if (state.maskMode){
        const t = (1 - a) * 0.45;   // red tint marks hidden areas while painting
        d[i]     = d[i] * (1 - t) + 255 * t;
        d[i + 1] *= 1 - t;
        d[i + 2] *= 1 - t;
      }
    }
  }
  viewCtx.putImageData(img, 0, 0);

  // live lasso outline while dragging
  if (state.maskMode && lassoPts && lassoPts.length > 1){
    viewCtx.save();
    viewCtx.beginPath();
    viewCtx.moveTo(lassoPts[0].x, lassoPts[0].y);
    for (let i = 1; i < lassoPts.length; i++) viewCtx.lineTo(lassoPts[i].x, lassoPts[i].y);
    viewCtx.lineWidth = 2;
    viewCtx.strokeStyle = 'rgba(0,0,0,.8)';
    viewCtx.stroke();
    viewCtx.setLineDash([6, 5]);
    viewCtx.strokeStyle = '#fff';
    viewCtx.stroke();
    viewCtx.restore();
  }

  const showCompare = state.compare && !state.maskMode;
  if (showCompare){
    const split = Math.round(state.comparePos * w);
    if (split > 0) viewCtx.putImageData(state.original, 0, 0, 0, 0, split, h);
    els.compareHandle.style.left = (state.comparePos * 100) + '%';
  }
  els.compareHandle.hidden = !showCompare;
}

/* ---------------- image loading ---------------- */

function loadImage(blob){
  if (!blob || !blob.type.startsWith('image/')) return;
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); setImage(img); };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function setImage(img){
  const fw = img.naturalWidth, fh = img.naturalHeight;
  state.full = document.createElement('canvas');
  state.full.width = fw; state.full.height = fh;
  state.full.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);

  const scale = Math.min(1, PREVIEW_MAX / Math.max(fw, fh));
  const pw = Math.max(1, Math.round(fw * scale));
  const ph = Math.max(1, Math.round(fh * scale));
  els.view.width = pw; els.view.height = ph;

  const pc = document.createElement('canvas');
  pc.width = pw; pc.height = ph;
  const pctx = pc.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0, pw, ph);
  state.original = pctx.getImageData(0, 0, pw, ph);

  state.maskCanvas = document.createElement('canvas');
  state.maskCanvas.width = pw; state.maskCanvas.height = ph;
  state.maskCtx = state.maskCanvas.getContext('2d', { willReadFrequently: true });
  state.maskCtx.fillStyle = '#fff';
  state.maskCtx.fillRect(0, 0, pw, ph);
  state.maskUsed = false;

  els.dropzone.hidden = true;
  els.canvasWrap.hidden = false;
  els.btnExport.disabled = false;
  els.btnCompare.disabled = false;
  els.btnMaskMode.disabled = false;
  requestRender();
}

/* ---------------- filter stack UI ---------------- */

FILTER_ORDER.forEach(key => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = FILTERS[key].name;
  els.filterSelect.appendChild(opt);
});

function addFilter(type){
  const def = FILTERS[type];
  const params = {};
  def.params.forEach(pd => { params[pd.key] = pd.value; });
  state.stack.push({ id: ++uid, type, enabled: true, params });
  renderStack();
  requestRender();
}

function renderStack(){
  els.stack.innerHTML = '';
  if (!state.stack.length){
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No filters yet — pick one above and hit Add. Filters stack top to bottom.';
    els.stack.appendChild(p);
    return;
  }
  state.stack.forEach((f, idx) => els.stack.appendChild(buildCard(f, idx)));
}

function buildCard(f, idx){
  const def = FILTERS[f.type];
  const card = document.createElement('div');
  card.className = 'card' + (f.enabled ? '' : ' off');

  const head = document.createElement('div');
  head.className = 'card-head';

  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = f.enabled;
  cb.addEventListener('change', () => {
    f.enabled = cb.checked;
    card.classList.toggle('off', !f.enabled);
    requestRender();
  });
  toggle.appendChild(cb);
  toggle.appendChild(document.createElement('i'));

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = def.name;

  const mkBtn = (txt, label, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.textContent = txt;
    b.title = label;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    return b;
  };
  const move = dir => {
    const j = idx + dir;
    [state.stack[idx], state.stack[j]] = [state.stack[j], state.stack[idx]];
    renderStack();
    requestRender();
  };

  head.appendChild(toggle);
  head.appendChild(title);
  head.appendChild(mkBtn('↑', 'Move up', () => move(-1), idx === 0));
  head.appendChild(mkBtn('↓', 'Move down', () => move(1), idx === state.stack.length - 1));
  head.appendChild(mkBtn('✕', 'Remove', () => {
    state.stack.splice(idx, 1);
    renderStack();
    requestRender();
  }));
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'controls';
  const inputs = {};   // key -> { input, readout }

  def.params.forEach(pd => {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = pd.label;
    row.appendChild(label);

    let input, readout = null;
    if (pd.type === 'range'){
      input = document.createElement('input');
      input.type = 'range';
      input.min = pd.min; input.max = pd.max; input.step = pd.step || 1;
      input.value = f.params[pd.key];
      readout = document.createElement('span');
      readout.className = 'val';
      readout.textContent = f.params[pd.key];
    } else if (pd.type === 'color'){
      input = document.createElement('input');
      input.type = 'color';
      input.value = f.params[pd.key];
    } else if (pd.type === 'checkbox'){
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = f.params[pd.key];
      row.classList.add('check');
    } else if (pd.type === 'select'){
      input = document.createElement('select');
      pd.options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        input.appendChild(opt);
      });
      input.value = f.params[pd.key];
    }

    input.addEventListener('input', () => {
      f.params[pd.key] =
        pd.type === 'range' ? parseFloat(input.value) :
        pd.type === 'checkbox' ? input.checked : input.value;
      if (def.sync){
        def.sync(f.params, pd.key);
        syncInputs();
      }
      if (readout) readout.textContent = input.value;
      requestRender();
    });

    row.appendChild(input);
    if (readout) row.appendChild(readout);
    inputs[pd.key] = { input, readout, type: pd.type };
    body.appendChild(row);
  });

  function syncInputs(){
    def.params.forEach(pd => {
      const { input, readout, type } = inputs[pd.key];
      if (type === 'checkbox') input.checked = f.params[pd.key];
      else input.value = f.params[pd.key];
      if (readout) readout.textContent = f.params[pd.key];
    });
  }

  card.appendChild(body);
  return card;
}

/* ---------------- mask painting ---------------- */

function canvasPos(e){
  const r = els.view.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * els.view.width / r.width,
    y: (e.clientY - r.top) * els.view.height / r.height,
  };
}

let painting = false;
let lastPt = null;
let lassoPts = null;

function stamp(pt){
  const r = parseFloat(els.brushSize.value);
  const hard = parseFloat(els.brushHardness.value) / 100;
  const op = parseFloat(els.brushOpacity.value) / 100;
  const col = state.brushMode === 'hide' ? '0,0,0' : '255,255,255';
  const g = state.maskCtx.createRadialGradient(pt.x, pt.y, r * hard * 0.95, pt.x, pt.y, r);
  g.addColorStop(0, `rgba(${col},${op})`);
  g.addColorStop(1, `rgba(${col},0)`);
  state.maskCtx.fillStyle = g;
  state.maskCtx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
}

function applyLasso(){
  const w = state.maskCanvas.width, h = state.maskCanvas.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const t = tmp.getContext('2d');
  t.fillStyle = state.brushMode === 'hide' ? '#000' : '#fff';
  t.beginPath();
  t.moveTo(lassoPts[0].x, lassoPts[0].y);
  for (let i = 1; i < lassoPts.length; i++) t.lineTo(lassoPts[i].x, lassoPts[i].y);
  t.closePath();
  t.fill();
  const feather = parseFloat(els.lassoFeather.value);
  if (feather > 0) state.maskCtx.filter = `blur(${feather}px)`;
  state.maskCtx.drawImage(tmp, 0, 0);
  state.maskCtx.filter = 'none';
  state.maskUsed = true;
}

function paintAt(e){
  const pt = canvasPos(e);
  if (lastPt){
    const dist = Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y);
    const step = Math.max(2, parseFloat(els.brushSize.value) * 0.3);
    for (let t = step; t < dist; t += step){
      stamp({
        x: lastPt.x + (pt.x - lastPt.x) * t / dist,
        y: lastPt.y + (pt.y - lastPt.y) * t / dist,
      });
    }
  }
  stamp(pt);
  lastPt = pt;
  state.maskUsed = true;
  requestRender();
}

function updateBrushCursor(e){
  if (!state.maskMode || state.maskTool !== 'brush'){ els.brushCursor.hidden = true; return; }
  const r = els.view.getBoundingClientRect();
  const wrapR = els.canvasWrap.getBoundingClientRect();
  const dispR = parseFloat(els.brushSize.value) * r.width / els.view.width;
  els.brushCursor.hidden = false;
  els.brushCursor.style.width = els.brushCursor.style.height = dispR * 2 + 'px';
  els.brushCursor.style.left = (e.clientX - wrapR.left - dispR) + 'px';
  els.brushCursor.style.top = (e.clientY - wrapR.top - dispR) + 'px';
}

els.view.addEventListener('pointerdown', e => {
  if (!state.maskMode) return;
  e.preventDefault();
  els.view.setPointerCapture(e.pointerId);
  if (state.maskTool === 'lasso'){
    lassoPts = [canvasPos(e)];
  } else {
    painting = true;
    lastPt = null;
    paintAt(e);
  }
});
els.view.addEventListener('pointermove', e => {
  updateBrushCursor(e);
  if (painting) paintAt(e);
  else if (lassoPts){
    const pt = canvasPos(e);
    const prev = lassoPts[lassoPts.length - 1];
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) > 3){
      lassoPts.push(pt);
      requestRender();
    }
  }
});
['pointerup', 'pointercancel'].forEach(ev =>
  els.view.addEventListener(ev, () => {
    painting = false;
    lastPt = null;
    if (lassoPts){
      if (lassoPts.length > 2) applyLasso();
      lassoPts = null;
      requestRender();
    }
  }));
els.view.addEventListener('pointerleave', () => { els.brushCursor.hidden = true; });

document.querySelectorAll('input[name="mask-tool"]').forEach(r =>
  r.addEventListener('change', () => {
    state.maskTool = r.value;
    els.brushOpts.hidden = r.value !== 'brush';
    els.lassoOpts.hidden = r.value !== 'lasso';
    els.canvasWrap.classList.toggle('lasso', r.value === 'lasso');
  }));

els.btnMaskMode.addEventListener('click', () => {
  state.maskMode = !state.maskMode;
  els.btnMaskMode.classList.toggle('active', state.maskMode);
  els.btnMaskMode.textContent = state.maskMode ? '✓ Done painting' : '🖌 Paint mask';
  els.maskControls.hidden = !state.maskMode;
  els.canvasWrap.classList.toggle('masking', state.maskMode);
  requestRender();
});

document.querySelectorAll('input[name="brush-mode"]').forEach(r =>
  r.addEventListener('change', () => { state.brushMode = r.value; }));

['brush-size', 'brush-hardness', 'brush-opacity', 'lasso-feather'].forEach(id => {
  const input = $(id), readout = $(id + '-val');
  input.addEventListener('input', () => { readout.textContent = input.value; });
});

els.btnMaskInvert.addEventListener('click', () => {
  if (!state.maskCtx) return;
  const w = state.maskCanvas.width, h = state.maskCanvas.height;
  const m = state.maskCtx.getImageData(0, 0, w, h);
  const d = m.data;
  for (let i = 0; i < d.length; i += 4){
    d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
  }
  state.maskCtx.putImageData(m, 0, 0);
  state.maskUsed = true;
  requestRender();
});

els.btnMaskClear.addEventListener('click', () => {
  if (!state.maskCtx) return;
  state.maskCtx.fillStyle = '#fff';
  state.maskCtx.fillRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
  state.maskUsed = false;
  requestRender();
});

/* ---------------- before / after ---------------- */

els.btnCompare.addEventListener('click', () => {
  state.compare = !state.compare;
  els.btnCompare.classList.toggle('active', state.compare);
  requestRender();
});

let draggingHandle = false;
els.compareHandle.addEventListener('pointerdown', e => {
  e.preventDefault();
  draggingHandle = true;
  els.compareHandle.setPointerCapture(e.pointerId);
});
els.compareHandle.addEventListener('pointermove', e => {
  if (!draggingHandle) return;
  const r = els.view.getBoundingClientRect();
  state.comparePos = clampN((e.clientX - r.left) / r.width, 0, 1);
  requestRender();
});
['pointerup', 'pointercancel'].forEach(ev =>
  els.compareHandle.addEventListener(ev, () => { draggingHandle = false; }));

/* ---------------- export ---------------- */

async function exportImage(){
  if (!state.full) return;
  const btn = els.btnExport;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = 'Exporting…';
  await new Promise(r => setTimeout(r, 30));   // let the button repaint
  try {
    const fw = state.full.width, fh = state.full.height;
    const scale = fw / els.view.width;
    const fctx = state.full.getContext('2d', { willReadFrequently: true });
    const source = fctx.getImageData(0, 0, fw, fh);
    let img = new ImageData(new Uint8ClampedArray(source.data), fw, fh);
    for (const f of state.stack){
      if (f.enabled) img = FILTERS[f.type].apply(img, f.params, scale);
    }
    if (state.maskUsed){
      const mc = document.createElement('canvas');
      mc.width = fw; mc.height = fh;
      const mctx = mc.getContext('2d', { willReadFrequently: true });
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(state.maskCanvas, 0, 0, fw, fh);
      const m = mctx.getImageData(0, 0, fw, fh).data;
      const d = img.data, s = source.data;
      for (let i = 0; i < d.length; i += 4){
        const a = m[i] / 255;
        if (a < 1){
          const ia = 1 - a;
          d[i]     = d[i]     * a + s[i]     * ia;
          d[i + 1] = d[i + 1] * a + s[i + 1] * ia;
          d[i + 2] = d[i + 2] * a + s[i + 2] * ia;
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = fw; c.height = fh;
    c.getContext('2d').putImageData(img, 0, 0);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `filterlab-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* ---------------- file input / drag & drop / paste ---------------- */

els.btnOpen.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadImage(els.fileInput.files[0]);
  els.fileInput.value = '';
});

['dragover', 'dragenter'].forEach(ev =>
  els.canvasArea.addEventListener(ev, e => {
    e.preventDefault();
    els.canvasArea.classList.add('dragging');
  }));
['dragleave', 'drop'].forEach(ev =>
  els.canvasArea.addEventListener(ev, e => {
    e.preventDefault();
    els.canvasArea.classList.remove('dragging');
  }));
els.canvasArea.addEventListener('drop', e => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadImage(file);
});

window.addEventListener('paste', e => {
  for (const item of e.clipboardData.items){
    if (item.type.startsWith('image/')){
      loadImage(item.getAsFile());
      break;
    }
  }
});

els.btnAdd.addEventListener('click', () => addFilter(els.filterSelect.value));
els.btnExport.addEventListener('click', exportImage);

renderStack();
