/**
 * MODULE: app/ui/graph_renderer.ts
 *
 * Назначение:
 *   GraphRenderer v3 для окна RX (Sprint 2):
 *   - рисует спектр по `spectr_rssi` (100 точек / 99 интервалов),
 *   - ось Y: 1..100,
 *   - отрицательные значения — маркеры "частота видео" = abs(value),
 *     и соответствующая точка НЕ участвует в линии спектра,
 *   - красная вертикальная линия текущей частоты (если валидна),
 *   - оси/подписи X/Y для читаемого операторского графика,
 *   - интеракции: click → частота по шкале; wheel → delta частоты fixed-step в МГц.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.4 + §4 (RX graph)
 *   - ТЗ_vNext.3_Final_SSOT §5 (spectr_rssi, отрицательные маркеры)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 2 D2-5..D2-6 (GraphRenderer + Interaction)
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §2.4 (график: 100 pts, /99, markers)
 *
 * Инварианты уровня модуля:
 *   - Рендер fail-soft: при отсутствии диапазона/данных — не падает.
 *   - Формулы шкалы фиксированы: step=(max-min)/99, i=0..99.
 *   - Никаких UI-меню/конфигов: шаг wheel берётся из callback (Sprint 4 hook), по умолчанию 1 МГц.
 *   - Y labels остаются в контракте 1..100, не в dBm-псевдошкале.
 *
 * Запрещено:
 *   - Любые сетевые действия/WS отправки (это слой UI-рендера).
 *   - Изменение business-семантики графика.
 */

/**
 * @typedef {{ min: number, max: number }} FrequencyRange
 */

/**
 * @typedef {{
 *   range: FrequencyRange | null,
 *   spectrRssi: number[] | null,
 *   currentFrq: number | null,
 *   currentFrqValid: boolean
 * }} GraphData
 */

/**
 * @typedef {{
 *   onPickFrequency: (frq: number) => void,
 *   onWheelDelta: (delta: number) => void,
 *   getWheelStepMHz?: () => (1|2|5|10)
 * }} GraphHandlers
 */

/**
 * @typedef {{ left: number, top: number, width: number, height: number, right: number, bottom: number }} PlotRect
 */

const GRAPH_CHROME = {
  leftPad: 30,
  rightPad: 10,
  topPad: 8,
  bottomPad: 20,
  xTickCount: 6,
};

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   handlers: GraphHandlers
 * }} deps
 * @returns {{
 *   update: (data: GraphData) => void,
 *   destroy: () => void
 * }}
 */
export function createGraphRenderer(deps) {
  const { canvas, handlers } = deps;

  /** @type {GraphData} */
  let last = { range: null, spectrRssi: null, currentFrq: null, currentFrqValid: false };


  /** @param {MouseEvent} ev */
  function onClick(ev) {
    if (!last.range) return;
    const rect = canvas.getBoundingClientRect();
    const plot = getPlotRect(rect.width, rect.height);
    const localX = ev.clientX - rect.left - plot.left;
    const frq = frequencyFromCanvasX(localX, plot.width, last.range);
    handlers.onPickFrequency(frq);
  }

  /** @param {WheelEvent} ev */
  function onWheel(ev) {
    if (!last.range) return;
    ev.preventDefault();

    const dir = ev.deltaY < 0 ? 1 : -1;
    const stepMHz = handlers.getWheelStepMHz ? handlers.getWheelStepMHz() : 1;
    const delta = dir * stepMHz;
    handlers.onWheelDelta(delta);
  }

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function destroy() {
    canvas.removeEventListener("click", onClick);
    canvas.removeEventListener("wheel", onWheel);
  }

  /** @param {GraphData} data */
  function update(data) {
    last = data;
    render(canvas, data);
  }

  return { update, destroy };
}

/**
 * Назначение:
 *   Рассчитать частоту по X координате клика согласно SSOT шкале.
 *
 * Preconditions:
 *   - range содержит min/max.
 *   - widthPx > 0.
 *
 * Postconditions:
 *   - Возвращает частоту, соответствующую ближайшему i=0..99:
 *     step=(max-min)/99, frq(i)=min+i*step.
 *   - Частота округляется до целого числа.
 *
 * @param {number} xPx
 * @param {number} widthPx
 * @param {FrequencyRange} range
 * @returns {number}
 */
