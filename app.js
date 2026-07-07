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
let noiseTileCache = {};       // cache de texturas de ruido ya generadas, por tamaño (w x h)

const MAX_DIM = 1600; // resolución de trabajo (liviano en celus modestos)

// ---- vista previa liviana mientras se arrastra un slider ----
// Recalcular el pipeline de filtros pixel-por-pixel a resolución completa en
// CADA evento 'input' (que dispara decenas de veces por segundo mientras se
// arrastra) es lo que hacía sentir lentos los knobs, sobre todo con ruido o
// color pop activos. Mientras se está arrastrando, renderizamos sobre una
// copia mucho más chica de la foto y la escalamos al tamaño real (el canvas
// visible nunca cambia de resolución, así que no hay saltos de layout). Al
// soltar el slider, se dispara un render final a resolución completa.
const DRAG_PREVIEW_MAX = 640;
let dragPreviewCanvas = null;
let previewResultCanvas = null;
let isAdjusting = false;

function buildDragPreview(){
  if (!sourceCanvas) return;
  const scale = Math.min(1, DRAG_PREVIEW_MAX / Math.max(workW, workH));
  const pw = Math.max(1, Math.round(workW * scale));
  const ph = Math.max(1, Math.round(workH * scale));
  dragPreviewCanvas = document.createElement('canvas');
  dragPreviewCanvas.width = pw;
  dragPreviewCanvas.height = ph;
  dragPreviewCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, pw, ph);
  previewResultCanvas = document.createElement('canvas');
}

// ---------------- ESTADO DE FILTROS ----------------
const DEFAULT_STATE = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0, sharpen: 0,
  temp: 0, tint: 0, fade: 0, vignette: 0, shadowtone: 0,
  grain: 0, chroma: 0, scanlines: 0, bloom: 0, shadowgrain: 0,
  colorpop: false, popColor: null, tolerance: 40, feather: 20, popBoost: 20,
  tintOn: false, tintColor: null, tintBlend: 'multiply', tintOpacity: 35
};
let state = { ...DEFAULT_STATE };

