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
  },
  {
    id:'sepia', name:'SEPIA', swatch:'#6b4a2f',
    v:{ brightness:2, contrast:10, saturation:-65, hue:6, sharpen:0,
        temp:38, tint:-8, fade:20, vignette:26, shadowtone:8,
        grain:22, chroma:0, scanlines:0, bloom:10, shadowgrain:8 }
  },
  {
    id:'noventas', name:"NOSTALGIA 90'S", swatch:'#8a6a3f',
    v:{ brightness:4, contrast:14, saturation:14, hue:-4, sharpen:0,
        temp:14, tint:-8, fade:14, vignette:16, shadowtone:22,
        grain:38, chroma:16, scanlines:20, bloom:16, shadowgrain:16 }
  },
  {
    id:'tecnicolor', name:'TECNICOLOR', swatch:'#a83232',
    v:{ brightness:2, contrast:24, saturation:24, hue:0, sharpen:6,
        temp:6, tint:-2, fade:2, vignette:14, shadowtone:12,
        grain:8, chroma:0, scanlines:0, bloom:10, shadowgrain:0 }
  }
];

let customPresets = [];
try { customPresets = JSON.parse(localStorage.getItem('grano_custom_presets') || '[]'); } catch(e){ customPresets = []; }
let activePresetId = null;

// ---- foto de muestra para previsualizar los presets en la grilla ----
// Se carga una sola vez, achicada a resolución de miniatura (liviana), y se
// reutiliza para renderizar cada preset con sus propios ajustes aplicados.
const THUMB_DIM = 160;
let sampleCanvas = null;
const sampleImg = new Image();
sampleImg.onload = () => {
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = THUMB_DIM;
  sampleCanvas.height = THUMB_DIM;
  const sctx = sampleCanvas.getContext('2d');
  const s = Math.min(sampleImg.naturalWidth, sampleImg.naturalHeight);
  const sx = (sampleImg.naturalWidth - s) / 2;
  const sy = (sampleImg.naturalHeight - s) / 2;
  sctx.drawImage(sampleImg, sx, sy, s, s, 0, 0, THUMB_DIM, THUMB_DIM);
  renderPresetGrid();
};
sampleImg.src = 'assets/sample.jpg';

function generatePresetThumbnail(vObj){
  if (!sampleCanvas) return null;
  const st = { ...DEFAULT_STATE, ...vObj };
  const thumb = document.createElement('canvas');
  renderFilteredToCanvas(thumb, sampleCanvas, st);
  return thumb;
}

// ============================================================
// CARGA DE IMAGEN
// ============================================================
document.getElementById('btn-load').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

