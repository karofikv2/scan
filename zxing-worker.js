/* Bộ giải mã ZXing (WebAssembly) chạy nền cho app Quét Serial KV2.
   Ưu tiên file trong thư mục lib/ (chạy được khi mạng yếu), dự phòng CDN jsDelivr.
   Tích hợp xử lý ảnh thiếu sáng (lọc khử nhiễu dọc + cân bằng tương phản cục bộ + gamma)
   và tự động định vị / phóng đại Bicubic vùng mã vạch khi chụp xa (lấy cả chữ Model + Barcode). */
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

/* Nội suy Catmull-Rom Bicubic 1 chiều giúp phóng đại vạch mã Code 128 sắc nét khi để camera xa */
function cubic(t) {
  const a = -0.5;
  t = t < 0 ? -t : t;
  if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
  if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
  return 0;
}

/* Tìm nhanh hộp chứa mã vạch 1D dựa trên mật độ đảo chiều đạo hàm ngang chuẩn hoá theo độ sáng (< 2ms) */
function findBarcodeBox(g, w, h) {
  const gx = 20, gy = 8;
  const cw = Math.max(4, Math.floor(w / gx)), ch = Math.max(4, Math.floor(h / gy));
  const score = new Float32Array(gx * gy);
  for (let by = 0; by < gy; by++) {
    const y0 = by * ch, y1 = Math.min(h, y0 + ch);
    for (let bx = 0; bx < gx; bx++) {
      const x0 = bx * cw, x1 = Math.min(w - 2, x0 + cw - 2);
      let sc = 0, lum = 0, cnt = 0;
      for (let y = y0; y < y1; y += 2) {
        const o = y * w;
        let prevD = 0, flips = 0, mag = 0;
        for (let x = x0; x < x1; x++) {
          lum += g[o + x];
          cnt++;
          const d = g[o + x + 1] - g[o + x];
          const ad = d < 0 ? -d : d;
          mag += ad;
          if (ad > 1.5 && d * prevD < 0) flips++;
          if (ad > 1.5) prevD = d;
        }
        sc += mag * (1 + flips * 0.65);
      }
      const meanCell = Math.max(12, lum / Math.max(1, cnt));
      score[by * gx + bx] = (sc / meanCell) / Math.max(1, cnt);
    }
  }
  let best = 0, bestBx = 0, bestBy = 0;
  const ww = Math.min(7, gx), wh = Math.min(4, gy);
  for (let by = 0; by <= gy - wh; by++) {
    for (let bx = 0; bx <= gx - ww; bx++) {
      let s = 0;
      for (let dy = 0; dy < wh; dy++) for (let dx = 0; dx < ww; dx++) s += score[(by + dy) * gx + (bx + dx)];
      if (s > best) { best = s; bestBx = bx; bestBy = by; }
    }
  }
  const padX = Math.round(cw * 1.5), padY = Math.round(ch * 1.2);
  const x0 = Math.max(0, bestBx * cw - padX);
  const y0 = Math.max(0, bestBy * ch - padY);
  const x1 = Math.min(w, (bestBx + ww) * cw + padX);
  const y1 = Math.min(h, (bestBy + wh) * ch + padY);
  return { x0, y0, bw: Math.max(64, x1 - x0), bh: Math.max(32, y1 - y0) };
}

/* Tăng cường ảnh mã vạch trong điều kiện thiếu sáng, bóng râm và chụp xa:
   - Lọc dọc 5-7 điểm giảm nhiễu hạt ISO mà không làm mờ vạch dọc
   - Chuẩn hoá min-max ngang cục bộ + nâng sáng gamma vùng tối
   - Nội suy ngang Bicubic Catmull-Rom + làm nét sau phóng đại */