// ---------------- PRESETS ----------------
// Perfiles derivados del look de referencia: negros hundidos, grano visible,
// tinte frío-verdoso en sombras, contraste alto sin quemar blancos.
const BUILTIN_PRESETS = [
  {
    // ex "NOCTURNO": misma base fría de cripta, con más contraste y un velo
    // gris-azulado (el "aire" húmedo de una cripta) sobre las sombras ya
    // azuladas que tenía el original.
    id:'cripta', name:'CRIPTA', swatch:'#3a4a5c',
    v:{ brightness:-8, contrast:26, saturation:-18, hue:0, sharpen:10,
        temp:-16, tint:8, fade:8, vignette:38, shadowtone:58,
        grain:35, chroma:8, scanlines:0, bloom:10, shadowgrain:42,
        tintOn:true, tintColor:{r:70,g:88,b:108}, tintBlend:'soft-light', tintOpacity:16 }
  },
  {
    // ex "SOMBRA MUDA": bajado el contraste a propósito (el original era
    // duro) para el ánimo sobrio/conventual, manteniendo sombras profundas.
    id:'monasterio', name:'MONASTERIO', swatch:'#4a463e',
    v:{ brightness:-14, contrast:10, saturation:-38, hue:0, sharpen:2,
        temp:-6, tint:6, fade:10, vignette:34, shadowtone:62,
        grain:22, chroma:2, scanlines:0, bloom:4, shadowgrain:30 }
  },
  {
    // ex "CINE TEAL": mismo teal cinematográfico, bloom subido para que las
    // luces altas "sangren" como vitral, con un velo de luz coloreada.
    id:'catedral', name:'CATEDRAL', swatch:'#3f6e68',
    v:{ brightness:0, contrast:20, saturation:-5, hue:-10, sharpen:8,
        temp:-16, tint:14, fade:6, vignette:28, shadowtone:70,
        grain:12, chroma:6, scanlines:0, bloom:32, shadowgrain:18,
        tintOn:true, tintColor:{r:110,g:150,b:150}, tintBlend:'screen', tintOpacity:12 }
  },
  {
    // ex "RUINA": misma desaturación fuerte y grano pesado, sumando el
    // tono verdoso-sucio de descomposición.
    id:'plaga', name:'PLAGA', swatch:'#5a6238',
    v:{ brightness:-12, contrast:26, saturation:-48, hue:8, sharpen:12,
        temp:-2, tint:10, fade:10, vignette:42, shadowtone:22,
        grain:55, chroma:10, scanlines:0, bloom:4, shadowgrain:36,
        tintOn:true, tintColor:{r:96,g:104,b:56}, tintBlend:'multiply', tintOpacity:18 }
  },
  {
    // ex "SEPIA": mismo cálido desvanecido, ahora con el sepia también como
    // velo de color (además del viraje de temperatura), más notorio.
    id:'pergamino', name:'PERGAMINO', swatch:'#6b4a2f',
    v:{ brightness:2, contrast:10, saturation:-62, hue:6, sharpen:0,
        temp:36, tint:-8, fade:24, vignette:24, shadowtone:8,
        grain:20, chroma:0, scanlines:0, bloom:10, shadowgrain:8,
        tintOn:true, tintColor:{r:196,g:158,b:94}, tintBlend:'multiply', tintOpacity:16 }
  },
  {
    // ex "VHS FRÍO": el degradado analógico frío queda perfecto para un
    // "interrogatorio" — subido el contraste y los rastros RGB (con el
    // arreglo del bug, ahora sí conviven con la temperatura y el tinte).
    id:'inquisidor', name:'INQUISIDOR', swatch:'#28413d',
    v:{ brightness:-6, contrast:24, saturation:-25, hue:-6, sharpen:0,
        temp:-22, tint:10, fade:12, vignette:30, shadowtone:60,
        grain:42, chroma:26, scanlines:38, bloom:14, shadowgrain:32 }
  },
  {
    // ex "ANALÓGICO": grano subido para textura de papel viejo, más cálido
    // y con el desvanecido bien marcado.
    id:'manuscrito', name:'MANUSCRITO', swatch:'#3a3630',
    v:{ brightness:2, contrast:14, saturation:-14, hue:4, sharpen:0,
        temp:16, tint:-4, fade:30, vignette:20, shadowtone:15,
        grain:62, chroma:5, scanlines:0, bloom:8, shadowgrain:18 }
  },
  {
    // ex "NOSTALGIA 90'S": la saturación/matiz alta ahora leen como colores
    // "transmutados", con un velo verde-dorado tipo laboratorio alquímico.
    id:'alquimia', name:'ALQUIMIA', swatch:'#5a8a5f',
    v:{ brightness:6, contrast:22, saturation:50, hue:18, sharpen:0,
        temp:8, tint:-6, fade:2, vignette:16, shadowtone:14,
        grain:16, chroma:16, scanlines:0, bloom:18, shadowgrain:8,
        tintOn:true, tintColor:{r:100,g:170,b:110}, tintBlend:'color-dodge', tintOpacity:10 }
  },
  {
    // ex "TECNICOLOR": mismo punch saturado, con un dorado suave encima
    // como si fuera un objeto sagrado iluminado por velas.
    id:'reliquia', name:'RELIQUIA', swatch:'#c9a05a',
    v:{ brightness:4, contrast:26, saturation:28, hue:0, sharpen:6,
        temp:10, tint:-2, fade:0, vignette:12, shadowtone:10,
        grain:6, chroma:0, scanlines:0, bloom:22, shadowgrain:0,
        tintOn:true, tintColor:{r:214,g:176,b:96}, tintBlend:'overlay', tintOpacity:12 }
  },
  {
    id:'candelabro', name:'CANDELABRO', swatch:'#c07a34',
    v:{ brightness:-4, contrast:16, saturation:-8, hue:2, sharpen:0,
        temp:30, tint:-6, fade:8, vignette:44, shadowtone:32,
        grain:14, chroma:0, scanlines:0, bloom:34, shadowgrain:10,
        tintOn:true, tintColor:{r:214,g:132,b:60}, tintBlend:'overlay', tintOpacity:20 }
  },
  {
    id:'ceniza', name:'CENIZA', swatch:'#6e6a62',
    v:{ brightness:-10, contrast:18, saturation:-80, hue:0, sharpen:8,
        temp:-2, tint:0, fade:6, vignette:30, shadowtone:20,
        grain:48, chroma:4, scanlines:0, bloom:2, shadowgrain:26,
        tintOn:true, tintColor:{r:128,g:126,b:120}, tintBlend:'soft-light', tintOpacity:20 }
  },
  {
    id:'vispera', name:'VÍSPERA', swatch:'#1a2440',
    v:{ brightness:-22, contrast:20, saturation:-20, hue:0, sharpen:0,
        temp:-30, tint:12, fade:2, vignette:60, shadowtone:50,
        grain:24, chroma:14, scanlines:12, bloom:8, shadowgrain:22,
        tintOn:true, tintColor:{r:20,g:30,b:60}, tintBlend:'multiply', tintOpacity:10 }
  },
  {
    id:'necropolis', name:'NECRÓPOLIS', swatch:'#1a1a1a',
    v:{ brightness:-6, contrast:52, saturation:-96, hue:0, sharpen:16,
        temp:-14, tint:4, fade:0, vignette:36, shadowtone:12,
        grain:60, chroma:0, scanlines:0, bloom:0, shadowgrain:14 }
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
  // El estado de color pop se resetea arriba (colorpop:false), pero el
  // interruptor visual no se apagaba solo: quedaba "prendido" en pantalla
  // aunque el filtro ya no estuviera activo, lo que además confundía si
  // después se aplicaba un preset (parecía que el preset "no hacía nada").
  swColorpop.classList.remove('on');
  crosshair.style.display = 'none';
  noiseTileCache = {}; // la foto cambió: cualquier textura de ruido cacheada quedó obsoleta
  buildDragPreview();
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
  if (isAdjusting && dragPreviewCanvas){
    // Filtramos la copia chica (rápido) y la estiramos sobre el canvas visible,
    // que mantiene siempre su resolución real (workW x workH): no hay salto
    // de nitidez ni de layout, solo se ve un poco menos definido mientras
    // se arrastra el knob, y vuelve a full-res apenas se suelta.
    renderFilteredToCanvas(previewResultCanvas, dragPreviewCanvas, state);
    ctx.clearRect(0, 0, workW, workH);
    ctx.drawImage(previewResultCanvas, 0, 0, workW, workH);
  } else {
    renderFilteredToCanvas(canvas, sourceCanvas, state);
  }
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
  // El filtro de color va antes de la viñeta: así la viñeta enmarca por
  // encima del color, en vez de quedar "lavada" por él.
  if (st.tintOn && st.tintColor && st.tintOpacity > 0) applyColorOverlayCanvas(dctx, w, h, st);
  if (st.vignette > 0) applyVignetteCanvas(dctx, w, h, st.vignette);
  if (st.scanlines > 0) applyScanlinesCanvas(dctx, w, h, st.scanlines);
  if (st.bloom > 0) applyBloomCanvas(dctx, destCanvas, w, h, st.bloom);
}

// Filtro de color tipo "papel celofán": una capa de color plana compositada
// sobre toda la imagen con un modo de fusión y opacidad ajustables. Al ser
// un solo fillRect con blend mode nativo del canvas (acelerado por el propio
// navegador, no una pasada por pixel en JS), es prácticamente gratis sin
// importar la resolución de la foto — se puede sumar sin miedo a que pese.
function applyColorOverlayCanvas(ctxRef, w, h, st){
  ctxRef.save();
  ctxRef.globalAlpha = clamp(st.tintOpacity / 100, 0, 1);
  ctxRef.globalCompositeOperation = st.tintBlend || 'multiply';
  ctxRef.fillStyle = `rgb(${st.tintColor.r},${st.tintColor.g},${st.tintColor.b})`;
  ctxRef.fillRect(0, 0, w, h);
  ctxRef.restore();
}

function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

// h en grados (0-360), s y l en 0..1. Implementación estándar sin trigonometría,
// barata de llamar por pixel.
function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min){
    h = 0; s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

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
  let pHue=0, pSat=0, pLight=0, pIsGray=false;
  if (popActive){
    pr = st.popColor.r; pg = st.popColor.g; pb = st.popColor.b;
    tolerance = st.tolerance;
    feather = st.feather;
    popBoost = st.popBoost / 100;
    const phsl = rgbToHsl(pr, pg, pb);
    pHue = phsl[0]; pSat = phsl[1]; pLight = phsl[2];
    pIsGray = pSat < 0.12; // el color elegido es prácticamente gris/blanco/negro: no tiene matiz confiable
  }

  // fade lift: sube el piso de negros y baja levemente el techo de blancos (look "film")
  const liftLo = fade * 28;
  const liftHi = 255 - fade * 14;
  const liftRange = liftHi - liftLo;

  // chroma shift: desplazamiento horizontal de canal R y B (glitch/analógico sutil)
  const shiftPx = Math.round((chromaAmt / 100) * 4);

  // Textura de ruido: antes se llamaba Math.random() por cada canal de cada
  // pixel, en cada frame — con fotos de ~2.5 megapíxeles eso son millones de
  // llamadas por render, y era el principal motivo de que todo se sintiera
  // lento apenas se subía "ruido/grano". Ahora se genera UNA vez por tamaño
  // de imagen y se reutiliza; el patrón queda fijo pero es indistinguible a
  // simple vista en una foto (no es un video), y el resultado es idéntico en
  // aspecto con una fracción del costo.
  const needsNoise = grainAmt > 0 || shadowGrainAmt > 0;
  const noiseTile = needsNoise ? getNoiseTile(w, h) : null;

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
      // Antes esto comparaba distancia RGB "en línea recta". El problema:
      // un rojo oscuro y un azul oscuro pueden quedar a una distancia parecida
      // a la de dos azules distintos, solo por tener luminosidad similar —
      // por eso se filtraba rojo aunque se hubiera elegido azul y bajado la
      // tolerancia al mínimo. Comparando por matiz (HSL) en cambio, el rojo y
      // el azul quedan lejísimos sin importar qué tan oscuros sean.
      let dist;
      if (pIsGray){
        const chsl = rgbToHsl(r, g, b);
        const dl = Math.abs(chsl[2] - pLight) * 100;
        const ds = chsl[1] * 100;
        dist = Math.sqrt(dl*dl + ds*ds);
      } else {
        const chsl = rgbToHsl(r, g, b);
        let dh = Math.abs(chsl[0] - pHue);
        if (dh > 180) dh = 360 - dh;
        const ds = Math.abs(chsl[1] - pSat) * 100;
        const dl = Math.abs(chsl[2] - pLight) * 100;
        // el matiz pesa mucho más: es lo que define "es este color o no";
        // sat/luminosidad solo afinan variantes más claras/oscuras del mismo color
        dist = Math.sqrt((dh*1.9)**2 + (ds*0.55)**2 + (dl*0.45)**2);
      }
      const maxDist = 4 + (tolerance / 100) * 78;
      const featherDist = feather * 1.1;
      let keep;
      if (dist <= maxDist) keep = 1;
      else if (dist <= maxDist + featherDist) keep = 1 - (dist - maxDist) / (featherDist || 1);
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
    if (needsNoise){
      const noise = noiseTile[i >> 2];
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

  // chroma shift (segunda pasada, usa como fuente una copia de la imagen YA
  // procesada por temp/tint/fade/etc — antes esta copia se tomaba ANTES de
  // ese bloque, así que el desplazamiento pisaba los canales R y B con los
  // valores originales sin editar. Resultado: con el shift activo (pasado
  // ~12 de "Rastros RGB"), la temperatura desaparecía por completo —dependía
  // 100% de R/B— y el tinte se veía "recortado" a la mitad de su efecto
  // —solo sobrevivía en G—. Ahora el desplazamiento parte de la imagen ya
  // graduada, y solo agrega el corrimiento de color encima.
  if (shiftPx > 0){
    const srcCopy = new Uint8ClampedArray(data);
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

// Genera (o reutiliza) una textura de ruido del tamaño exacto de la imagen
// que se está filtrando. Se cachea por tamaño porque se usa tanto para el
// render principal (workW x workH) como para las miniaturas de presets
// (160x160) y la vista previa de arrastre (más chica): cada una pide su
// propio tamaño una sola vez y después es gratis.
function getNoiseTile(w, h){
  const key = w + 'x' + h;
  let tile = noiseTileCache[key];
  if (!tile){
    tile = new Float32Array(w * h);
    for (let i = 0; i < tile.length; i++) tile[i] = (Math.random() - 0.5) * 255;
    noiseTileCache[key] = tile;
  }
  return tile;
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
  ['s-tintopacity','v-tintopacity','tintOpacity', v=>v],
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

  // Mientras el dedo/mouse sigue apretando el slider, renderizamos en baja
  // resolución (ver DRAG_PREVIEW_MAX más arriba); al soltar, un render final
  // a resolución completa. 'change' es el evento estándar de <input type=range>
  // que dispara justo al soltar, en todos los navegadores.
  input.addEventListener('pointerdown', () => { isAdjusting = true; });
  input.addEventListener('change', () => {
    isAdjusting = false;
    if (sourceCanvas) scheduleRender();
  });
});

function syncSlidersFromState(){
  sliderDefs.forEach(([inputId, labelId, key, fmt]) => {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    input.value = state[key];
    label.textContent = fmt(state[key]);
  });
  // Controles del filtro de color: no son sliders genéricos, se sincronizan
  // acá para que loadImage/applyPreset/reset los dejen siempre coherentes
  // con el estado (evita el mismo tipo de bug que tenía el switch de
  // color pop, que se quedaba "prendido" en pantalla sin reflejar el estado).
  swTint.classList.toggle('on', !!state.tintOn);
  tintBlendSelect.value = state.tintBlend || 'multiply';
  if (state.tintColor) setTintSwatchUI(state.tintColor.r, state.tintColor.g, state.tintColor.b);
  else clearTintSwatchUI();
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
  // Si el preset guardó su propia config de color pop (porque estaba activo
  // cuando se guardó), la usamos. Si no la tiene (presets de fábrica, o
  // presets viejos guardados antes de este arreglo), mantenemos el color pop
  // que el usuario tenga activo ahora mismo, para poder combinar un look con
  // el color que ya eligió.
  const hasOwnColorpop = p.v && Object.prototype.hasOwnProperty.call(p.v, 'colorpop');
  const popState = hasOwnColorpop
    ? { colorpop: p.v.colorpop, popColor: p.v.popColor, tolerance: p.v.tolerance, feather: p.v.feather, popBoost: p.v.popBoost }
    : { colorpop: state.colorpop, popColor: state.popColor, tolerance: state.tolerance, feather: state.feather, popBoost: state.popBoost };
  state = { ...DEFAULT_STATE, ...p.v, ...popState };
  syncSlidersFromState();
  // Sincronizar el interruptor y el swatch visual con lo que quedó en el
  // estado: antes esto no pasaba y el switch podía mostrar "apagado" (o
  // "prendido" de una sesión anterior) sin reflejar lo que el preset traía.
  swColorpop.classList.toggle('on', !!state.colorpop);
  if (state.popColor) setPopColor(state.popColor.r, state.popColor.g, state.popColor.b);
  else clearPopColorUI();
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
  // Antes esto SIEMPRE descartaba el color pop del preset guardado, incluso
  // si estaba activo y configurado en el momento de guardar — por eso el
  // preset "no hacía nada" con color pop: nunca se había guardado de verdad.
  // Ahora, si estaba activo, se guarda como parte del preset.
  if (colorpop && popColor){
    return { ...rest, colorpop, popColor, tolerance, feather, popBoost };
  }
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

document.getElementById('btn-pick-color-manual').addEventListener('click', () => {
  const start = state.popColor || { r: 168, g: 50, b: 50 };
  openColorModal('colorpop', start);
});

function setPopColor(r,g,b){
  state.popColor = { r, g, b };
  const sw = document.getElementById('cp-swatch');
  sw.classList.remove('empty');
  sw.style.background = `rgb(${r},${g},${b})`;
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
// FILTRO DE COLOR ("papel celofán") — toggle, rueda de color, modo de fusión
// ============================================================
const swTint = document.getElementById('sw-tint');
const tintBlendSelect = document.getElementById('tint-blend');

swTint.addEventListener('click', () => {
  state.tintOn = !state.tintOn;
  swTint.classList.toggle('on', state.tintOn);
  // Sin color elegido todavía, activar el switch no se ve: le damos un color
  // de arranque para que quede claro que ya está haciendo algo.
  if (state.tintOn && !state.tintColor) setTintColor(169, 129, 47);
  activePresetId = null;
  markCustom();
  if (sourceCanvas) scheduleRender();
});

document.getElementById('btn-pick-tint-color').addEventListener('click', () => {
  const start = state.tintColor || { r: 169, g: 129, b: 47 };
  openColorModal('tint', start);
});

tintBlendSelect.addEventListener('change', (e) => {
  state.tintBlend = e.target.value;
  activePresetId = null;
  markCustom();
  if (sourceCanvas) scheduleRender();
});

function setTintColor(r,g,b){
  state.tintColor = { r, g, b };
  setTintSwatchUI(r,g,b);
}
function setTintSwatchUI(r,g,b){
  const sw = document.getElementById('tint-swatch');
  sw.classList.remove('empty');
  sw.style.background = `rgb(${r},${g},${b})`;
}
function clearTintSwatchUI(){
  const sw = document.getElementById('tint-swatch');
  sw.classList.add('empty');
  sw.style.background = 'none';
}

// ============================================================
// BOTONES: reset, comparar, deshacer(simple), export
// ============================================================
document.getElementById('btn-reset').addEventListener('click', () => {
  state = { ...DEFAULT_STATE };
  activePresetId = null;
  syncSlidersFromState();
  swColorpop.classList.remove('on');
  clearPopColorUI();
  renderPresetGrid();
  if (sourceCanvas) scheduleRender();
  showToast('Ajustes reseteados');
});

let comparing = false;
const btnCompare = document.getElementById('btn-compare');
// Evita el menú contextual / vibración háptica de "mantener presionado" que
// el sistema (Android/Brave) dispara por defecto en un long-press.
btnCompare.addEventListener('contextmenu', (e) => e.preventDefault());
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

// ============================================================
// EXPORTAR — pide un nombre de archivo antes de descargar
// ============================================================
const exportModalScrim = document.getElementById('export-modal-scrim');
const exportNameInput = document.getElementById('export-name-input');

function sanitizeFilename(name){
  // saca caracteres problemáticos para nombres de archivo, conserva acentos/ñ
  return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

document.getElementById('btn-export').addEventListener('click', () => {
  if (!sourceCanvas) return;
  exportNameInput.value = 'herejia_' + Date.now();
  exportModalScrim.classList.add('show');
  setTimeout(() => { exportNameInput.focus(); exportNameInput.select(); }, 50);
});

function closeExportModal(){
  exportModalScrim.classList.remove('show');
}
document.getElementById('export-modal-cancel').addEventListener('click', closeExportModal);
exportModalScrim.addEventListener('click', (e) => {
  if (e.target === exportModalScrim) closeExportModal();
});

function doExport(){
  let name = sanitizeFilename(exportNameInput.value) || ('herejia_' + Date.now());
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Foto exportada ✓');
  }, 'image/png', 0.95);
  closeExportModal();
}
document.getElementById('export-modal-confirm').addEventListener('click', doExport);
exportNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doExport();
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
  if (animate){
    // Con una transición CSS en curso, medir el layout justo ahora todavía
    // devuelve la posición VIEJA (el navegador no aplicó el movimiento
    // todavía), así que panel-area se queda con una altura vieja — eso es
    // el "bloque marrón" que tapaba tolerancia/suavizado/intensidad hasta
    // que se arrastraba el sheet (lo cual forzaba un nuevo cálculo). Acá
    // forzamos ese recálculo apenas la transición realmente termina.
    sheetEl.addEventListener('transitionend', updatePanelAreaHeight, { once: true });
  }
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
// SELECTOR DE COLOR PROPIO — reemplaza el picker nativo de Android,
// que en algunos navegadores (Brave incluido) dibuja los sliders de
// Tono/Saturación/Valor en negro y no permite ajustar finamente el
// color ya elegido. Este modal usa un plano SV + slider de Tono +
// campo hex, todo con gradientes propios que sí se pintan siempre.
// ============================================================
const colorModalScrim = document.getElementById('color-modal-scrim');
const cmSv = document.getElementById('cm-sv');
const cmSvCursor = document.getElementById('cm-sv-cursor');
const cmHue = document.getElementById('cm-hue');
const cmHueThumb = document.getElementById('cm-hue-thumb');
const cmHex = document.getElementById('cm-hex');
const cmPreview = document.getElementById('cm-preview');
const cmSwatches = document.getElementById('cm-swatches');

// Paleta de sugerencias acorde a la estética de Herejía: dorado viejo,
// rojos sangre/óxido, verdes musgo, azules noche, huesos y sepias —
// nada de rojo/verde/azul/magenta puro tipo panel por defecto de Android.
const THEME_SWATCHES = [
  '#a9812f', // dorado grimorio (color de arranque del filtro)
  '#8a3b32', // rojo sangre / acento de la app
  '#5c1f1a', // óxido oscuro
  '#3f4a2e', // musgo
  '#2c3b2f', // verde bosque nocturno
  '#26323f', // azul noche
  '#3a2a1a', // cuero
  '#6b5a44', // hueso viejo
  '#cbb08a', // pergamino
  '#1a1512', // negro carbón
  '#7a5c2e', // bronce
  '#4a2620', // vino oscuro
];

let cmTarget = null; // 'colorpop' | 'tint'
let cmH = 0, cmS = 0, cmV = 0; // 0-1

function hsvToRgb(h,s,v){
  const i = Math.floor(h*6);
  const f = h*6 - i;
  const p = v*(1-s);
  const q = v*(1-f*s);
  const t = v*(1-(1-f)*s);
  let r,g,b;
  switch(i%6){
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    case 5: r=v; g=p; b=q; break;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const d = max - min;
  let h = 0;
  if (d !== 0){
    if (max === r) h = ((g-b)/d) % 6;
    else if (max === g) h = (b-r)/d + 2;
    else h = (r-g)/d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d/max;
  return { h, s, v: max };
}

function buildSwatches(){
  cmSwatches.innerHTML = '';
  THEME_SWATCHES.forEach(hex => {
    const btn = document.createElement('div');
    btn.className = 'cm-swatch-btn';
    btn.style.background = hex;
    btn.dataset.hex = hex;
    btn.addEventListener('click', () => {
      const r = parseInt(hex.slice(1,3),16);
      const g = parseInt(hex.slice(3,5),16);
      const b = parseInt(hex.slice(5,7),16);
      const hsv = rgbToHsv(r,g,b);
      cmH = hsv.h; cmS = hsv.s; cmV = hsv.v;
      updateColorModalUI();
    });
    cmSwatches.appendChild(btn);
  });
}
buildSwatches();

function currentCmRgb(){
  return hsvToRgb(cmH, cmS, cmV);
}

function updateColorModalUI(){
  const {r,g,b} = currentCmRgb();
  const hex = rgbToHex(r,g,b);

  // plano SV: el fondo base cambia según el tono elegido
  const hueRgb = hsvToRgb(cmH, 1, 1);
  cmSv.style.background = `rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b})`;
  cmSvCursor.style.left = (cmS*100) + '%';
  cmSvCursor.style.top = ((1-cmV)*100) + '%';
  cmSvCursor.style.background = hex;

  cmHueThumb.style.left = (cmH*100) + '%';

  cmPreview.style.background = hex;
  cmHex.value = hex;

  // marcar swatch seleccionado si coincide
  [...cmSwatches.children].forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.hex.toLowerCase() === hex.toLowerCase());
  });
}

function openColorModal(target, startRgb){
  cmTarget = target;
  const hsv = rgbToHsv(startRgb.r, startRgb.g, startRgb.b);
  cmH = hsv.h; cmS = hsv.s; cmV = hsv.v || 1;
  updateColorModalUI();
  colorModalScrim.classList.add('show');
}
function closeColorModal(){
  colorModalScrim.classList.remove('show');
  cmTarget = null;
}

// --- interacción: plano SV (arrastre) ---
function handleSvPointer(e){
  const rect = cmSv.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  cmS = x;
  cmV = 1 - y;
  updateColorModalUI();
}
let cmSvDragging = false;
cmSv.addEventListener('pointerdown', (e) => {
  cmSvDragging = true;
  cmSv.setPointerCapture(e.pointerId);
  handleSvPointer(e);
});
cmSv.addEventListener('pointermove', (e) => { if (cmSvDragging) handleSvPointer(e); });
cmSv.addEventListener('pointerup', () => { cmSvDragging = false; });
cmSv.addEventListener('pointercancel', () => { cmSvDragging = false; });

// --- interacción: slider de tono (arrastre) ---
function handleHuePointer(e){
  const rect = cmHue.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  cmH = x;
  updateColorModalUI();
}
let cmHueDragging = false;
cmHue.addEventListener('pointerdown', (e) => {
  cmHueDragging = true;
  cmHue.setPointerCapture(e.pointerId);
  handleHuePointer(e);
});
cmHue.addEventListener('pointermove', (e) => { if (cmHueDragging) handleHuePointer(e); });
cmHue.addEventListener('pointerup', () => { cmHueDragging = false; });
cmHue.addEventListener('pointercancel', () => { cmHueDragging = false; });

// --- campo hex manual ---
cmHex.addEventListener('change', () => {
  let hex = cmHex.value.trim();
  if (!hex.startsWith('#')) hex = '#' + hex;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)){
    updateColorModalUI(); // revertir si es inválido
    return;
  }
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const hsv = rgbToHsv(r,g,b);
  cmH = hsv.h; cmS = hsv.s; cmV = hsv.v;
  updateColorModalUI();
});

document.getElementById('cm-cancel').addEventListener('click', closeColorModal);
colorModalScrim.addEventListener('click', (e) => {
  if (e.target === colorModalScrim) closeColorModal();
});

document.getElementById('cm-confirm').addEventListener('click', () => {
  const {r,g,b} = currentCmRgb();
  if (cmTarget === 'colorpop'){
    setPopColor(r,g,b);
    crosshair.style.display = 'none';
    state.colorpop = true;
    swColorpop.classList.add('on');
    activePresetId = null;
    markCustom();
    if (sourceCanvas) scheduleRender();
  } else if (cmTarget === 'tint'){
    setTintColor(r,g,b);
    state.tintOn = true;
    swTint.classList.add('on');
    activePresetId = null;
    markCustom();
    if (sourceCanvas) scheduleRender();
  }
  closeColorModal();
});

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