// Tocar la pantalla (cuando no hay foto cargada aún) también dispara la carga.
// Una vez que hay foto, el tap-catcher se desactiva para no interferir con
// el color-picker ni con gestos sobre la imagen.
const tapCatcher = document.getElementById('tap-catcher');
tapCatcher.addEventListener('click', () => {
  if (sourceCanvas) return; // ya hay foto, no interceptar
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
  tapCatcher.style.pointerEvents = 'none';
  document.getElementById('btn-export').classList.remove('is-disabled');

  state = { ...DEFAULT_STATE };
  syncSlidersFromState();
  clearPopColorUI();
  scheduleRender();
  if (typeof setSheetPos === 'function') setSheetPos('semi', true);
  if (typeof resetZoomOnNewImage === 'function') resetZoomOnNewImage();
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
  renderFilteredToCanvas(canvas, sourceCanvas, state);
}

// ---- pipeline genérico, reutilizado tanto para el render principal como
// para las miniaturas de presets (mismo motor, cualquier canvas de entrada/salida) ----
function renderFilteredToCanvas(destCanvas, srcCanvas, st){
  const w = srcCanvas.width, h = srcCanvas.height;
  if (destCanvas.width !== w) destCanvas.width = w;
  if (destCanvas.height !== h) destCanvas.height = h;
  const dctx = destCanvas.getContext('2d');

  // 1. Filtros CSS-nativos (rápidos, aceleración por GPU): brillo/contraste/saturación/hue
  const b = 100 + st.brightness;          // 0..200
  const c = 100 + st.contrast;            // 0..200
  const s = 100 + st.saturation;          // 0..200
  const hueDeg = st.hue;

  dctx.save();
  dctx.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%) hue-rotate(${hueDeg}deg)`;
  dctx.clearRect(0,0,w,h);
  dctx.drawImage(srcCanvas, 0, 0);
  dctx.restore();
  dctx.filter = 'none';

  // 2. A partir de acá trabajamos por pixel para: temp/tint, fade, shadowtone,
  //    color-pop, grain, chroma shift. Si ninguno de estos ajustes está activo
  //    (caso muy común: solo brillo/contraste/saturación/matiz, que ya se
  //    resolvieron arriba con el filtro CSS por GPU) nos salteamos por completo
  //    esta pasada por pixel — es la que más pesa y la que hacía sentir lentos
  //    a los sliders básicos mientras se arrastraban.
  const needsPixelPass = st.temp !== 0 || st.tint !== 0 || st.fade > 0 ||
    st.shadowtone > 0 || (st.colorpop && st.popColor) ||
    st.grain > 0 || st.chroma > 0 || st.shadowgrain > 0;

  if (needsPixelPass){
    let imgData = dctx.getImageData(0, 0, w, h);
    applyPixelPipeline(imgData, w, h, st);
    dctx.putImageData(imgData, 0, 0);
  }

  // 3. Nitidez (unsharp mask): más pesado, así que solo corre si está en uso
  if (st.sharpen > 0) applySharpenCanvas(dctx, destCanvas, w, h, st.sharpen);

  // 4. Efectos que conviene hacer con canvas compositing (más baratos así)
  if (st.vignette > 0) applyVignetteCanvas(dctx, w, h, st.vignette);
  if (st.scanlines > 0) applyScanlinesCanvas(dctx, w, h, st.scanlines);
  if (st.bloom > 0) applyBloomCanvas(dctx, destCanvas, w, h, st.bloom);
}

function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

function applyPixelPipeline(imgData, w, h, st){
  const data = imgData.data;
  const len = data.length;

  const temp = st.temp;               // -100..100
  const tint = st.tint;                // -100..100 (negativo=verde, positivo=magenta)
  const fade = st.fade / 100;          // 0..1
  const shadowtone = st.shadowtone / 100; // 0..1
  const grainAmt = st.grain / 100;
  const chromaAmt = st.chroma;
  const shadowGrainAmt = st.shadowgrain / 100;

  const popActive = st.colorpop && st.popColor;
  let pr=0, pg=0, pb=0, tolerance=0, feather=0, popBoost=0;
  if (popActive){
    pr = st.popColor.r; pg = st.popColor.g; pb = st.popColor.b;
    tolerance = st.tolerance;
    feather = st.feather;
    popBoost = st.popBoost / 100;
  }

  // fade lift: sube el piso de negros y baja levemente el techo de blancos (look "film")
  const liftLo = fade * 28;
  const liftHi = 255 - fade * 14;
  const liftRange = liftHi - liftLo;

  // chroma shift: desplazamiento horizontal de canal R y B (glitch/analógico sutil)
  const shiftPx = Math.round((chromaAmt / 100) * 4);

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

function applyVignetteCanvas(ctxRef, w, h, amount){
  const grad = ctxRef.createRadialGradient(
    w/2, h/2, Math.min(w,h) * 0.25,
    w/2, h/2, Math.max(w,h) * 0.72
  );
  const a = (amount/100) * 0.85;
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${a})`);
  ctxRef.save();
  ctxRef.fillStyle = grad;
  ctxRef.fillRect(0,0,w,h);
  ctxRef.restore();
}

function applyScanlinesCanvas(ctxRef, w, h, amount){
  const a = (amount/100) * 0.35;
  ctxRef.save();
  ctxRef.globalAlpha = a;
  ctxRef.fillStyle = '#000';
  for (let y = 0; y < h; y += 3){
    ctxRef.fillRect(0, y, w, 1);
  }
  ctxRef.restore();
}