function enhanceAndUpscale(src, sw, sh, opts) {
  const n = sw * sh;
  const g = new Float32Array(n);
  let sum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2];
    g[i] = y;
    sum += y;
  }
  const mean = sum / Math.max(1, n);
  const box = opts.cropBox ? findBarcodeBox(g, sw, sh) : { x0: 0, y0: 0, bw: sw, bh: sh };
  const x0 = box.x0, y0 = box.y0, bw = box.bw, bh = box.bh;
  const scale = opts.scale || ( opts.cropBox ? Math.min(2.2, Math.max(1.45, 720 / bw)) : (bw < 1350 ? 1.5 : 1.0) );
  const dw = Math.round(bw * scale), dh = Math.round(bh * scale);

  // 1. Lọc mịn dọc (vertical denoising) để khử nhiễu camera khi thiếu sáng
  const vs = new Float32Array(bw * bh);
  if (opts.vSmooth !== false) {
    for (let y = 0; y < bh; y++) {
      const sy = y0 + y;
      const r0 = Math.max(y0, sy - 2) * sw, r1 = Math.max(y0, sy - 1) * sw, r2 = sy * sw;
      const r3 = Math.min(y0 + bh - 1, sy + 1) * sw, r4 = Math.min(y0 + bh - 1, sy + 2) * sw;
      const dRow = y * bw;
      for (let x = 0; x < bw; x++) {
        const sx = x0 + x;
        vs[dRow + x] = (g[r0 + sx] + 2 * g[r1 + sx] + 4 * g[r2 + sx] + 2 * g[r3 + sx] + g[r4 + sx]) * 0.1;
      }
    }
  } else {
    for (let y = 0; y < bh; y++) {
      const sRow = (y0 + y) * sw + x0, dRow = y * bw;
      for (let x = 0; x < bw; x++) vs[dRow + x] = g[sRow + x];
    }
  }

  // 2. Cân bằng tương phản cục bộ theo cửa sổ ngang (bán kính 24px) + nâng gamma khi tối
  const rad = 24;
  const norm = new Float32Array(bw * bh);
  const gamma = opts.gamma || (mean < 85 ? 0.50 : 0.85);
  if (opts.localNorm !== false) {
    for (let y = 0; y < bh; y++) {
      const o = y * bw;
      for (let x = 0; x < bw; x++) {
        const xa = Math.max(0, x - rad), xb = Math.min(bw - 1, x + rad);
        let mn = 255, mx = 0;
        for (let k = xa; k <= xb; k += 2) {
          const v = vs[o + k];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const span = mx - mn;
        if (span < 3.5) norm[o + x] = 128;
        else {
          let v = (vs[o + x] - mn) / span;
          v = v < 0 ? 0 : v > 1 ? 1 : v;
          norm[o + x] = (gamma !== 1 ? Math.pow(v, gamma) : v) * 255;
        }
      }
    }
  } else {
    norm.set(vs);
  }

  // 3. Nội suy ngang Catmull-Rom Bicubic + làm nét sau phóng đại
  const xIdx = new Int32Array(dw * 4);
  const xW = new Float32Array(dw * 4);
  for (let x = 0; x < dw; x++) {
    const sx = (x + 0.5) / scale - 0.5;
    const xi = Math.floor(sx), fx = sx - xi;
    for (let k = -1; k <= 2; k++) {
      xIdx[x * 4 + k + 1] = Math.min(bw - 1, Math.max(0, xi + k));
      xW[x * 4 + k + 1] = cubic(k - fx);
    }
  }
  const tmp = new Float32Array(bh * dw);
  for (let y = 0; y < bh; y++) {
    const sRow = y * bw, dRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const b = x * 4;
      let v = norm[sRow + xIdx[b]] * xW[b] + norm[sRow + xIdx[b + 1]] * xW[b + 1] + norm[sRow + xIdx[b + 2]] * xW[b + 2] + norm[sRow + xIdx[b + 3]] * xW[b + 3];
      tmp[dRow + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  const shAmt = opts.sharpen || 0;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(bh - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const yi = Math.floor(sy), y1 = Math.min(bh - 1, yi + 1), fy = sy - yi;
    const r0 = yi * dw, r1 = y1 * dw, dRow = y * dw;
    for (let x = 0; x < dw; x++) {
      let v = tmp[r0 + x] * (1 - fy) + tmp[r1 + x] * fy;
      if (shAmt > 0 && x > 2 && x < dw - 3) {
        const l = tmp[r0 + x - 2] * (1 - fy) + tmp[r1 + x - 2] * fy;
        const r = tmp[r0 + x + 2] * (1 - fy) + tmp[r1 + x + 2] * fy;
        v = v + shAmt * (v - 0.5 * (l + r));
      }
      v = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
      const k = (dRow + x) << 2;
      out[k] = out[k + 1] = out[k + 2] = v;
      out[k + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh, mean };
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
    const raw = new Uint8ClampedArray(m.buf);
    const t0 = performance.now();
    const strat = m.strat | 0;
    // Lượt 1: giải mã theo chiến lược được chọn (cắt nhanh vùng mã vạch hoặc toàn khung tăng sáng/làm nét)
    const up = enhanceAndUpscale(raw, m.w, m.h, {
      cropBox: strat === 0,
      vSmooth: true,
      localNorm: strat !== 3,
      gamma: strat === 1 ? 0.85 : (m.lowLight ? 0.50 : 0.85),
      sharpen: m.sharpen || 0,
      scale: strat === 3 ? 1.25 : 1.6,
    });
    let res = await self.ZXingWASM.readBarcodes({ data: up.data, width: up.width, height: up.height }, {
      formats: m.formats,
      tryHarder: true,
      tryInvert: !!m.lowLight,
      tryDownscale: strat === 3,
      binarizer: m.binarizer || 'LocalAverage',
      maxNumberOfSymbols: 2,
    });
    // Nếu lượt cắt nhanh (strat 0) chưa thấy mã, thử ngay trên toàn khung đã phóng đại trong cùng 1 chu kỳ
    if ((!res || !res.length) && strat === 0) {
      const fullUp = enhanceAndUpscale(raw, m.w, m.h, {
        cropBox: false,
        vSmooth: true,
        localNorm: true,
        gamma: up.mean < 85 ? 0.50 : 0.85,
        sharpen: 0,
        scale: m.w < 1350 ? 1.6 : 1.2,
      });
      res = await self.ZXingWASM.readBarcodes({ data: fullUp.data, width: fullUp.width, height: fullUp.height }, {
        formats: m.formats,
        tryHarder: true,
        tryInvert: false,
        tryDownscale: false,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 2,
      });
    }
    self.postMessage({
      type: 'result', id: m.id, ms: Math.round(performance.now() - t0), mean: Math.round(up.mean),
      results: (res || []).filter((r) => r.isValid !== false && r.text).map((r) => ({ text: r.text, format: r.format })),
    });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String((err && err.message) || err) });
  }
};
