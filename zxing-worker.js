/* Bộ giải mã ZXing (WebAssembly) chạy nền cho app Quét Serial.
   Ưu tiên file trong thư mục lib/ (chạy được khi mạng yếu), dự phòng CDN jsDelivr. */
'use strict';
const LOCAL_JS = 'lib/zxing-reader.js';
const LOCAL_WASM = 'lib/zxing_reader.wasm';
const CDN = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist';
let initP = null;

function prepare(wasmUrl) {
  return self.ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
}

function init() {
  if (initP) return initP;
  initP = (async () => {
    let local = true;
    try { importScripts(LOCAL_JS); } catch (e) { local = false; importScripts(CDN + '/iife/reader/index.js'); }
    if (local) {
      try { await prepare(new URL(LOCAL_WASM, self.location.href).href); return 'local'; }
      catch (e) { try { self.ZXingWASM.purgeZXingModule(); } catch (e2) { /* */ } }
    }
    await prepare(CDN + '/reader/zxing_reader.wasm');
    return 'cdn';
  })();
  initP.catch(() => { initP = null; });
  return initP;
}

/* Làm nét theo độ sáng (unsharp mask, hộp 5×3) – giúp đọc mã vạch bị mờ */
function sharpen(d, w, h, amount) {
  const n = w * h, g = new Float32Array(n), hb = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += g[o + xx]; c++; } }
      hb[o + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y2 = y < h - 1 ? y + 1 : y, cnt = 1 + (y0 !== y) + (y2 !== y);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const blur = (hb[i] + (y0 !== y ? hb[y0 * w + x] : 0) + (y2 !== y ? hb[y2 * w + x] : 0)) / cnt;
      let v = g[i] + amount * (g[i] - blur);
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const k = i * 4; d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
  }
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    try { const src = await init(); self.postMessage({ type: 'ready', src }); }
    catch (err) { self.postMessage({ type: 'fatal', error: String((err && err.message) || err) }); }
    return;
  }
  if (m.type !== 'decode') return;
  try {
    await init();
    const data = new Uint8ClampedArray(m.buf);
    if (m.sharpen) sharpen(data, m.w, m.h, m.sharpen);
    const t0 = performance.now();
    // truyền object {data,width,height} (không cần ImageData trong worker – an toàn cho Safari cũ)
    const res = await self.ZXingWASM.readBarcodes({ data, width: m.w, height: m.h }, {
      formats: m.formats, tryHarder: true, tryInvert: false, binarizer: m.binarizer || 'LocalAverage', maxNumberOfSymbols: 1,
    });
    self.postMessage({
      type: 'result', id: m.id, ms: Math.round(performance.now() - t0),
      results: res.filter((r) => r.isValid !== false && r.text).map((r) => ({ text: r.text, format: r.format })),
    });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String((err && err.message) || err) });
  }
};