function applyBloomCanvas(ctxRef, canvasRef, w, h, amount){
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.filter = `blur(${Math.round(4 + amount/8)}px) brightness(140%)`;
  octx.drawImage(canvasRef, 0, 0);
  ctxRef.save();
  ctxRef.globalAlpha = clamp(amount/100, 0, 1) * 0.45;
  ctxRef.globalCompositeOperation = 'screen';
  ctxRef.drawImage(off, 0, 0);
  ctxRef.restore();
}

// Nitidez real (unsharp mask): se genera una versión desenfocada (blur por GPU,
// barato) y se suma la diferencia respecto a la original, amplificada. Solo se
// llama cuando sharpen > 0, así no afecta el rendimiento del resto de sliders.
function applySharpenCanvas(ctxRef, canvasRef, w, h, amount){
  const radius = 1 + (amount / 100) * 2.2;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.filter = `blur(${radius}px)`;
  octx.drawImage(canvasRef, 0, 0);

  const sharp = ctxRef.getImageData(0, 0, w, h);
  const blurred = octx.getImageData(0, 0, w, h);
  const sd = sharp.data, bd = blurred.data;
  const k = (amount / 100) * 1.8;
  for (let i = 0; i < sd.length; i += 4){
    sd[i]   = clamp(sd[i]   + (sd[i]   - bd[i])   * k, 0, 255);
    sd[i+1] = clamp(sd[i+1] + (sd[i+1] - bd[i+1]) * k, 0, 255);
    sd[i+2] = clamp(sd[i+2] + (sd[i+2] - bd[i+2]) * k, 0, 255);
  }
  ctxRef.putImageData(sharp, 0, 0);
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

  function commitValue(v){
    v = Math.round(clamp(v, parseFloat(input.min), parseFloat(input.max)));
    input.value = v;
    state[key] = v;
    label.textContent = fmt(v);
    activePresetId = null;
    markCustom();
    if (sourceCanvas) scheduleRender();
  }

  input.addEventListener('input', () => {
    commitValue(parseInt(input.value, 10));
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

// ---- reset individual por control: toca el botón ↺ junto a cada slider
// para devolver SOLO ese ajuste a su valor por defecto, sin afectar los demás ----
function resetSingleSlider(key){
  const def = sliderDefs.find(d => d[2] === key);
  if (!def) return;
  const [inputId, labelId, , fmt] = def;
  const defaultVal = DEFAULT_STATE[key];
  state[key] = defaultVal;
  document.getElementById(inputId).value = defaultVal;
  document.getElementById(labelId).textContent = fmt(defaultVal);
  activePresetId = null;
  markCustom();
  if (sourceCanvas) scheduleRender();
}

document.querySelectorAll('.slider-reset').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSingleSlider(btn.dataset.key);
  });
});

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
    // si el sheet está casi totalmente colapsado, lo subimos un poco para
    // que se alcancen a ver los sliders del panel recién elegido
    const { max } = getBounds();
    if (currentTranslate > max - 40) setSheetPos('semi', true);
  });
});

// ============================================================
// PRESETS UI
// ============================================================
function buildPresetCard(p, isCustom){
  const card = document.createElement('div');
  card.className = 'preset-card' + (isCustom ? ' custom' : '') + (activePresetId === p.id ? ' active' : '');

  const thumb = generatePresetThumbnail(p.v);
  if (thumb){
    card.appendChild(thumb);
  } else {
    // la foto de muestra todavía no cargó: mostramos el color plano como placeholder
    const fallback = document.createElement('div');
    fallback.className = 'swatch-fallback';
    fallback.style.background = p.swatch;
    card.appendChild(fallback);
  }

  const label = document.createElement('span');
  label.textContent = p.name;
  card.appendChild(label);

  if (isCustom){
    const del = document.createElement('div');
    del.className = 'del';
    del.textContent = '✕';
    card.appendChild(del);
    card.addEventListener('click', (e) => {
      if (e.target === del){
        e.stopPropagation();
        deleteCustomPreset(p.id);
        return;
      }
      applyPreset(p);
    });
  } else {
    card.addEventListener('click', () => applyPreset(p));
  }

  return card;
}

