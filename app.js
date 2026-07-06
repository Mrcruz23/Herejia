// ============================================================
// HEREJÍA — motor de filtros en canvas 2D puro (sin dependencias)
// ============================================================

const canvas   = document.getElementById('canvas');
const ctx      = canvas.getContext('2d', { willReadFrequently: true });
const stage    = document.getElementById('stage');
const emptyState = document.getElementById('empty-state');
const crosshair = document.getElementById('crosshair');
const pickBanner = document.getElementById('pick-banner');
const toastEl  = document.getElementById('toast');

let sourceImg      = null;   // Image original, resolución completa
let sourceCanvas   = null;   // canvas offscreen con la imagen original a resolución de trabajo
let workW = 0, workH = 0;
let renderScheduled = false;
let lastRenderedBitmap = null; // para el botón "comparar"
let noiseTileCache = {};       // cache de patrones de ruido por seed/size

const MAX_DIM = 1600; // resolución de trabajo (liviano en celus modestos)

// ---------------- ESTADO DE FILTROS ----------------
const DEFAULT_STATE = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0, sharpen: 0,
  temp: 0, tint: 0, fade: 0, vignette: 0, shadowtone: 0,
  grain: 0, chroma: 0, scanlines: 0, bloom: 0, shadowgrain: 0,
  colorpop: false, popColor: null, tolerance: 40, feather: 20, popBoost: 20
};
let state = { ...DEFAULT_STATE };

// ---------------- PRESETS ----------------
// Perfiles derivados del look de referencia: negros hundidos, grano visible,
// tinte frío-verdoso en sombras, contraste alto sin quemar blancos.
const BUILTIN_PRESETS = [
  {
    id:'nocturno', name:'NOCTURNO', swatch:'#1b2624',
    v:{ brightness:-8, contrast:22, saturation:-18, hue:0, sharpen:10,
        temp:-14, tint:6, fade:8, vignette:38, shadowtone:55,
        grain:35, chroma:8, scanlines:0, bloom:12, shadowgrain:40 }
  },
  {
    id:'vhs_frio', name:'VHS FRÍO', swatch:'#28413d',
    v:{ brightness:-4, contrast:16, saturation:-25, hue:-6, sharpen:0,
        temp:-22, tint:10, fade:12, vignette:28, shadowtone:60,
        grain:45, chroma:22, scanlines:35, bloom:18, shadowgrain:30 }
  },
  {
    id:'analogico', name:'ANALÓGICO', swatch:'#3a3630',
    v:{ brightness:2, contrast:12, saturation:-10, hue:4, sharpen:0,
        temp:10, tint:-4, fade:22, vignette:20, shadowtone:15,
        grain:55, chroma:5, scanlines:0, bloom:8, shadowgrain:15 }
  },
  {
    id:'sombra_muda', name:'SOMBRA MUDA', swatch:'#14201d',
    v:{ brightness:-18, contrast:30, saturation:-35, hue:0, sharpen:5,
        temp:-8, tint:8, fade:4, vignette:50, shadowtone:65,
        grain:30, chroma:4, scanlines:0, bloom:6, shadowgrain:45 }
  },
  {
    id:'cinema_teal', name:'CINE TEAL', swatch:'#215048',
    v:{ brightness:0, contrast:20, saturation:-5, hue:-10, sharpen:8,
        temp:-16, tint:14, fade:6, vignette:30, shadowtone:70,
        grain:15, chroma:6, scanlines:0, bloom:20, shadowgrain:20 }
  },
  {
    id:'ruina', name:'RUINA', swatch:'#2b2b2b',
    v:{ brightness:-12, contrast:26, saturation:-45, hue:0, sharpen:12,
        temp:-4, tint:2, fade:10, vignette:42, shadowtone:20,
        grain:50, chroma:10, scanlines:0, bloom:5, shadowgrain:35 }
  }
];

let customPresets = [];
try { customPresets = JSON.parse(localStorage.getItem('grano_custom_presets') || '[]'); } catch(e){ customPresets = []; }
let activePresetId = null;

// ============================================================
// CARGA DE IMAGEN
// ============================================================
document.getElementById('btn-load').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    loadImage(img);
    URL.revokeObjectURL(url);
  };
  img.src = url;
  e.target.value = '';
});