export function frequencyFromCanvasX(xPx, widthPx, range) {
  const w = Math.max(1, widthPx);
  const ratio = clamp01(xPx / w);
  const idx = Math.round(ratio * 99);
  const step = (range.max - range.min) / 99;
  const frq = range.min + idx * step;
  return Math.round(frq);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {GraphData} data
 */
function render(canvas, data) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  resizeCanvasToDisplaySize(canvas, ctx);

  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  const plot = getPlotRect(w, h);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);

  drawAxesAndGrid(ctx, data.range, plot);

  if (!data.range || !Array.isArray(data.spectrRssi) || data.spectrRssi.length !== 100) {
    return;
  }

  const range = data.range;

  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#ffd400";
  ctx.beginPath();

  let penDown = false;

  for (let i = 0; i < 100; i += 1) {
    const v = data.spectrRssi[i];
    if (typeof v !== "number") {
      penDown = false;
      continue;
    }

    if (v < 0) {
      continue;
    }

    const x = plot.left + (i / 99) * (plot.width - 1);
    const y = yFromRssi(v, plot);

    if (!penDown) {
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  for (let i = 0; i < 100; i += 1) {
    const v = data.spectrRssi[i];
    if (typeof v !== "number" || v >= 0) continue;

    const markerFrq = Math.abs(v);
    const x = xFromFrq(markerFrq, range, plot);
    if (x === null) continue;

    drawMarker(ctx, x, plot);
  }

  if (data.currentFrqValid && typeof data.currentFrq === "number") {
    const x = xFromFrq(data.currentFrq, range, plot);
    if (x !== null) {
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, plot.top);
      ctx.lineTo(x + 0.5, plot.bottom);
      ctx.stroke();
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {FrequencyRange | null} range
 * @param {PlotRect} plot
 */
function drawAxesAndGrid(ctx, range, plot) {
  const yTicks = [100, 80, 60, 40, 20, 1];
  const xSegments = GRAPH_CHROME.xTickCount - 1;

  ctx.save();

  ctx.strokeStyle = "#252a30";
  ctx.lineWidth = 1;
  for (const value of yTicks) {
    const y = yFromRssi(value, plot);
    ctx.beginPath();
    ctx.moveTo(plot.left, y + 0.5);
    ctx.lineTo(plot.right, y + 0.5);
    ctx.stroke();
  }

  for (let index = 0; index < GRAPH_CHROME.xTickCount; index += 1) {
    const x = plot.left + ((plot.width - 1) / xSegments) * index;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, plot.top);
    ctx.lineTo(x + 0.5, plot.bottom);
    ctx.stroke();
  }

  ctx.strokeStyle = "#4a4f55";
  ctx.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.width - 1, plot.height - 1);

  ctx.font = '10px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = "#7f878f";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const value of yTicks) {
    const y = yFromRssi(value, plot);
    ctx.fillText(String(value), plot.left - 6, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if (range) {
    for (let index = 0; index < GRAPH_CHROME.xTickCount; index += 1) {
      const x = plot.left + ((plot.width - 1) / xSegments) * index;
      const frq = range.min + ((range.max - range.min) / xSegments) * index;
      ctx.fillText(String(Math.round(frq)), x, plot.bottom + 4);
    }
  }

  ctx.restore();
}

/**
 * @param {number} v
 * @param {PlotRect} plot
 * @returns {number}
 */
function yFromRssi(v, plot) {
  const clamped = Math.max(1, Math.min(100, v));
  const t = (clamped - 1) / 99;
  return plot.bottom - t * (plot.height - 1);
}

/**
 * @param {number} frq
 * @param {FrequencyRange} range
 * @param {PlotRect} plot
 * @returns {number|null}
 */
function xFromFrq(frq, range, plot) {
  if (!Number.isFinite(frq)) return null;
  if (range.max === range.min) return null;
  const ratio = (frq - range.min) / (range.max - range.min);
  if (ratio < 0 || ratio > 1) return null;
  return plot.left + ratio * (plot.width - 1);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {PlotRect} plot
 */
function drawMarker(ctx, x, plot) {
  const bottomY = plot.bottom - 2;

  ctx.save();
  ctx.strokeStyle = "#ff2d2d";
  ctx.fillStyle = "#ff2d2d";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x + 0.5, plot.top);
  ctx.lineTo(x + 0.5, bottomY - 7);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, bottomY);
  ctx.lineTo(x - 4, bottomY - 6);
  ctx.lineTo(x + 4, bottomY - 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * @param {number} widthPx
 * @param {number} heightPx
 * @returns {PlotRect}
 */
function getPlotRect(widthPx, heightPx) {
  const left = GRAPH_CHROME.leftPad;
  const top = GRAPH_CHROME.topPad;
  const width = Math.max(1, widthPx - GRAPH_CHROME.leftPad - GRAPH_CHROME.rightPad);
  const height = Math.max(1, heightPx - GRAPH_CHROME.topPad - GRAPH_CHROME.bottomPad);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
function resizeCanvasToDisplaySize(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, Math.round(rect.width * dpr));
  const displayHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * @param {number} x
 * @returns {number}
 */
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