function renderPresetGrid(){
  const grid = document.getElementById('preset-grid');
  grid.innerHTML = '';
  BUILTIN_PRESETS.forEach(p => grid.appendChild(buildPresetCard(p, false)));
  customPresets.forEach(p => grid.appendChild(buildPresetCard(p, true)));
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
  const finalName = name.toUpperCase().slice(0,18);

  const existing = customPresets.find(p => p.name === finalName);
  if (existing){
    // ya existe un preset custom con ese nombre: pedimos confirmación antes
    // de pisarlo, en vez de crear un duplicado silencioso o sobrescribir sin avisar
    pendingOverwriteName = finalName;
    document.getElementById('modal-scrim').classList.remove('show');
    document.getElementById('modal-overwrite-scrim').classList.add('show');
    return;
  }

  saveNewPreset(finalName);
});

let pendingOverwriteName = null;

document.getElementById('modal-overwrite-cancel').addEventListener('click', () => {
  document.getElementById('modal-overwrite-scrim').classList.remove('show');
  pendingOverwriteName = null;
});

document.getElementById('modal-overwrite-confirm').addEventListener('click', () => {
  if (!pendingOverwriteName) return;
  const idx = customPresets.findIndex(p => p.name === pendingOverwriteName);
  if (idx !== -1){
    const swatchColor = approximatePresetColor();
    customPresets[idx] = { ...customPresets[idx], swatch: swatchColor, v: extractCurrentAdjustments() };
    localStorage.setItem('grano_custom_presets', JSON.stringify(customPresets));
    activePresetId = customPresets[idx].id;
    renderPresetGrid();
    showToast('Preset sobrescrito');
    document.querySelector('.tab[data-panel="presets"]').click();
  }
  document.getElementById('modal-overwrite-scrim').classList.remove('show');
  pendingOverwriteName = null;
});

function saveNewPreset(finalName){
  const id = 'custom_' + Date.now();
  const swatchColor = approximatePresetColor();
  const newPreset = { id, name: finalName, swatch: swatchColor, v: extractCurrentAdjustments() };
  customPresets.push(newPreset);
  localStorage.setItem('grano_custom_presets', JSON.stringify(customPresets));
  activePresetId = id;
  renderPresetGrid();
  document.getElementById('modal-scrim').classList.remove('show');
  showToast('Preset guardado');
  document.querySelector('.tab[data-panel="presets"]').click();
}

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
  // dejamos ver la foto completa mientras se elige el color, sin zoom aplicado
  if (typeof resetZoom === 'function') resetZoom(true);
  setSheetPos('collapsed', true);
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
  setSheetPos('semi', true);
});