function loadImage(img){
  sourceImg = img;

  let w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  workW = Math.round(w * scale);
  workH = Math.round(h * scale);

  sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = workW;
  sourceCanvas.height = workH;
  const sctx = sourceCanvas.getContext('2d');
  sctx.drawImage(img, 0, 0, workW, workH);

  canvas.width = workW;
  canvas.height = workH;

  emptyState.style.display = 'none';
  document.getElementById('btn-export').disabled = false;

  state = { ...DEFAULT_STATE };
  syncSlidersFromState();
  clearPopColorUI();
  scheduleRender();
}

// ============================================================
// PIPELINE DE RENDER
// ============================================================
function scheduleRender(){
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render(){
  if (!sourceCanvas) return;

  // 1. Filtros CSS-nativos (rápidos, aceleración por GPU): brillo/contraste/saturación/hue
  const b = 100 + state.brightness;          // 0..200
  const c = 100 + state.contrast;            // 0..200
  const s = 100 + state.saturation;          // 0..200
  const hueDeg = state.hue;

  ctx.save();
  ctx.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%) hue-rotate(${hueDeg}deg)`;
  ctx.clearRect(0,0,workW,workH);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
  ctx.filter = 'none';

  // 2. A partir de acá trabajamos por pixel para: temp/tint, fade, shadowtone,
  //    color-pop, grain, chroma shift, scanlines, vignette, bloom.
  let imgData = ctx.getImageData(0, 0, workW, workH);
  applyPixelPipeline(imgData);
  ctx.putImageData(imgData, 0, 0);

  // 3. Efectos que conviene hacer con canvas compositing (más baratos así)
  if (state.vignette > 0) applyVignetteCanvas(state.vignette);
  if (state.scanlines > 0) applyScanlinesCanvas(state.scanlines);
  if (state.bloom > 0) applyBloomCanvas(state.bloom);
}

function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

function applyPixelPipeline(imgData){
  const data = imgData.data;
  const len = data.length;

  const temp = state.temp;               // -100..100
  const tint = state.tint;                // -100..100 (negativo=verde, positivo=magenta)
  const fade = state.fade / 100;          // 0..1
  const shadowtone = state.shadowtone / 100; // 0..1
  const grainAmt = state.grain / 100;
  const chromaAmt = state.chroma;
  const shadowGrainAmt = state.shadowgrain / 100;

  const popActive = state.colorpop && state.popColor;
  let pr=0, pg=0, pb=0, tolerance=0, feather=0, popBoost=0;
  if (popActive){
    pr = state.popColor.r; pg = state.popColor.g; pb = state.popColor.b;
    tolerance = state.tolerance;
    feather = state.feather;
    popBoost = state.popBoost / 100;
  }

  // fade lift: sube el piso de negros y baja levemente el techo de blancos (look "film")
  const liftLo = fade * 28;
  const liftHi = 255 - fade * 14;
  const liftRange = liftHi - liftLo;

  // chroma shift: desplazamiento horizontal de canal R y B (glitch/analógico sutil)
  const shiftPx = Math.round((chromaAmt / 100) * 4);

  const w = workW, h = workH;
  const srcCopy = shiftPx > 0 ? new Uint8ClampedArray(data) : null;

  for (let i = 0; i < len; i += 4){
    let r = data[i], g = data[i+1], b = data[i+2];

    // --- temperatura (cálido: +R -B / frío: -R +B) ---
    if (temp !== 0){
      r = clamp(r + temp * 0.5, 0, 255);
      b = clamp(b - temp * 0.5, 0, 255);
    }
    // --- tinte (verde <-> magenta) ---
    if (tint !== 0){
      g = clamp(g - tint * 0.35, 0, 255);
      r = clamp(r + tint * 0.15, 0, 255);
      b = clamp(b + tint * 0.15, 0, 255);
    }

    // --- fade / lift de negros ---
    if (fade > 0){
      r = liftLo + (r/255) * liftRange;
      g = liftLo + (g/255) * liftRange;
      b = liftLo + (b/255) * liftRange;
    }

    // --- tono frío-verdoso en sombras (shadowtone) ---
    if (shadowtone > 0){
      const luma = (r*0.299 + g*0.587 + b*0.114) / 255;
      const shadowMask = Math.pow(1 - luma, 2.2) * shadowtone;
      g = clamp(g + shadowMask * 18, 0, 255);
      b = clamp(b + shadowMask * 22, 0, 255);
      r = clamp(r - shadowMask * 8, 0, 255);
    }

    // --- color pop (Sin City): desaturar todo salvo el color elegido ---
    if (popActive){
      const dist = Math.sqrt((r-pr)**2 + (g-pg)**2 + (b-pb)**2);
      const maxDist = tolerance * 2.6 + 1;
      let keep;
      if (dist <= maxDist) keep = 1;
      else if (dist <= maxDist + feather * 2) keep = 1 - (dist - maxDist) / (feather * 2 || 1);
      else keep = 0;
      keep = clamp(keep, 0, 1);

      const gray = r*0.299 + g*0.587 + b*0.114;
      let boostR = r, boostG = g, boostB = b;
      if (popBoost > 0){
        boostR = clamp(r + (r - gray) * popBoost * 1.5, 0, 255);
        boostG = clamp(g + (g - gray) * popBoost * 1.5, 0, 255);
        boostB = clamp(b + (b - gray) * popBoost * 1.5, 0, 255);
      }
      r = gray * (1 - keep) + boostR * keep;
      g = gray * (1 - keep) + boostG * keep;
      b = gray * (1 - keep) + boostB * keep;
    }

    // --- grano (monocromático: mismo desplazamiento en los 3 canales, como grano de película real) ---
    if (grainAmt > 0 || shadowGrainAmt > 0){
      const noise = (Math.random() - 0.5) * 255;
      let intensity = grainAmt;
      if (shadowGrainAmt > 0){
        const luma = (r*0.299 + g*0.587 + b*0.114) / 255;
        intensity = Math.max(intensity, shadowGrainAmt * (1 - luma));
      }
      const n = noise * intensity * 0.55;
      r = clamp(r + n, 0, 255);
      g = clamp(g + n, 0, 255);
      b = clamp(b + n, 0, 255);
    }

    data[i]   = r;
    data[i+1] = g;
    data[i+2] = b;
  }

  // chroma shift (segunda pasada, usa copia sin desplazar como fuente)
  if (shiftPx > 0 && srcCopy){
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        const idx = (y*w + x) * 4;
        const xR = clamp(x - shiftPx, 0, w-1);
        const xB = clamp(x + shiftPx, 0, w-1);
        const idxR = (y*w + xR) * 4;
        const idxB = (y*w + xB) * 4;
        data[idx]   = srcCopy[idxR];
        data[idx+2] = srcCopy[idxB+2];
      }
    }
  }
}

function applyVignetteCanvas(amount){
  const w = workW, h = workH;
  const grad = ctx.createRadialGradient(
    w/2, h/2, Math.min(w,h) * 0.25,
    w/2, h/2, Math.max(w,h) * 0.72
  );
  const a = (amount/100) * 0.85;
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${a})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,w,h);
  ctx.restore();
}

function applyScanlinesCanvas(amount){
  const w = workW, h = workH;
  const a = (amount/100) * 0.35;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#000';
  for (let y = 0; y < h; y += 3){
    ctx.fillRect(0, y, w, 1);
  }
  ctx.restore();
}

function applyBloomCanvas(amount){
  const w = workW, h = workH;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.filter = `blur(${Math.round(4 + amount/8)}px) brightness(140%)`;
  octx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = clamp(amount/100, 0, 1) * 0.45;
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

// ============================================================
// SLIDERS — binding genérico
// ============================================================
const sliderDefs = [
  ['s-brightness','v-brightness','brightness', v=>v],
  ['s-contrast','v-contrast','contrast', v=>v],
  ['s-saturation','v-saturation','saturation', v=>v],
  ['s-hue','v-hue','hue', v=>v+'°'],
  ['s-sharpen','v-sharpen','sharpen', v=>v],
  ['s-temp','v-temp','temp', v=>v],
  ['s-tint','v-tint','tint', v=>v],
  ['s-fade','v-fade','fade', v=>v],
  ['s-vignette','v-vignette','vignette', v=>v],
  ['s-shadowtone','v-shadowtone','shadowtone', v=>v],
  ['s-grain','v-grain','grain', v=>v],
  ['s-chroma','v-chroma','chroma', v=>v],
  ['s-scanlines','v-scanlines','scanlines', v=>v],
  ['s-bloom','v-bloom','bloom', v=>v],
  ['s-shadowgrain','v-shadowgrain','shadowgrain', v=>v],
  ['s-tolerance','v-tolerance','tolerance', v=>v],
  ['s-feather','v-feather','feather', v=>v],
  ['s-popboost','v-popboost','popBoost', v=>v],
];

sliderDefs.forEach(([inputId, labelId, key, fmt]) => {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  input.addEventListener('input', () => {
    const v = parseInt(input.value, 10);
    state[key] = v;
    label.textContent = fmt(v);
    activePresetId = null;
    markCustom();
    if (!sourceCanvas) return;
    scheduleRender();
  });
});

function syncSlidersFromState(){
  sliderDefs.forEach(([inputId, labelId, key, fmt]) => {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    input.value = state[key];
    label.textContent = fmt(state[key]);
  });
}

function markCustom(){
  document.querySelectorAll('.preset-card').forEach(el => el.classList.remove('active'));
}

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'colorpop'){
      // nada extra
    } else {
      hidePicker();
    }
  });
});

// ============================================================
// PRESETS UI
// ============================================================
function renderPresetGrid(){
  const grid = document.getElementById('preset-grid');
  grid.innerHTML = '';

  BUILTIN_PRESETS.forEach(p => {
    const card = document.createElement('div');
    card.className = 'preset-card' + (activePresetId === p.id ? ' active' : '');
    card.innerHTML = `<div class="swatch" style="background:${p.swatch}"></div><span>${p.name}</span>`;
    card.addEventListener('click', () => applyPreset(p));
    grid.appendChild(card);
  });

  customPresets.forEach(p => {
    const card = document.createElement('div');
    card.className = 'preset-card custom' + (activePresetId === p.id ? ' active' : '');
    card.innerHTML = `<div class="swatch" style="background:${p.swatch}"></div><span>${p.name}</span><div class="del">✕</div>`;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')){
        e.stopPropagation();
        deleteCustomPreset(p.id);
        return;
      }
      applyPreset(p);
    });
    grid.appendChild(card);
  });
}

function applyPreset(p){
  activePresetId = p.id;
  const popState = { colorpop: state.colorpop, popColor: state.popColor, tolerance: state.tolerance, feather: state.feather, popBoost: state.popBoost };
  state = { ...DEFAULT_STATE, ...p.v, ...popState };
  syncSlidersFromState();
  renderPresetGrid();
  if (sourceCanvas) scheduleRender();
  showToast('Preset "' + p.name + '" aplicado');
}

function deleteCustomPreset(id){
  customPresets = customPresets.filter(p => p.id !== id);
  localStorage.setItem('grano_custom_presets', JSON.stringify(customPresets));
  if (activePresetId === id) activePresetId = null;
  renderPresetGrid();
}

document.getElementById('btn-save-preset').addEventListener('click', () => {
  document.getElementById('preset-name-input').value = '';
  document.getElementById('modal-scrim').classList.add('show');
  setTimeout(() => document.getElementById('preset-name-input').focus(), 80);
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-scrim').classList.remove('show');
});

document.getElementById('modal-confirm').addEventListener('click', () => {
  const name = document.getElementById('preset-name-input').value.trim() || 'MI PRESET';
  const id = 'custom_' + Date.now();
  const swatchColor = approximatePresetColor();
  const newPreset = { id, name: name.toUpperCase().slice(0,18), swatch: swatchColor, v: extractCurrentAdjustments() };
  customPresets.push(newPreset);
  localStorage.setItem('grano_custom_presets', JSON.stringify(customPresets));
  activePresetId = id;
  renderPresetGrid();
  document.getElementById('modal-scrim').classList.remove('show');
  showToast('Preset guardado');
  document.querySelector('.tab[data-panel="presets"]').click();
});

function extractCurrentAdjustments(){
  const { colorpop, popColor, tolerance, feather, popBoost, ...rest } = state;
  return rest;
}

function approximatePresetColor(){
  // toma un pixel central de la imagen actual en canvas como referencia de swatch
  if (!sourceCanvas) return '#3f5b55';
  try{
    const d = ctx.getImageData(Math.floor(workW/2), Math.floor(workH/2), 1, 1).data;
    return `rgb(${d[0]},${d[1]},${d[2]})`;
  } catch(e){ return '#3f5b55'; }
}

// ============================================================
// COLOR POP — toggle, picker por click, rueda de color
// ============================================================
const swColorpop = document.getElementById('sw-colorpop');
swColorpop.addEventListener('click', () => {
  state.colorpop = !state.colorpop;
  swColorpop.classList.toggle('on', state.colorpop);
  if (!state.colorpop) hidePicker();
  if (sourceCanvas) scheduleRender();
});

document.getElementById('btn-pick-color').addEventListener('click', () => {
  if (!sourceCanvas){ showToast('Cargá una foto primero'); return; }
  showPicker();
});

function showPicker(){
  pickBanner.style.display = 'block';
  canvas.style.cursor = 'crosshair';
  pickingActive = true;
}
function hidePicker(){
  pickBanner.style.display = 'none';
  crosshair.style.display = 'none';
  canvas.style.cursor = 'default';
  pickingActive = false;
}

let pickingActive = false;

canvas.addEventListener('click', (e) => {
  if (!pickingActive || !sourceCanvas) return;
  const canvasRect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;
  const x = Math.floor((e.clientX - canvasRect.left) * scaleX);
  const y = Math.floor((e.clientY - canvasRect.top) * scaleY);

  // Sampleamos de la imagen ORIGINAL (sourceCanvas) para que el color no dependa
  // de los filtros ya aplicados
  const sctx = sourceCanvas.getContext('2d');
  const d = sctx.getImageData(clamp(x,0,workW-1), clamp(y,0,workH-1), 1, 1).data;
  setPopColor(d[0], d[1], d[2]);

  // el crosshair se posiciona absoluto DENTRO de #stage, así que sus coords
  // deben ser relativas a #stage, no al canvas
  const stageRect = stage.getBoundingClientRect();
  crosshair.style.display = 'block';
  crosshair.style.left = (e.clientX - stageRect.left) + 'px';
  crosshair.style.top = (e.clientY - stageRect.top) + 'px';

  hidePicker();
  state.colorpop = true;
  swColorpop.classList.add('on');
  scheduleRender();
  showToast('Color elegido ✓');
});

document.getElementById('cp-colorwheel').addEventListener('input', (e) => {
  const hex = e.target.value;
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  setPopColor(r,g,b);
  crosshair.style.display = 'none';
  state.colorpop = true;
  swColorpop.classList.add('on');
  if (sourceCanvas) scheduleRender();
});

function setPopColor(r,g,b){
  state.popColor = { r, g, b };
  const sw = document.getElementById('cp-swatch');
  sw.classList.remove('empty');
  sw.style.background = `rgb(${r},${g},${b})`;
  document.getElementById('cp-colorwheel').value = rgbToHex(r,g,b);
}
function clearPopColorUI(){
  const sw = document.getElementById('cp-swatch');
  sw.classList.add('empty');
  sw.style.background = 'none';
}
function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

// ============================================================
// BOTONES: reset, comparar, deshacer(simple), export
// ============================================================
document.getElementById('btn-reset').addEventListener('click', () => {
  const pop = { colorpop: false, popColor: state.popColor, tolerance: state.tolerance, feather: state.feather, popBoost: state.popBoost };
  state = { ...DEFAULT_STATE };
  activePresetId = null;
  syncSlidersFromState();
  swColorpop.classList.remove('on');
  renderPresetGrid();
  if (sourceCanvas) scheduleRender();
  showToast('Ajustes reseteados');
});

let comparing = false;
const btnCompare = document.getElementById('btn-compare');
btnCompare.addEventListener('pointerdown', () => {
  if (!sourceCanvas) return;
  comparing = true;
  btnCompare.classList.add('on');
  ctx.clearRect(0,0,workW,workH);
  ctx.drawImage(sourceCanvas, 0, 0);
});
function endCompare(){
  if (!comparing) return;
  comparing = false;
  btnCompare.classList.remove('on');
  if (sourceCanvas) render();
}
btnCompare.addEventListener('pointerup', endCompare);
btnCompare.addEventListener('pointerleave', endCompare);

document.getElementById('btn-undo').addEventListener('click', () => {
  showToast('Usá RESET para volver al original');
});

document.getElementById('btn-export').addEventListener('click', () => {
  if (!sourceCanvas) return;
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'herejia_' + Date.now() + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Foto exportada ✓');
  }, 'image/png', 0.95);
});

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// ============================================================
// PWA — registro de service worker
// ============================================================
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ============================================================
// INIT
// ============================================================
renderPresetGrid();