// ============================================================
// ZOOM (pellizco) Y PAN sobre la foto
// ============================================================
// Aplicamos transform CSS al canvas ya renderizado (no volvemos a correr el
// pipeline de filtros en cada frame), así el gesto es fluido incluso en un
// celular modesto. El pipeline de filtros sigue trabajando siempre sobre la
// resolución completa de trabajo; el zoom es puramente visual.
const zoomState = { scale: 1, x: 0, y: 0 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const activePointers = new Map(); // pointerId -> {x, y}
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchStartMid = { x: 0, y: 0 };
let pinchStartOffset = { x: 0, y: 0 };
let panStart = null; // {x, y} del único dedo, para pan de un dedo cuando ya hay zoom aplicado

function applyCanvasTransform(){
  canvas.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
}

function clampPan(){
  // evita que se pueda arrastrar la foto tan lejos que quede toda fuera de vista;
  // el margen permitido crece con el nivel de zoom actual
  const rect = canvas.getBoundingClientRect();
  const maxOffsetX = (rect.width * (zoomState.scale - 1)) / 2 + rect.width * 0.15;
  const maxOffsetY = (rect.height * (zoomState.scale - 1)) / 2 + rect.height * 0.15;
  zoomState.x = clamp(zoomState.x, -maxOffsetX, maxOffsetX);
  zoomState.y = clamp(zoomState.y, -maxOffsetY, maxOffsetY);
}

function resetZoom(animate = true){
  zoomState.scale = 1; zoomState.x = 0; zoomState.y = 0;
  canvas.style.transition = animate ? 'transform 0.25s ease' : 'none';
  applyCanvasTransform();
  setTimeout(() => { canvas.style.transition = 'none'; }, animate ? 260 : 0);
}

function dist(p1, p2){
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}
function midpoint(p1, p2){
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!sourceCanvas || pickingActive) return;
  canvas.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2){
    const pts = Array.from(activePointers.values());
    pinchStartDist = dist(pts[0], pts[1]);
    pinchStartScale = zoomState.scale;
    pinchStartMid = midpoint(pts[0], pts[1]);
    pinchStartOffset = { x: zoomState.x, y: zoomState.y };
    panStart = null;
  } else if (activePointers.size === 1 && zoomState.scale > 1){
    // con un solo dedo y ya habiendo zoom aplicado, permitimos arrastrar (pan)
    panStart = { x: e.clientX, y: e.clientY, offsetX: zoomState.x, offsetY: zoomState.y };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 2){
    const pts = Array.from(activePointers.values());
    const newDist = dist(pts[0], pts[1]);
    const newMid = midpoint(pts[0], pts[1]);
    const ratio = newDist / (pinchStartDist || 1);
    zoomState.scale = clamp(pinchStartScale * ratio, MIN_ZOOM, MAX_ZOOM);
    // desplazamos según el movimiento del punto medio entre los dos dedos,
    // para que el pellizco sienta natural (zoom centrado donde están los dedos)
    zoomState.x = pinchStartOffset.x + (newMid.x - pinchStartMid.x);
    zoomState.y = pinchStartOffset.y + (newMid.y - pinchStartMid.y);
    clampPan();
    applyCanvasTransform();
  } else if (activePointers.size === 1 && panStart){
    zoomState.x = panStart.offsetX + (e.clientX - panStart.x);
    zoomState.y = panStart.offsetY + (e.clientY - panStart.y);
    clampPan();
    applyCanvasTransform();
  }
});

function releasePointer(e){
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  if (activePointers.size === 0) panStart = null;
  // si queda un solo dedo tras soltar uno de los dos del pellizco, reiniciamos
  // referencia de pan para que no salte
  if (activePointers.size === 1 && zoomState.scale > 1){
    const remaining = Array.from(activePointers.values())[0];
    panStart = { x: remaining.x, y: remaining.y, offsetX: zoomState.x, offsetY: zoomState.y };
  }
  // si el zoom quedó prácticamente en 1, lo dejamos exacto para evitar
  // un desenfoque sutil por escalado no entero
  if (zoomState.scale < 1.03 && activePointers.size === 0){
    resetZoom(true);
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);

// doble tap para resetear el zoom rápidamente
let lastTapTime = 0;
canvas.addEventListener('pointerup', (e) => {
  if (pickingActive || activePointers.size > 0) return;
  const now = Date.now();
  if (now - lastTapTime < 300 && zoomState.scale > 1){
    resetZoom(true);
  }
  lastTapTime = now;
});

// al cargar una foto nueva, el zoom se resetea
function resetZoomOnNewImage(){ resetZoom(false); }

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
// BOTTOM SHEET ARRASTRABLE — posición libre y continua
// ============================================================
// El usuario puede dejar el panel en cualquier altura intermedia arrastrando
// el handle; no hay 3 posiciones fijas. Límites: nunca puede subir por
// encima del header, y siempre queda un mínimo visible abajo para poder
// volver a agarrarlo. El bottombar (cargar/guardar/exportar) vive AFUERA
// del sheet, fijo, para estar siempre accesible sin importar dónde quede el panel.
const sheetEl = document.getElementById('sheet');
const handleArea = document.getElementById('sheet-handle-area');
const headerEl = document.querySelector('header');
const bottombarEl = document.getElementById('bottombar');
const panelAreaEl = document.getElementById('panel-area');

// medimos la altura real del bottombar (varía según safe-area-inset-bottom
// del dispositivo) y la exponemos como variable CSS para que el sheet
// reserve exactamente ese espacio y su scroll interno no quede tapado
function updateBottombarHeightVar(){
  const h = bottombarEl.getBoundingClientRect().height;
  if (h > 0) document.documentElement.style.setProperty('--bottombar-height', h + 'px');
}
updateBottombarHeightVar();
window.addEventListener('resize', updateBottombarHeightVar);

let sheetHeight = 0;
let dragStartY = 0;
let dragStartTranslate = 0;
let dragging = false;
let currentTranslate = 0; // píxeles de traslación actual (0 = sheet totalmente arriba)

const MIN_VISIBLE = 96; // px que SIEMPRE deben quedar visibles abajo (handle + tabs), para poder volver a agarrar el sheet

function getBounds(){
  sheetHeight = sheetEl.getBoundingClientRect().height;
  const headerBottom = headerEl.getBoundingClientRect().bottom;
  // el sheet nunca puede subir tanto que su borde superior quede por encima
  // del borde inferior del header (así el header siempre queda visible y
  // el usuario nunca pierde la referencia de arriba)
  const minTranslate = headerBottom;
  const maxTranslate = sheetHeight - MIN_VISIBLE;
  return { min: minTranslate, max: maxTranslate };
}

function setSheetTranslate(px, animate = false){
  const { min, max } = getBounds();
  currentTranslate = Math.max(min, Math.min(max, px));
  sheetEl.classList.toggle('animated', animate);
  sheetEl.style.transform = `translateY(${currentTranslate}px)`;
  updatePanelAreaHeight();
}

// El sheet se mueve con transform (rápido, sin recalcular layout), pero eso
// significa que su caja interna sigue teniendo siempre la misma altura total
// aunque quede parcialmente tapado por el bottombar al arrastrarlo hacia abajo.
// Sin esto, el contenido "de más" queda escondido fuera de la parte visible
// en vez de quedar disponible con scroll. Por eso recalculamos la altura
// REAL y visible de #panel-area en cada movimiento, así el overflow-y:auto
// que ya tiene siempre puede scrollear justo lo que sobra.
function updatePanelAreaHeight(){
  if (!panelAreaEl) return;
  const bottombarHeight = bottombarEl.getBoundingClientRect().height;
  const visibleBottom = window.innerHeight - bottombarHeight;
  const panelTop = panelAreaEl.getBoundingClientRect().top;
  const h = Math.max(0, visibleBottom - panelTop);
  panelAreaEl.style.height = h + 'px';
}

// posiciones con nombre, usadas solo para gestos puntuales (auto-expandir al
// tocar un tab, colapsar al elegir color) — el usuario igual puede dejarlo en
// cualquier punto intermedio arrastrando libremente
function setSheetPos(pos, animate = true){
  const { min, max } = getBounds();
  let target;
  if (pos === 'expanded') target = min;
  else if (pos === 'collapsed') target = max;
  else target = min + (max - min) * 0.58; // semi: un poco más cerca de colapsado que de expandido
  setSheetTranslate(target, animate);
}

function sheetDragStart(clientY){
  dragging = true;
  dragStartY = clientY;
  dragStartTranslate = currentTranslate;
  sheetEl.classList.remove('animated');
}
function sheetDragMove(clientY){
  if (!dragging) return;
  setSheetTranslate(dragStartTranslate + (clientY - dragStartY), false);
}
function sheetDragEnd(){
  dragging = false;
  // se queda exactamente donde el usuario lo soltó: posición libre, sin snap
}

handleArea.addEventListener('pointerdown', (e) => {
  handleArea.setPointerCapture(e.pointerId);
  sheetDragStart(e.clientY);
});
handleArea.addEventListener('pointermove', (e) => sheetDragMove(e.clientY));
handleArea.addEventListener('pointerup', sheetDragEnd);
handleArea.addEventListener('pointercancel', sheetDragEnd);

window.addEventListener('resize', () => setSheetTranslate(currentTranslate, false));

// posición inicial: semi-abierto
setSheetPos('semi', false);


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
