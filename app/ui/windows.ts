/**
 * MODULE: app/ui/windows.ts
 *
 * Назначение:
 *   Рендер и UI-логика окон Sprint 4:
 *   - RX / TX / OPU окна на основе merged window views,
 *   - RX/TX window menus с live-apply + autosave,
 *   - drag&drop окон за шапку с persistence layout order,
 *   - drag&drop очереди Scenario 2 с persistence через ScenarioManager,
 *   - сохранение Sprint 1–3 runtime-поведения RX/TX/OPU без изменения бизнес-логики.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §3.1–§3.3, §4.6, §4.8, §4.9, §7.1, §7.2, §8, §9
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.5, §4.8, §4.9.1–§4.9.3, §4.10
 *   - SPRINT_PLAN_vNext.3.2 Sprint 2 AC2-* + Sprint 3 AC3-* + Sprint 4 D4-3..D4-6 / AC4-5..AC4-10
 *
 * Инварианты уровня модуля:
 *   - Источник истины для окон = `StateStore.getWindowViews()`; UI не хранит отдельную бизнес-модель устройств.
 *   - Window identity = `windowId`; target IP редактируем и может live-переподключаться без потери identity окна.
 *   - OPU menu не реализуется.
 *   - Drag&drop окон изменяет только layout order в рамках текущей flow/grid-модели страницы.
 *   - RX→TX маршрутизация, FIFO, offline no-reroute и WS-only/JSON-only инварианты остаются в core-слоях.
 *
 * Запрещено:
 *   - Добавлять отдельную абсолютную оконную ОС / свободные координаты.
 *   - Добавлять OPU menu.
 *   - Менять бизнес-логику RX/TX/OPU под видом UI-рефакторинга.
 */

import { isValidIpString, type WheelStepMultiplier, type WindowId } from "../contracts/config.js";
import type { ConfigStore } from "../core/config_store.js";
import type { createDeviceRegistry } from "../core/device_registry.js";
import type { createOpuCommandDispatcher } from "../core/opu_commands.js";
import type { createRxCommandDispatcher } from "../core/rx_commands.js";
import type { createScenarioManager, TxScenarioUiState } from "../core/scenario_manager.js";
import type { StateStore, WindowViewModel } from "../core/state_store.js";
import type { createTxCommandDispatcher } from "../core/tx_commands.js";
import { createGraphRenderer } from "./graph_renderer.js";
import { createNumericKeypad } from "./numeric_keypad.js";
import { createWindowMenuDialog, type RxMenuValues, type TxMenuValues } from "./window_menu_dialog.js";

type RxCommandDispatcher = ReturnType<typeof createRxCommandDispatcher>;
type TxCommandDispatcher = ReturnType<typeof createTxCommandDispatcher>;
type OpuCommandDispatcher = ReturnType<typeof createOpuCommandDispatcher>;
type ScenarioManager = ReturnType<typeof createScenarioManager>;
type DeviceRegistry = ReturnType<typeof createDeviceRegistry>;

type WindowController = {
  windowId: WindowId;
  el: HTMLElement;
  headerEl: HTMLElement;
  update: (windowView: WindowViewModel) => void;
  destroy: () => void;
};

type DragState = {
  pointerId: number | null;
  sourceWindowId: WindowId | null;
  active: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  ghostEl: HTMLElement | null;
  placeholderEl: HTMLElement | null;
  previewOrder: WindowId[] | null;
  previewRows: WindowId[][] | null;
  baseRows: WindowId[][] | null;
  rowTops: number[];
  rowHeights: number[];
  sourceRectWidth: number;
  sourceRectHeight: number;
  sourceColumnSpan: number;
  gridColumnCount: number;
};

/**
 * Назначение:
 *   Смонтировать и поддерживать в актуальном состоянии все окна устройств по merged store view.
 *
 * Preconditions:
 *   - `mountPoint` существует в DOM.
 *   - `store`, `configStore`, `deviceRegistry`, command dispatchers и `scenarioManager` уже созданы.
 *
 * Postconditions:
 *   - Для каждого `windowId` из config slice создано ровно одно DOM-окно.
 *   - При `layoutCustomized=false` применяется default layout RX→TX→OPU с row breaks.
 *   - При `layoutCustomized=true` используется сохранённый order без автоматических row breaks.
 *
 * Инварианты:
 *   - UI синхронизируется только через `store.subscribe()` и `scenarioManager.subscribe()`.
 *   - Один shared numeric keypad и один shared window-menu dialog используются повторно.
 *   - Перетаскивание доступно только за шапку окна.
 *
 * State transitions:
 *   - Store/config updates -> create/update/remove/reorder окон.
 *   - Drag&drop -> `config/setWindowOrder(layoutCustomized=true)`.
 *
 * Execution Trace:
 *   1. Создать flow-контейнер, shared keypad, shared menu dialog и beep player.
 *   2. Подписаться на store/scenario updates.
 *   3. На каждом sync создать/обновить/удалить контроллеры.
 *   4. Детерминированно переупорядочить DOM-узлы по config order.
 */
export function mountWindows(deps: {
  mountPoint: HTMLElement;
  store: StateStore;
  configStore: ConfigStore;
  deviceRegistry: DeviceRegistry;
  rxCommands: RxCommandDispatcher;
  txCommands: TxCommandDispatcher;
  opuCommands: OpuCommandDispatcher;
  scenarioManager: ScenarioManager;
}): { unmount: () => void } {
  const { mountPoint, store, configStore, deviceRegistry, rxCommands, txCommands, opuCommands, scenarioManager } = deps;

  mountPoint.innerHTML = "";
  const flow = document.createElement("div");
  flow.className = "windows-flow";
  mountPoint.appendChild(flow);

  const keypad = createNumericKeypad({ mountPoint: document.body });
  const menuDialog = createWindowMenuDialog({ mountPoint: document.body });
  const beep = createBeepPlayer();

  const controllers = new Map<WindowId, WindowController>();
  const dragState: DragState = {
    pointerId: null,
    sourceWindowId: null,
    active: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
    ghostEl: null,
    placeholderEl: null,
    previewOrder: null,
    previewRows: null,
    baseRows: null,
    rowTops: [],
    rowHeights: [],
    sourceRectWidth: 0,
    sourceRectHeight: 0,
    sourceColumnSpan: 1,
    gridColumnCount: 0,
  };

  let releasePointerDragListeners: (() => void) | null = null;
  let lastRenderedSignature = "";
  let scenarioRevision = 0;
  const lastWindowSignatures = new Map<WindowId, string>();

  function getOrderedWindowIds(): WindowId[] {
    return store.getWindowViews().map((windowView) => windowView.windowId);
  }

  function haveSameOrder(left: WindowId[], right: WindowId[]): boolean {
    return left.length === right.length && left.every((windowId, index) => right[index] === windowId);
  }

  function haveSameRows(left: WindowId[][] | null, right: WindowId[][] | null): boolean {
    if (!left || !right) return left === right;
    if (left.length !== right.length) return false;
    return left.every((row, rowIndex) => haveSameOrder(row, right[rowIndex] ?? []));
  }

  function isValidPreviewOrder(candidate: WindowId[], current: WindowId[]): boolean {
    if (candidate.length !== current.length) return false;
    const currentIds = new Set(current);
    return candidate.every((windowId) => currentIds.has(windowId));
  }

  function getPersistedLayoutRowStarts(): WindowId[] {
    return (configStore.getConfig().layoutRowStarts ?? []).slice();
  }

  function deriveLayoutRowStarts(rows: WindowId[][] | null): WindowId[] {
    if (!rows) return [];
    return rows
      .map((row) => row[0] ?? null)
      .filter((windowId): windowId is WindowId => windowId !== null)
      .slice(1);
  }

  function haveSameRowStarts(left: WindowId[], right: WindowId[]): boolean {
    return left.length === right.length && left.every((windowId, index) => right[index] === windowId);
  }

  function isValidLayoutRowStarts(candidate: WindowId[], order: WindowId[]): boolean {
    const orderSet = new Set(order);
    const seen = new Set<string>();
    return candidate.every((windowId) => {
      if (!orderSet.has(windowId)) return false;
      if (windowId === order[0]) return false;
      if (seen.has(windowId)) return false;
      seen.add(windowId);
      return true;
    });
  }

  function getWindowColumnSpanForDevice(deviceType: WindowViewModel["deviceType"]): number {
    switch (deviceType) {
      case "tx":
      case "opu":
        return 1;
      case "rx":
      default:
        return 2;
    }
  }

  function getWindowColumnSpan(windowId: WindowId | null | undefined): number {
    if (!windowId) return 1;
    const windowView = store.getWindowView(windowId);
    return windowView ? getWindowColumnSpanForDevice(windowView.deviceType) : 1;
  }

  function getRowColumnSpan(row: WindowId[]): number {
    return row.reduce((total, windowId) => total + getWindowColumnSpan(windowId), 0);
  }

  function createRowBreak(nextType?: WindowViewModel["deviceType"]): HTMLElement {
    const rowBreakEl = document.createElement('div');
    rowBreakEl.className = 'row-break';
    if (nextType) rowBreakEl.dataset.nextType = nextType;
    rowBreakEl.setAttribute('aria-hidden', 'true');
    return rowBreakEl;
  }

  function createRowSpacer(heightPx: number, columnSpan = 2): HTMLElement {
    const spacerEl = document.createElement('div');
    spacerEl.className = 'window-row-spacer';
    spacerEl.style.height = `${Math.max(180, Math.round(heightPx))}px`;
    spacerEl.dataset.windowSpan = String(Math.max(1, columnSpan));
    spacerEl.setAttribute('aria-hidden', 'true');
    return spacerEl;
  }

  function buildWindowNodes(order: WindowId[]): Node[] {
    const nodes: Node[] = [];
    const config = configStore.getConfig();
    const layoutCustomized = config.layoutCustomized;
    const customRowStarts = new Set((config.layoutRowStarts ?? []).filter((windowId) => order.includes(windowId)));
    const windowViews = new Map(store.getWindowViews().map((windowView) => [windowView.windowId, windowView]));
    const useDefaultRowBreaks = !dragState.active && !layoutCustomized;
    const useCustomRowBreaks = !dragState.active && layoutCustomized && customRowStarts.size > 0;

    if (dragState.active && dragState.previewRows) {
      dragState.previewRows.forEach((rowWindowIds, rowIndex) => {
        if (rowIndex > 0) nodes.push(createRowBreak());

        if (rowWindowIds.length === 0) {
          nodes.push(createRowSpacer(dragState.sourceRectHeight || 220, dragState.sourceColumnSpan || 2));
          return;
        }

        for (const windowId of rowWindowIds) {
          if (dragState.sourceWindowId === windowId && dragState.placeholderEl) {
            nodes.push(dragState.placeholderEl);
            continue;
          }

          const controller = controllers.get(windowId) ?? null;
          if (controller) nodes.push(controller.el);
        }
      });

      return nodes;
    }

    let previousType: WindowViewModel['deviceType'] | null = null;

    for (const windowId of order) {
      const windowView = windowViews.get(windowId) ?? null;
      if (useCustomRowBreaks && customRowStarts.has(windowId)) {
        nodes.push(createRowBreak(windowView?.deviceType));
      } else if (useDefaultRowBreaks && windowView && previousType && previousType !== windowView.deviceType) {
        nodes.push(createRowBreak(windowView.deviceType));
      }

      if (dragState.active && dragState.sourceWindowId === windowId && dragState.placeholderEl) {
        nodes.push(dragState.placeholderEl);
        previousType = windowView?.deviceType ?? previousType;
        continue;
      }

      const controller = controllers.get(windowId) ?? null;
      if (controller) nodes.push(controller.el);
      previousType = windowView?.deviceType ?? previousType;
    }

    return nodes;
  }

  function buildRenderSignature(order: WindowId[]): string {
    if (dragState.active && dragState.previewRows) {
      return `drag:${dragState.previewRows.map((row) => row.join(",")).join("|")}`;
    }

    const windowViews = new Map(store.getWindowViews().map((windowView) => [windowView.windowId, windowView]));
    const config = configStore.getConfig();
    const rowStarts: WindowId[] = [];

    if (config.layoutCustomized) {
      rowStarts.push(...(config.layoutRowStarts ?? []).filter((windowId) => order.includes(windowId)));
      return `layout:custom:${order.join(",")}::${rowStarts.join(",")}`;
    }

    let previousType: WindowViewModel["deviceType"] | null = null;
    for (const windowId of order) {
      const nextType = windowViews.get(windowId)?.deviceType ?? null;
      if (previousType && nextType && previousType !== nextType) rowStarts.push(windowId);
      previousType = nextType;
    }

    return `layout:default:${order.join(",")}::${rowStarts.join(",")}`;
  }

  function renderWindowOrder(order: WindowId[], force = false): void {
    const nextSignature = buildRenderSignature(order);
    if (!force && nextSignature === lastRenderedSignature) return;
    lastRenderedSignature = nextSignature;
    flow.replaceChildren(...buildWindowNodes(order));
  }

  function buildWindowSyncSignature(windowView: WindowViewModel): string {
    if (windowView.deviceType === "rx") {
      return JSON.stringify({
        t: windowView.title,
        ip: windowView.targetIp,
        ws: windowView.ws,
        p: windowView.presence.status,
        btn: windowView.buttonLabels,
        wheel: windowView.wheelStepMultiplier,
        range: windowView.range,
        rx: {
          inv: windowView.rx.inv,
          frq: windowView.rx.frq,
          ignor: windowView.rx.frq_ignor,
          spectr: windowView.rx.spectr_rssi,
        },
      });
    }

    if (windowView.deviceType === "tx") {
      return JSON.stringify({
        t: windowView.title,
        ip: windowView.targetIp,
        ws: windowView.ws,
        p: windowView.presence.status,
        btn: windowView.buttonLabels,
        range: windowView.range,
        tx: windowView.tx,
        scenarioRevision,
      });
    }

    return JSON.stringify({
      t: windowView.title,
      ip: windowView.targetIp,
      ws: windowView.ws,
      p: windowView.presence.status,
      opu: windowView.opu,
    });
  }

  function updateGhostPosition(clientX: number, clientY: number): void {
    if (!dragState.ghostEl) return;
    dragState.ghostEl.style.left = `${Math.round(clientX - dragState.offsetX)}px`;
    dragState.ghostEl.style.top = `${Math.round(clientY - dragState.offsetY)}px`;
  }

  function createDragGhost(sourceEl: HTMLElement, rect: DOMRect): HTMLElement {
    const ghostEl = sourceEl.cloneNode(true) as HTMLElement;
    ghostEl.classList.add('device-window--drag-ghost');
    ghostEl.style.width = `${Math.round(rect.width)}px`;
    ghostEl.style.height = `${Math.round(rect.height)}px`;
    ghostEl.style.left = `${Math.round(rect.left)}px`;
    ghostEl.style.top = `${Math.round(rect.top)}px`;
    return ghostEl;
  }

  function createDropPlaceholder(rect: DOMRect, columnSpan: number): HTMLElement {
    const placeholderEl = document.createElement('div');
    placeholderEl.className = 'window-dock-slot';
    placeholderEl.style.height = `${Math.max(180, Math.round(rect.height))}px`;
    placeholderEl.dataset.windowSpan = String(Math.max(1, columnSpan));

    const labelEl = document.createElement('div');
    labelEl.className = 'window-dock-slot__label';
    labelEl.textContent = 'вставка';
    placeholderEl.appendChild(labelEl);

    return placeholderEl;
  }

  function resetDragState(): void {
    dragState.pointerId = null;
    dragState.sourceWindowId = null;
    dragState.active = false;
    dragState.startX = 0;
    dragState.startY = 0;
    dragState.offsetX = 0;
    dragState.offsetY = 0;
    dragState.ghostEl = null;
    dragState.placeholderEl = null;
    dragState.previewOrder = null;
    dragState.previewRows = null;
    dragState.baseRows = null;
    dragState.rowTops = [];
    dragState.rowHeights = [];
    dragState.sourceRectWidth = 0;
    dragState.sourceRectHeight = 0;
    dragState.sourceColumnSpan = 1;
    dragState.gridColumnCount = 0;
    lastRenderedSignature = "";
  }

  function cleanupDragVisuals(): void {
    document.body.classList.remove('window-drag-active');
    dragState.ghostEl?.remove();
    dragState.placeholderEl?.remove();
  }

  function unbindPointerDragListeners(): void {
    releasePointerDragListeners?.();
    releasePointerDragListeners = null;
  }

  function cancelWindowDrag(): void {
    unbindPointerDragListeners();
    cleanupDragVisuals();
    resetDragState();
    sync();
  }

  function finishWindowDrag(persist: boolean): void {
    const currentOrder = getOrderedWindowIds();
    const currentRowStarts = getPersistedLayoutRowStarts();
    const nextOrder = dragState.previewOrder ? [...dragState.previewOrder] : null;
    const nextRowStarts = deriveLayoutRowStarts(dragState.previewRows);

    unbindPointerDragListeners();
    cleanupDragVisuals();
    resetDragState();

    if (
      persist &&
      nextOrder &&
      isValidPreviewOrder(nextOrder, currentOrder) &&
      isValidLayoutRowStarts(nextRowStarts, nextOrder) &&
      (!haveSameOrder(nextOrder, currentOrder) || !haveSameRowStarts(nextRowStarts, currentRowStarts))
    ) {
      configStore.setWindowOrder(nextOrder, true, nextRowStarts);
      return;
    }

    sync();
  }

  function getGridGapPx(axis: 'column' | 'row'): number {
    const styles = window.getComputedStyle(flow);
    const rawValue = axis === 'column' ? styles.columnGap || styles.gap : styles.rowGap || styles.gap;
    const parsed = Number.parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : 12;
  }

  function getMedian(values: number[], fallback: number): number {
    if (values.length === 0) return fallback;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? fallback;
  }

  function getBaseGridColumnWidthPx(): number {
    const styles = window.getComputedStyle(flow);
    const raw = styles.getPropertyValue('--dashboard-col-min').trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
  }

  function estimateGridColumnCount(): number {
    const flowRect = flow.getBoundingClientRect();
    const columnGap = getGridGapPx('column');
    const baseColumnWidth = getBaseGridColumnWidthPx();
    return Math.max(1, Math.floor((flowRect.width + columnGap) / (baseColumnWidth + columnGap)));
  }

  function flattenRows(rows: WindowId[][]): WindowId[] {
    const ordered: WindowId[] = [];
    for (const row of rows) {
      for (const windowId of row) ordered.push(windowId);
    }
    return ordered;
  }

  function cloneRows(rows: WindowId[][]): WindowId[][] {
    return rows.map((row) => [...row]);
  }

  function captureRenderedRows(order: WindowId[]): Array<{ windowIds: WindowId[]; top: number; height: number }> {
    const rowTolerance = Math.max(10, Math.round(getGridGapPx('row') / 2));
    const rows: Array<{ windowIds: WindowId[]; top: number; height: number }> = [];

    for (const windowId of order) {
      const controller = controllers.get(windowId) ?? null;
      if (!controller) continue;
      const rect = controller.el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const currentRow = rows[rows.length - 1] ?? null;
      if (!currentRow || Math.abs(rect.top - currentRow.top) > rowTolerance) {
        rows.push({
          windowIds: [windowId],
          top: rect.top,
          height: rect.height,
        });
        continue;
      }

      currentRow.windowIds.push(windowId);
      currentRow.height = Math.max(currentRow.height, rect.height);
    }

    return rows;
  }

  function normalizeRows(rows: WindowId[][], maxColumns: number): WindowId[][] {
    const normalized = cloneRows(rows);

    for (let rowIndex = 0; rowIndex < normalized.length; rowIndex += 1) {
      const row = normalized[rowIndex] ?? [];
      let usedColumns = 0;
      let overflowStart = row.length;

      for (let itemIndex = 0; itemIndex < row.length; itemIndex += 1) {
        const span = Math.min(getWindowColumnSpan(row[itemIndex]), maxColumns);
        if (itemIndex > 0 && usedColumns + span > maxColumns) {
          overflowStart = itemIndex;
          break;
        }
        usedColumns += span;
      }

      if (overflowStart < row.length) {
        const overflow = row.splice(overflowStart);
        if (!normalized[rowIndex + 1]) normalized[rowIndex + 1] = [];
        normalized[rowIndex + 1] = [...overflow, ...normalized[rowIndex + 1]];
      }
    }

    while (normalized.length > 1 && normalized[normalized.length - 1].length === 0) {
      normalized.pop();
    }

    return normalized;
  }

  function computePreviewRows(clientX: number, clientY: number): WindowId[][] {
    const sourceWindowId = dragState.sourceWindowId;
    const orderedWindowIds = getOrderedWindowIds();
    if (!sourceWindowId) return [orderedWindowIds];

    const flowRect = flow.getBoundingClientRect();
    const columnGap = getGridGapPx('column');
    const rowGap = getGridGapPx('row');
    const placeholderHeight = Math.max(180, Math.round(dragState.sourceRectHeight || 220));
    const baseColumnWidth = getBaseGridColumnWidthPx();
    const sourceSpan = Math.max(1, dragState.sourceColumnSpan || getWindowColumnSpan(sourceWindowId));
    const maxColumns = Math.max(1, dragState.gridColumnCount || estimateGridColumnCount());

    const baseRows = dragState.baseRows
      ? cloneRows(dragState.baseRows)
      : [orderedWindowIds.filter((windowId) => windowId !== sourceWindowId)];
    const slotRows = cloneRows(baseRows);
    slotRows.push([]);

    const rowTops = dragState.rowTops.length > 0 ? [...dragState.rowTops] : [flowRect.top];
    const rowHeights = dragState.rowHeights.length > 0 ? [...dragState.rowHeights] : [placeholderHeight];

    const ensureRowMetrics = (rowIndex: number): void => {
      while (rowTops.length <= rowIndex) {
        const previousTop = rowTops.length > 0 ? rowTops[rowTops.length - 1] : flowRect.top;
        const previousHeight = rowHeights.length > 0 ? rowHeights[rowHeights.length - 1] : placeholderHeight;
        rowTops.push(previousTop + previousHeight + rowGap);
        rowHeights.push(placeholderHeight);
      }
    };

    let bestRowIndex = 0;
    let bestInsertIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let rowIndex = 0; rowIndex < slotRows.length; rowIndex += 1) {
      ensureRowMetrics(rowIndex);
      const row = slotRows[rowIndex];
      const rowTop = rowTops[rowIndex] ?? flowRect.top;
      const rowHeight = Math.max(placeholderHeight, rowHeights[rowIndex] ?? placeholderHeight);

      let currentColumn = 0;
      for (let insertIndex = 0; insertIndex <= row.length; insertIndex += 1) {
        const slotStartColumn = currentColumn;
        if (slotStartColumn + sourceSpan <= maxColumns) {
          const slotLeft = flowRect.left + slotStartColumn * (baseColumnWidth + columnGap);
          const slotWidth = sourceSpan * baseColumnWidth + Math.max(0, sourceSpan - 1) * columnGap;
          const slotTop = rowTop;
          const slotHeight = rowHeight;
          const slotRight = slotLeft + slotWidth;
          const slotBottom = slotTop + slotHeight;
          const dx = clientX < slotLeft ? slotLeft - clientX : clientX > slotRight ? clientX - slotRight : 0;
          const dy = clientY < slotTop ? slotTop - clientY : clientY > slotBottom ? clientY - slotBottom : 0;
          const centerX = slotLeft + slotWidth / 2;
          const centerY = slotTop + slotHeight / 2;
          const centerDistance = Math.hypot(clientX - centerX, clientY - centerY);
          const insideBonus = dx === 0 && dy === 0 ? -9999 : 0;
          const score = dx * dx + dy * dy + centerDistance * 0.5 + insideBonus;

          if (score < bestScore) {
            bestScore = score;
            bestRowIndex = rowIndex;
            bestInsertIndex = insertIndex;
          }
        }

        if (insertIndex < row.length) {
          currentColumn += getWindowColumnSpan(row[insertIndex]);
        }
      }
    }

    const previewRows = cloneRows(baseRows);
    while (previewRows.length <= bestRowIndex) previewRows.push([]);
    const targetRow = previewRows[bestRowIndex] ?? [];
    const insertAt = Math.min(bestInsertIndex, targetRow.length);
    targetRow.splice(insertAt, 0, sourceWindowId);
    previewRows[bestRowIndex] = targetRow;

    return normalizeRows(previewRows, maxColumns);
  }

  function computePreviewOrder(clientX: number, clientY: number): WindowId[] {
    return flattenRows(computePreviewRows(clientX, clientY));
  }

  function updatePreviewOrder(clientX: number, clientY: number): void {
    if (!dragState.active || !dragState.sourceWindowId) return;

    const nextRows = computePreviewRows(clientX, clientY);
    const nextOrder = flattenRows(nextRows);
    if (dragState.previewOrder && dragState.previewRows && haveSameOrder(dragState.previewOrder, nextOrder) && haveSameRows(dragState.previewRows, nextRows)) return;

    dragState.previewRows = nextRows;
    dragState.previewOrder = nextOrder;
    renderWindowOrder(nextOrder);
  }

  function activateWindowDrag(sourceController: WindowController, ev: PointerEvent): void {
    const sourceRect = sourceController.el.getBoundingClientRect();
    const orderedWindowIds = getOrderedWindowIds();
    const renderedRows = captureRenderedRows(orderedWindowIds);

    dragState.active = true;
    dragState.offsetX = ev.clientX - sourceRect.left;
    dragState.offsetY = ev.clientY - sourceRect.top;
    dragState.sourceRectWidth = sourceRect.width;
    dragState.sourceRectHeight = sourceRect.height;
    dragState.sourceColumnSpan = getWindowColumnSpan(sourceController.windowId);
    dragState.gridColumnCount = Math.max(
      estimateGridColumnCount(),
      ...renderedRows.map((row) => getRowColumnSpan(row.windowIds)),
      dragState.sourceColumnSpan,
      1,
    );
    dragState.baseRows = renderedRows.map((row) => row.windowIds.filter((windowId) => windowId !== sourceController.windowId));
    dragState.rowTops = renderedRows.map((row) => row.top);
    dragState.rowHeights = renderedRows.map((row) => Math.max(sourceRect.height, row.height));
    dragState.ghostEl = createDragGhost(sourceController.el, sourceRect);
    dragState.placeholderEl = createDropPlaceholder(sourceRect, dragState.sourceColumnSpan);
    dragState.previewRows = renderedRows.map((row) => [...row.windowIds]);
    dragState.previewOrder = flattenRows(dragState.previewRows);

    document.body.appendChild(dragState.ghostEl);
    document.body.classList.add('window-drag-active');

    renderWindowOrder(dragState.previewOrder);
    updateGhostPosition(ev.clientX, ev.clientY);
    updatePreviewOrder(ev.clientX, ev.clientY);
  }

  function onWindowPointerMove(ev: PointerEvent): void {
    if (dragState.pointerId !== ev.pointerId || !dragState.sourceWindowId) return;

    const sourceController = controllers.get(dragState.sourceWindowId) ?? null;
    if (!sourceController) {
      cancelWindowDrag();
      return;
    }

    if (!dragState.active) {
      const distance = Math.hypot(ev.clientX - dragState.startX, ev.clientY - dragState.startY);
      if (distance < 6) return;
      activateWindowDrag(sourceController, ev);
    }

    ev.preventDefault();
    updateGhostPosition(ev.clientX, ev.clientY);
    updatePreviewOrder(ev.clientX, ev.clientY);
  }

  function onWindowPointerUp(ev: PointerEvent): void {
    if (dragState.pointerId !== ev.pointerId) return;
    finishWindowDrag(dragState.active);
  }

  function onWindowPointerCancel(ev: PointerEvent): void {
    if (dragState.pointerId !== ev.pointerId) return;
    cancelWindowDrag();
  }

  function bindPointerDragListeners(): void {
    if (releasePointerDragListeners) return;

    document.addEventListener('pointermove', onWindowPointerMove, { passive: false });
    document.addEventListener('pointerup', onWindowPointerUp);
    document.addEventListener('pointercancel', onWindowPointerCancel);

    releasePointerDragListeners = () => {
      document.removeEventListener('pointermove', onWindowPointerMove);
      document.removeEventListener('pointerup', onWindowPointerUp);
      document.removeEventListener('pointercancel', onWindowPointerCancel);
    };
  }

  function beginWindowDrag(controller: WindowController, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    if (dragState.pointerId !== null) return;

    const target = ev.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, label, a')) return;

    dragState.pointerId = ev.pointerId;
    dragState.sourceWindowId = controller.windowId;
    dragState.startX = ev.clientX;
    dragState.startY = ev.clientY;

    bindPointerDragListeners();
    ev.preventDefault();
  }

  function wireWindowDrag(controller: WindowController): () => void {
    const { el, headerEl, windowId } = controller;
    el.dataset.windowId = windowId;
    headerEl.draggable = false;
    headerEl.classList.add('device-window__header--draggable');

    const onPointerDown = (ev: PointerEvent) => beginWindowDrag(controller, ev);

    headerEl.addEventListener('pointerdown', onPointerDown);

    return () => {
      headerEl.removeEventListener('pointerdown', onPointerDown);
    };
  }

  function createController(windowView: WindowViewModel): WindowController {
    const controller =
      windowView.deviceType === "rx"
        ? createRxWindowController({
            windowView,
            store,
            configStore,
            deviceRegistry,
            rxCommands,
            scenarioManager,
            keypad,
            menuDialog,
            beep,
          })
        : windowView.deviceType === "tx"
          ? createTxWindowController({
              windowView,
              store,
              configStore,
              deviceRegistry,
              txCommands,
              scenarioManager,
              keypad,
              menuDialog,
            })
          : createOpuWindowController({
              windowView,
              opuCommands,
              keypad,
            });

    controller.el.dataset.windowSpan = String(getWindowColumnSpanForDevice(windowView.deviceType));

    const teardownDrag = wireWindowDrag(controller);
    const destroy = controller.destroy;

    return {
      ...controller,
      destroy: () => {
        teardownDrag();
        destroy();
      },
    };
  }

  function sync(): void {
    const windowViews = store.getWindowViews();
    const nextWindowIds = new Set(windowViews.map((windowView) => windowView.windowId));
    let dragSourceRemoved = false;

    for (const [windowId, controller] of controllers.entries()) {
      if (nextWindowIds.has(windowId)) continue;
      if (dragState.sourceWindowId === windowId) dragSourceRemoved = true;
      controller.destroy();
      controllers.delete(windowId);
      lastWindowSignatures.delete(windowId);
    }

    if (dragSourceRemoved) {
      unbindPointerDragListeners();
      cleanupDragVisuals();
      resetDragState();
    }

    for (const windowView of windowViews) {
      const nextSignature = buildWindowSyncSignature(windowView);
      const controller = controllers.get(windowView.windowId) ?? null;
      if (!controller) {
        const created = createController(windowView);
        controllers.set(windowView.windowId, created);
        created.update(windowView);
        lastWindowSignatures.set(windowView.windowId, nextSignature);
        continue;
      }

      if (lastWindowSignatures.get(windowView.windowId) !== nextSignature) {
        controller.update(windowView);
        lastWindowSignatures.set(windowView.windowId, nextSignature);
      }
    }

    const orderedWindowIds = windowViews.map((windowView) => windowView.windowId);
    const previewOrder = dragState.active && dragState.previewOrder ? dragState.previewOrder.filter((windowId) => nextWindowIds.has(windowId)) : null;
    if (previewOrder && isValidPreviewOrder(previewOrder, orderedWindowIds)) {
      renderWindowOrder(previewOrder);
      return;
    }

    renderWindowOrder(orderedWindowIds);
  }

  const unsubscribeStore = store.subscribe(() => sync());
  const unsubscribeScenario = scenarioManager.subscribe(() => {
    scenarioRevision += 1;
    sync();
  });
  sync();

  return {
    unmount: () => {
      unsubscribeStore();
      unsubscribeScenario();
      menuDialog.close();
      keypad.close();
      unbindPointerDragListeners();
      cleanupDragVisuals();
      resetDragState();
      for (const controller of controllers.values()) {
        controller.destroy();
      }
      controllers.clear();
      flow.replaceChildren();
    },
  };
}

/**
 * Назначение:
 *   Создать контроллер окна RX с сохранением Sprint 2–3 поведения и Sprint 4 menu persistence.
 *
 * Preconditions:
 *   - `windowView.deviceType === "rx"`.
 *   - `rxCommands` и `scenarioManager` уже сконфигурированы.
 *
 * Postconditions:
 *   - Возвращает DOM-контроллер RX окна с live update/update-only API.
 *
 * Инварианты:
 *   - FRQ alert работает только для внешней смены `frq`, а не для local ACK.
 *   - `set_frq_ignor` остаётся массивом длины 5.
 *   - Menu save не меняет RX business-логику, а только config fields + reconnect при смене IP.
 *
 * State transitions:
 *   - user actions -> RX commands / RX->TX route / config patch / reconnect.
 *   - incoming state -> visual update / graph update / alert state.
 *
 * Execution Trace:
 *   1. Собрать DOM RX окна.
 *   2. Привязать field/buttons/graph/ignore/menu handlers.
 *   3. На update() синхронизировать title/presence/buttons/ignore/graph/alert.
 */
function createRxWindowController(deps: {
  windowView: WindowViewModel;
  store: StateStore;
  configStore: ConfigStore;
  deviceRegistry: DeviceRegistry;
  rxCommands: RxCommandDispatcher;
  scenarioManager: ScenarioManager;
  keypad: ReturnType<typeof createNumericKeypad>;
  menuDialog: ReturnType<typeof createWindowMenuDialog>;
  beep: () => void;
}): WindowController {
  const { windowView, store, configStore, deviceRegistry, rxCommands, scenarioManager, keypad, menuDialog, beep } = deps;

  const el = document.createElement("div");
  el.className = "device-window device-window--rx";
  el.innerHTML = `
    <div class="device-window__header" data-role="header">
      <div class="device-window__title" data-role="title"></div>
      <div class="device-window__presence" data-role="presence"></div>
      <button class="btn btn--ghost btn--sm btn--icon" data-role="menu" title="Меню окна" aria-label="Меню окна">☰</button>
    </div>

    <div class="device-window__meta">
      <div class="kv"><span class="k">IP</span><span class="v" data-role="ip"></span></div>
      <div class="kv"><span class="k">WS</span><span class="v" data-role="ws"></span></div>
    </div>

    <div class="device-window__body">
      <div class="rx-ui">
        <div class="rx-ui__ignore-bar">
          <button class="btn rx-ignore-action" data-role="ignore">Игнор</button>
          <div class="rx-ui__ignore-slots" data-role="ignore-list"></div>
        </div>

        <div class="rx-ui__main-row">
          <div class="input-with-keypad rx-ui__entry">
            <input class="input rx-frq" data-role="frq" inputmode="numeric" placeholder="Частота" />
            <button class="btn btn--ghost btn--sm btn--icon field-keypad-trigger" type="button" data-role="frq-keypad" title="Экранная клавиатура" aria-label="Экранная клавиатура">⌨</button>
          </div>
          <div class="rx-ui__buttons">
            <button class="btn" data-role="scan">Сканировать</button>
            <button class="btn" data-role="inv">Инвертировать</button>
            <button class="btn" data-role="send">Отправить</button>
          </div>
        </div>

        <div class="rx-ui__graph">
          <canvas class="rx-graph" data-role="graph"></canvas>
        </div>
      </div>
    </div>
  `;

  const headerEl = el.querySelector<HTMLElement>('[data-role="header"]')!;
  const titleEl = el.querySelector<HTMLElement>('[data-role="title"]')!;
  const presenceEl = el.querySelector<HTMLElement>('[data-role="presence"]')!;
  const presenceLabelEl = el.querySelector<HTMLElement>('[data-role="presence-label"]')!;
  const btnMenu = el.querySelector<HTMLButtonElement>('[data-role="menu"]')!;
  const ipEl = el.querySelector<HTMLElement>('[data-role="ip"]')!;
  const wsEl = el.querySelector<HTMLElement>('[data-role="ws"]')!;
  const frqInput = el.querySelector<HTMLInputElement>('[data-role="frq"]')!;
  const btnFrqKeypad = el.querySelector<HTMLButtonElement>('[data-role="frq-keypad"]')!;
  const btnScan = el.querySelector<HTMLButtonElement>('[data-role="scan"]')!;
  const btnInv = el.querySelector<HTMLButtonElement>('[data-role="inv"]')!;
  const btnSend = el.querySelector<HTMLButtonElement>('[data-role="send"]')!;
  const btnIgnore = el.querySelector<HTMLButtonElement>('[data-role="ignore"]')!;
  const ignoreListEl = el.querySelector<HTMLElement>('[data-role="ignore-list"]')!;
  const graphCanvas = el.querySelector<HTMLCanvasElement>('[data-role="graph"]')!;

  const ignoreValuesEl: HTMLElement[] = [];
  const ignoreClearButtons: HTMLButtonElement[] = [];
  for (let index = 0; index < 5; index += 1) {
    const slot = document.createElement("div");
    slot.className = "rx-ignore-slot is-empty";

    const valueEl = document.createElement("span");
    valueEl.className = "rx-ignore-slot__value";
    valueEl.textContent = "";

    const btnClear = document.createElement("button");
    btnClear.className = "btn btn--danger btn--sm rx-ignore-slot__clear";
    btnClear.type = "button";
    btnClear.textContent = "X";
    btnClear.title = "Очистить слот";
    btnClear.ariaLabel = `Очистить ignore слот ${index + 1}`;

    slot.appendChild(valueEl);
    slot.appendChild(btnClear);
    ignoreListEl.appendChild(slot);

    ignoreValuesEl.push(valueEl);
    ignoreClearButtons.push(btnClear);
  }

  let current = windowView;
  let frqAlert = false;
  let lastDeviceFrq = typeof windowView.rx.frq === "number" ? windowView.rx.frq : null;
  let pendingLocalSetFrq: number | null = null;
  let scanAlertSuppressedUntilMs = 0;

  function setAlert(active: boolean): void {
    frqAlert = active;
    el.classList.toggle("device-window--alert", active);
    frqInput.classList.toggle("rx-frq--alert", active);
  }

  function triggerAlertBeep(): void {
    try {
      beep();
    } catch {
      // fail-soft
    }
  }

  function readFrqFromInput(): number {
    const raw = frqInput.value.trim();
    if (raw.length === 0) return 0;
    if (!/^\d{1,5}$/.test(raw)) return 0;
    return Number(raw);
  }

  function writeFrqToInput(frq: number): void {
    frqInput.value = frq === 0 ? "" : String(frq);
  }


  function getIgnoreButtonCaption(label: string | undefined): string {
    const raw = (label ?? "Игнорировать").trim();
    if (raw.length === 0) return "Игнор";
    if (raw.toLowerCase().startsWith("игнор")) return "Игнор";
    return raw.length > 8 ? raw.slice(0, 8) : raw;
  }

  function trySendSetFrq(frq: number, source: "field" | "keypad" | "graph_click" | "graph_wheel"): boolean {
    void source;
    const sent = rxCommands.sendSetFrq(current.targetIp, frq, current.range ?? null);
    if (!sent) return false;

    pendingLocalSetFrq = frq;
    setAlert(false);
    writeFrqToInput(frq);
    return true;
  }

  function tryRouteRxToTx(): void {
    const frq = readFrqFromInput();
    const validated = rxCommands.validateFrq(frq, current.range ?? null);
    if (!validated.ok) {
      window.alert("Нельзя отправить: невалидная частота.");
      return;
    }
    scenarioManager.routeRxFrequencyToTx(frq);
  }

  const graph = createGraphRenderer({
    canvas: graphCanvas,
    handlers: {
      onPickFrequency: (frq) => {
        trySendSetFrq(frq, "graph_click");
      },
      onWheelDelta: (delta) => {
        if (!current.range) return;

        let base = readFrqFromInput();
        if (base === 0 && typeof current.rx.frq === "number") base = current.rx.frq;
        if (base === 0) base = Math.round(current.range.min);

        let next = Math.round(base + delta);
        next = Math.max(current.range.min, Math.min(current.range.max, next));
        trySendSetFrq(next, "graph_wheel");
      },
      getWheelStepMHz: () => wheelStepToNumber(current.wheelStepMultiplier ?? "x1"),
    },
  });

  btnScan.addEventListener("click", () => {
    const sent = rxCommands.sendScan(current.targetIp);
    if (sent) {
      scanAlertSuppressedUntilMs = performance.now() + 4000;
      setAlert(false);
    }
  });
  btnInv.addEventListener("click", () => rxCommands.sendInvToggle(current.targetIp, current.rx.inv));
  btnSend.addEventListener("click", (ev) => {
    ev.preventDefault();
    tryRouteRxToTx();
  });

  frqInput.addEventListener("input", () => {
    const next = frqInput.value.replace(/\D/g, "").slice(0, 5);
    if (next !== frqInput.value) frqInput.value = next;
  });

  frqInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    trySendSetFrq(readFrqFromInput(), "field");
  });

  const openRxKeypad = () => {
    openInputKeypad({
      keypad,
      input: frqInput,
      title: "Частота",
      maxLength: 5,
      startEmpty: true,
      onConfirm: (value) => {
        if (value.length === 0) return;
        const frq = Number(value);
        trySendSetFrq(frq, "keypad");
      },
    });
  };

  bindInteractiveInputField({
    input: frqInput,
    openKeypad: openRxKeypad,
  });

  btnFrqKeypad.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openRxKeypad();
  });

  btnIgnore.addEventListener("click", () => {
    const frq = readFrqFromInput();
    const validated = rxCommands.validateFrq(frq, current.range ?? null);
    if (!validated.ok) {
      window.alert("Нельзя добавить в ignore: невалидная частота.");
      return;
    }

    const base = current.rx.frq_ignor;
    if (!Array.isArray(base) || base.length !== 5) {
      window.alert("Нельзя изменить ignore: список frq_ignor ещё не получен от устройства.");
      return;
    }

    const next = base.slice();
    const firstEmptyIndex = next.findIndex((item) => item === 0);
    if (firstEmptyIndex === -1) {
      window.alert("Список ignore заполнен: нет свободного слота (0).");
      return;
    }

    next[firstEmptyIndex] = validated.value;
    rxCommands.sendSetFrqIgnor(current.targetIp, next);
  });

  ignoreClearButtons.forEach((btnClear, index) => {
    btnClear.addEventListener("click", () => {
      const base = current.rx.frq_ignor;
      if (!Array.isArray(base) || base.length !== 5) {
        window.alert("Нельзя изменить ignore: список frq_ignor ещё не получен от устройства.");
        return;
      }

      const next = base.slice();
      next[index] = 0;
      rxCommands.sendSetFrqIgnor(current.targetIp, next);
    });
  });

  btnMenu.addEventListener("click", () => {
    const values: RxMenuValues = {
      title: current.title,
      targetIp: current.targetIp,
      wheelStepMultiplier: current.wheelStepMultiplier ?? "x1",
      buttonLabels: {
        scan: current.buttonLabels.scan ?? "Сканировать",
        inv: current.buttonLabels.inv ?? "Инвертировать",
        send: current.buttonLabels.send ?? "Отправить",
        ignore: current.buttonLabels.ignore ?? "Игнорировать",
        clear: current.buttonLabels.clear ?? "X",
      },
    };

    menuDialog.openRx({
      values,
      onSave: (nextValues) => {
        const targetIp = nextValues.targetIp.trim();
        if (!isValidIpString(targetIp)) {
          window.alert("Ошибка: IP должен быть строкой вида A.B.C.D.");
          return false;
        }
        if (store.hasTargetIp(targetIp, current.windowId)) {
          window.alert("Ошибка: окно с таким target IP уже существует.");
          return false;
        }

        const titlePatch = resolveTitlePatch(current, nextValues.title);
        if (!titlePatch) {
          window.alert("Ошибка: имя окна не должно быть пустым.");
          return false;
        }

        const ipChanged = targetIp !== current.targetIp;
        if (ipChanged) {
          deviceRegistry.disconnectWindow(current.windowId);
        }

        configStore.patchWindowConfig(current.windowId, {
          targetIp,
          title: titlePatch.title,
          titleMode: titlePatch.titleMode,
          buttonLabels: {
            scan: nextValues.buttonLabels.scan,
            inv: nextValues.buttonLabels.inv,
            send: nextValues.buttonLabels.send,
            ignore: nextValues.buttonLabels.ignore,
            clear: nextValues.buttonLabels.clear,
          },
          wheelStepMultiplier: nextValues.wheelStepMultiplier,
        });

        if (ipChanged) {
          deviceRegistry.reconnectWindow(current.windowId);
        }

        return true;
      },
      onDelete: () => {
        if (!window.confirm("Удалить окно RX?")) return false;
        deviceRegistry.disconnectWindow(current.windowId);
        scenarioManager.forgetWindow(current.windowId);
        configStore.removeWindowConfig(current.windowId);
        return true;
      },
    });
  });

  function update(nextWindowView: WindowViewModel): void {
    current = nextWindowView;

    titleEl.textContent = current.title || current.targetIp;
    ipEl.textContent = current.targetIp;
    wsEl.textContent = current.ws.status;
    presenceEl.className = `device-window__presence ${current.presence.status === "online" ? "presence--online" : "presence--offline"}`;
    presenceEl.title = current.presence.status;

    btnScan.textContent = current.buttonLabels.scan ?? "Сканировать";
    btnInv.textContent = current.buttonLabels.inv ?? "Инвертировать";
    btnSend.textContent = current.buttonLabels.send ?? "Отправить";
    btnIgnore.textContent = getIgnoreButtonCaption(current.buttonLabels.ignore);
    for (const btnClear of ignoreClearButtons) {
      btnClear.textContent = current.buttonLabels.clear ?? "X";
    }

    btnInv.classList.toggle("btn--active", current.rx.inv === true);

    const deviceFrq = typeof current.rx.frq === "number" ? current.rx.frq : null;
    const frqChanged = deviceFrq !== null && deviceFrq !== lastDeviceFrq;
    if (frqChanged) {
      const isLocalAck = pendingLocalSetFrq !== null && deviceFrq === pendingLocalSetFrq;
      const scanSuppressed = performance.now() <= scanAlertSuppressedUntilMs;
      pendingLocalSetFrq = null;

      if (!isLocalAck && !scanSuppressed) {
        setAlert(true);
        triggerAlertBeep();
        writeFrqToInput(deviceFrq);
      } else {
        setAlert(false);
        writeFrqToInput(deviceFrq);
      }

      lastDeviceFrq = deviceFrq;
    } else if (document.activeElement !== frqInput && deviceFrq !== null) {
      writeFrqToInput(deviceFrq);
    }

    const ignoreValues = current.rx.frq_ignor;
    const ignoreSlots = Array.from(ignoreListEl.querySelectorAll<HTMLElement>(".rx-ignore-slot"));
    for (let index = 0; index < ignoreValuesEl.length; index += 1) {
      const value = Array.isArray(ignoreValues) && ignoreValues.length === 5 ? ignoreValues[index] ?? 0 : 0;
      const empty = value === 0;
      ignoreValuesEl[index].textContent = empty ? "" : String(value);
      ignoreSlots[index]?.classList.toggle("is-empty", empty);
      ignoreClearButtons[index].disabled = empty;
    }

    const inputFrequency = readFrqFromInput();
    const currentFrequencyValid = rxCommands.validateFrq(inputFrequency, current.range ?? null).ok;
    graph.update({
      range: current.range ?? null,
      spectrRssi: Array.isArray(current.rx.spectr_rssi) ? current.rx.spectr_rssi : null,
      currentFrq: inputFrequency || null,
      currentFrqValid: currentFrequencyValid,
    });
  }

  update(windowView);

  return {
    windowId: windowView.windowId,
    el,
    headerEl,
    update,
    destroy: () => {
      graph.destroy();
    },
  };
}

/**
 * Назначение:
 *   Создать контроллер окна TX с persisted Scenario 1/2 queue/menu settings и сохранением Sprint 3 semantics.
 *
 * Preconditions:
 *   - `windowView.deviceType === "tx"`.
 *   - `txCommands` и `scenarioManager` уже сконфигурированы.
 *
 * Postconditions:
 *   - Возвращает DOM-контроллер TX окна с live update/update-only API.
 *
 * Инварианты:
 *   - `tx_ch <= 3`, число видимых полей строго равно `tx_ch`.
 *   - Top-down active-logic ручного ввода сохраняется.
 *   - Queue drag&drop меняет только persisted `windowId[]`, а не routing semantics.
 *
 * State transitions:
 *   - user actions -> TX commands / scenario toggle / queue reorder / config patch / reconnect.
 *   - incoming state -> telemetry / out-array / presence / input sync.
 *
 * Execution Trace:
 *   1. Собрать DOM TX окна.
 *   2. Привязать input/X/Off/Scenario/menu/queue handlers.
 *   3. На update() синхронизировать layout, telemetry, scenario queue и input values.
 */
function createTxWindowController(deps: {
  windowView: WindowViewModel;
  store: StateStore;
  configStore: ConfigStore;
  deviceRegistry: DeviceRegistry;
  txCommands: TxCommandDispatcher;
  scenarioManager: ScenarioManager;
  keypad: ReturnType<typeof createNumericKeypad>;
  menuDialog: ReturnType<typeof createWindowMenuDialog>;
}): WindowController {
  const { windowView, store, configStore, deviceRegistry, txCommands, scenarioManager, keypad, menuDialog } = deps;

  const el = document.createElement("div");
  el.className = "device-window device-window--tx";
  el.innerHTML = `
    <div class="device-window__header" data-role="header">
      <div class="device-window__title" data-role="title"></div>
      <div class="tx-window__status">
        <div class="device-window__presence" data-role="presence"></div>
        <span class="tx-window__presence-label" data-role="presence-label"></span>
      </div>
      <button class="btn btn--ghost btn--sm btn--icon" data-role="menu" title="Меню окна" aria-label="Меню окна">☰</button>
    </div>

    <div class="device-window__meta tx-window__meta">
      <div class="kv"><span class="k">IP</span><span class="v" data-role="ip"></span></div>
      <div class="kv"><span class="k">WS</span><span class="v" data-role="ws"></span></div>
    </div>

    <div class="device-window__body">
      <div class="tx-ui">
        <div class="tx-ui__grid">
          <div class="tx-ui__left">
            <div class="tx-ui__inputs" data-role="inputs"></div>
            <button class="btn tx-ui__off" data-role="off">Выкл</button>
          </div>
          <div class="tx-ui__telemetry">
            <div class="tx-metric"><div class="tx-metric__label">Температура</div><div class="tx-metric__value" data-role="metric-t">—</div></div>
            <div class="tx-metric"><div class="tx-metric__label">Напряжение</div><div class="tx-metric__value" data-role="metric-u">—</div></div>
            <div class="tx-metric"><div class="tx-metric__label">Ток</div><div class="tx-metric__value" data-role="metric-i">—</div></div>
            <div class="tx-metric"><div class="tx-metric__label">Мощность</div><div class="tx-metric__value" data-role="metric-p">—</div></div>
            <span data-role="txch" hidden></span>
            <span data-role="out" hidden></span>
          </div>
        </div>
        <button class="btn btn--secondary tx-ui__scenario" data-role="scenario">Сценарий 1</button>
        <div class="tx-ui__queue" data-role="queue" hidden></div>
      </div>
    </div>
  `;

  const headerEl = el.querySelector<HTMLElement>('[data-role="header"]')!;
  const titleEl = el.querySelector<HTMLElement>('[data-role="title"]')!;
  const presenceEl = el.querySelector<HTMLElement>('[data-role="presence"]')!;
  const presenceLabelEl = el.querySelector<HTMLElement>('[data-role="presence-label"]')!;
  const btnMenu = el.querySelector<HTMLButtonElement>('[data-role="menu"]')!;
  const ipEl = el.querySelector<HTMLElement>('[data-role="ip"]')!;
  const wsEl = el.querySelector<HTMLElement>('[data-role="ws"]')!;
  const inputsEl = el.querySelector<HTMLElement>('[data-role="inputs"]')!;
  const btnOff = el.querySelector<HTMLButtonElement>('[data-role="off"]')!;
  const btnScenario = el.querySelector<HTMLButtonElement>('[data-role="scenario"]')!;
  const txChEl = el.querySelector<HTMLElement>('[data-role="txch"]')!;
  const metricUEl = el.querySelector<HTMLElement>('[data-role="metric-u"]')!;
  const metricIEl = el.querySelector<HTMLElement>('[data-role="metric-i"]')!;
  const metricPEl = el.querySelector<HTMLElement>('[data-role="metric-p"]')!;
  const metricTEl = el.querySelector<HTMLElement>('[data-role="metric-t"]')!;
  const outEl = el.querySelector<HTMLElement>('[data-role="out"]')!;
  const queueEl = el.querySelector<HTMLElement>('[data-role="queue"]')!;

  let current = windowView;
  let currentGroupKey: string | null = null;
  let lastCoupledInteractionIndex: number | null = null;

  const rows: HTMLElement[] = [];
  const slotInputs: HTMLInputElement[] = [];
  const slotClearButtons: HTMLButtonElement[] = [];

  for (let index = 0; index < 3; index += 1) {
    const row = document.createElement("div");
    row.className = "tx-row";

    const input = document.createElement("input");
    input.className = "input tx-frq";
    input.inputMode = "numeric";
    input.placeholder = "—";

    const btnKeypad = document.createElement("button");
    btnKeypad.className = "btn btn--ghost btn--sm btn--icon field-keypad-trigger";
    btnKeypad.type = "button";
    btnKeypad.textContent = "⌨";
    btnKeypad.title = `Экранная клавиатура для сообщения ${index + 1}`;
    btnKeypad.ariaLabel = `Экранная клавиатура для сообщения ${index + 1}`;

    const btnClear = document.createElement("button");
    btnClear.className = "btn btn--danger btn--sm";
    btnClear.type = "button";
    btnClear.textContent = "X";

    row.appendChild(input);
    row.appendChild(btnKeypad);
    row.appendChild(btnClear);
    inputsEl.appendChild(row);

    rows.push(row);
    slotInputs.push(input);
    slotClearButtons.push(btnClear);

    input.addEventListener("focus", () => {
      lastCoupledInteractionIndex = index;
    });

    input.addEventListener("input", () => {
      lastCoupledInteractionIndex = index;
      const next = input.value.replace(/\D/g, "").slice(0, 5);
      if (input.value !== next) input.value = next;
      const txCh = txCommands.validateTxCh(current.tx.tx_ch);
      if (txCh !== null) applyTopDownInputState(txCh);
    });

    input.addEventListener("mousedown", (ev) => {
      const txCh = txCommands.validateTxCh(current.tx.tx_ch);
      if (txCh === null) return;
      const targetIndex = resolveEntryTargetIndex(index, txCh);
      lastCoupledInteractionIndex = targetIndex;
      if (targetIndex === index) return;
      ev.preventDefault();
      slotInputs[targetIndex].focus();
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      trySendFromInputs();
    });

    const resolveEditableInput = (): HTMLInputElement => {
      const txCh = txCommands.validateTxCh(current.tx.tx_ch);
      const targetIndex = txCh === null ? index : resolveEntryTargetIndex(index, txCh);
      return slotInputs[targetIndex] ?? input;
    };

    const openTxKeypad = () => {
      const targetInput = resolveEditableInput();
      const targetIndex = slotInputs.indexOf(targetInput);
      lastCoupledInteractionIndex = targetIndex;
      openInputKeypad({
        keypad,
        input: targetInput,
        title: `Сообщение ${targetIndex + 1}`,
        maxLength: 5,
        startEmpty: true,
        onConfirm: (value) => {
          if (value.length === 0) return;
          targetInput.value = value.replace(/\D/g, "").slice(0, 5);
          const currentTxCh = txCommands.validateTxCh(current.tx.tx_ch);
          if (currentTxCh !== null) applyTopDownInputState(currentTxCh);
          trySendFromInputs();
        },
      });
    };

    bindInteractiveInputField({
      input,
      resolveTargetInput: resolveEditableInput,
      openKeypad: openTxKeypad,
    });

    btnKeypad.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openTxKeypad();
    });

    btnClear.addEventListener("click", (ev) => {
      ev.preventDefault();
      const txCh = txCommands.validateTxCh(current.tx.tx_ch);
      if (txCh === null) {
        input.value = "";
        return;
      }

      lastCoupledInteractionIndex = index;
      if (txCh === 3) {
        clearCoupledSlot(index);
        return;
      }

      input.value = "";
      applyTopDownInputState(txCh);
      trySendFromInputs();
    });
  }

  function readArrayFromInputs(txCh: number): number[] {
    const arr: number[] = [];
    for (let index = 0; index < txCh; index += 1) {
      const raw = slotInputs[index].value.trim();
      if (raw.length === 0) {
        arr.push(0);
        continue;
      }
      if (!/^\d{1,5}$/.test(raw)) {
        arr.push(Number.NaN);
        continue;
      }
      arr.push(Number(raw));
    }
    return arr;
  }

  function writeArrayToInputs(arr: number[]): void {
    for (let index = 0; index < slotInputs.length; index += 1) {
      const value = arr[index] ?? 0;
      slotInputs[index].value = value === 0 ? "" : String(value);
    }
  }

  function readTxOutOrZeros(txWindow: WindowViewModel, txCh: number): number[] {
    const runtimeArr = scenarioManager.getDisplayTxArray(txWindow);
    const arr = Array.isArray(runtimeArr) && runtimeArr.length === txCh ? runtimeArr : txWindow.tx.frq_tx_out;
    if (!Array.isArray(arr) || arr.length !== txCh) return new Array(txCh).fill(0);
    return new Array(txCh).fill(0).map((_, index) => (typeof arr[index] === "number" ? arr[index] : 0));
  }

  function readTxRawOrZeros(txWindow: WindowViewModel, txCh: number): number[] {
    const runtimeArr = scenarioManager.getRawTxArray(txWindow);
    const arr = Array.isArray(runtimeArr) && runtimeArr.length === txCh ? runtimeArr : txWindow.tx.frq_tx_out;
    if (!Array.isArray(arr) || arr.length !== txCh) return new Array(txCh).fill(0);
    return new Array(txCh).fill(0).map((_, index) => (typeof arr[index] === "number" ? arr[index] : 0));
  }

  function isCoupledTx(txCh: number): boolean {
    return txCh === 3;
  }

  function findFirstEmptyIndex(txCh: number): number {
    if (isCoupledTx(txCh)) {
      const rawArr = readTxRawOrZeros(current, txCh);
      for (let index = 0; index < txCh; index += 1) {
        if (rawArr[index] === 0) return index;
      }
      return -1;
    }

    for (let index = 0; index < txCh; index += 1) {
      if (slotInputs[index].value.trim().length === 0) return index;
    }
    return -1;
  }

  function applyTopDownInputState(txCh: number): void {
    const firstEmpty = findFirstEmptyIndex(txCh);
    const rawArr = isCoupledTx(txCh) ? readTxRawOrZeros(current, txCh) : null;

    for (let index = 0; index < slotInputs.length; index += 1) {
      if (index >= txCh) {
        slotInputs[index].readOnly = true;
        slotInputs[index].tabIndex = -1;
        rows[index].classList.remove("tx-row--active");
        continue;
      }

      const filled = rawArr ? rawArr[index] !== 0 : slotInputs[index].value.trim().length > 0;
      const editable = filled || firstEmpty === -1 || index === firstEmpty;
      slotInputs[index].readOnly = !editable;
      slotInputs[index].tabIndex = editable ? 0 : -1;
      rows[index].classList.toggle("tx-row--active", firstEmpty !== -1 && index === firstEmpty);
    }
  }

  function resolveEntryTargetIndex(preferredIndex: number, txCh: number): number {
    const rawArr = isCoupledTx(txCh) ? readTxRawOrZeros(current, txCh) : null;
    const filled = rawArr ? rawArr[preferredIndex] !== 0 : slotInputs[preferredIndex]?.value.trim().length > 0;
    if (filled) return preferredIndex;

    const firstEmpty = findFirstEmptyIndex(txCh);
    if (firstEmpty === -1 || firstEmpty === preferredIndex) return preferredIndex;
    return firstEmpty;
  }

  function focusNextEmpty(txCh: number): void {
    applyTopDownInputState(txCh);
    const nextIndex = findFirstEmptyIndex(txCh);
    if (nextIndex !== -1) slotInputs[nextIndex].focus();
  }

  function renderTxArrayLocally(arr: number[]): void {
    outEl.textContent = formatArray(arr);
    outEl.parentElement?.setAttribute('title', `frq_tx_out ${outEl.textContent}`);
  }

  function countNonZero(arr: number[]): number {
    return arr.reduce((total, value) => total + (value !== 0 ? 1 : 0), 0);
  }

  function buildCoupledRawIntent(rawBase: number[], displayBase: number[], enteredArr: number[]): number[] {
    const next = rawBase.slice();
    const targetIndex = lastCoupledInteractionIndex;

    for (let index = 0; index < next.length; index += 1) {
      const entered = enteredArr[index] ?? 0;
      const displayValue = displayBase[index] ?? 0;
      const rawValue = rawBase[index] ?? 0;

      if (Number.isNaN(entered)) {
        next[index] = Number.NaN;
        continue;
      }

      if (entered === 0) {
        if (rawValue !== 0 || index === targetIndex) next[index] = 0;
        continue;
      }

      const changedVisibly = entered !== displayValue;
      const targetedHiddenSlot = index === targetIndex && rawValue === 0;
      if (changedVisibly || targetedHiddenSlot) {
        next[index] = entered;
      }
    }

    return next;
  }

  function clearCoupledSlot(index: number): void {
    const txCh = txCommands.validateTxCh(current.tx.tx_ch);
    if (txCh !== 3) return;

    const rawArr = readTxRawOrZeros(current, txCh);
    const currentDisplayArr = readTxOutOrZeros(current, txCh);
    if (rawArr[index] === 0 || countNonZero(rawArr) <= 1) {
      writeArrayToInputs(currentDisplayArr);
      applyTopDownInputState(txCh);
      renderTxArrayLocally(currentDisplayArr);
      return;
    }

    const nextRawArr = rawArr.slice();
    nextRawArr[index] = 0;
    const shaped = txCommands.shapeFrqTxIn(nextRawArr, txCh, current.range ?? null);
    if (!("arr" in shaped)) {
      txCommands.sendFrqTxIn(current.targetIp, nextRawArr, txCh, current.range ?? null);
      return;
    }

    const sent = txCommands.sendFrqTxIn(current.targetIp, nextRawArr, txCh, current.range ?? null);
    if (!sent) return;

    scenarioManager.rememberTxArray(current, nextRawArr);
    writeArrayToInputs(shaped.arr);
    applyTopDownInputState(txCh);
    renderTxArrayLocally(shaped.arr);
    focusNextEmpty(txCh);
  }

  function trySendFromInputs(): void {
    const txCh = txCommands.validateTxCh(current.tx.tx_ch);
    if (txCh === null) {
      window.alert("TX: tx_ch ещё не получен (или невалиден).");
      return;
    }

    const enteredArr = readArrayFromInputs(txCh);
    const currentRawArr = isCoupledTx(txCh) ? readTxRawOrZeros(current, txCh) : null;
    const rawIntent = isCoupledTx(txCh)
      ? buildCoupledRawIntent(currentRawArr ?? new Array(txCh).fill(0), readTxOutOrZeros(current, txCh), enteredArr)
      : enteredArr;

    if (isCoupledTx(txCh) && currentRawArr && countNonZero(currentRawArr) > 0 && countNonZero(rawIntent) === 0) {
      const currentDisplayArr = readTxOutOrZeros(current, txCh);
      writeArrayToInputs(currentDisplayArr);
      applyTopDownInputState(txCh);
      renderTxArrayLocally(currentDisplayArr);
      return;
    }

    const shaped = txCommands.shapeFrqTxIn(rawIntent, txCh, current.range ?? null);
    if (!("arr" in shaped)) {
      txCommands.sendFrqTxIn(current.targetIp, rawIntent, txCh, current.range ?? null);
      return;
    }

    const sent = txCommands.sendFrqTxIn(current.targetIp, rawIntent, txCh, current.range ?? null);
    if (sent) {
      writeArrayToInputs(shaped.arr);
      applyTopDownInputState(txCh);
      scenarioManager.rememberTxArray(current, rawIntent);
      renderTxArrayLocally(shaped.arr);
      focusNextEmpty(txCh);
    }
  }

  btnOff.addEventListener("click", (ev) => {
    ev.preventDefault();
    const txCh = txCommands.validateTxCh(current.tx.tx_ch);
    if (txCh === null) {
      window.alert("TX: tx_ch ещё не получен (или невалиден).");
      return;
    }

    const zeros = new Array(txCh).fill(0);
    const sent = txCommands.sendFrqTxIn(current.targetIp, zeros, txCh, current.range ?? null);
    if (!sent) return;

    writeArrayToInputs(zeros);
    applyTopDownInputState(txCh);
    scenarioManager.rememberTxArray(current, zeros);
    renderTxArrayLocally(zeros);
    focusNextEmpty(txCh);
  });

  btnScenario.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (!currentGroupKey) return;
    const ui = scenarioManager.getTxScenarioUiState(current);
    if (!ui.scenarioSwitchEnabled) return;
    scenarioManager.setScenario(currentGroupKey, ui.scenario === 1 ? 2 : 1);
  });

  function renderQueue(ui: TxScenarioUiState): void {
    const show = ui.scenario === 2 && ui.scenarioSwitchEnabled;
    queueEl.hidden = !show;
    if (!show) {
      queueEl.replaceChildren();
      return;
    }

    const title = document.createElement("div");
    title.className = "tx-queue-title";
    title.textContent = "Очередь (Scenario 2)";

    const list = document.createElement("div");
    list.className = "tx-queue-list";

    for (let index = 0; index < ui.queue.length; index += 1) {
      const item = ui.queue[index];
      const row = document.createElement("div");
      row.className = "tx-queue-item";
      row.draggable = true;
      row.dataset.index = String(index);

      const dot = document.createElement("span");
      dot.className = `presence ${item.online ? "presence--online" : "presence--offline"}`;
      dot.title = item.online ? "online" : "offline";

      const label = document.createElement("span");
      label.className = "tx-queue-label";
      label.textContent = item.title;

      row.appendChild(dot);
      row.appendChild(label);

      row.addEventListener("dragstart", (ev) => {
        try {
          ev.dataTransfer?.setData("text/plain", String(index));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
        } catch {
          // fail-soft
        }
      });

      row.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        try {
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        } catch {
          // fail-soft
        }
        row.classList.add("tx-queue-item--over");
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("tx-queue-item--over");
      });

      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        row.classList.remove("tx-queue-item--over");
        if (!ui.groupKey) return;

        let fromIndex = NaN;
        try {
          fromIndex = Number(ev.dataTransfer?.getData("text/plain") ?? "");
        } catch {
          fromIndex = NaN;
        }
        if (!Number.isFinite(fromIndex)) return;
        scenarioManager.moveQueueItem(ui.groupKey, fromIndex, index);
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("tx-queue-item--over");
      });

      list.appendChild(row);
    }

    queueEl.replaceChildren(title, list);
  }

  btnMenu.addEventListener("click", () => {
    const ui = scenarioManager.getTxScenarioUiState(current);
    const values: TxMenuValues = {
      title: current.title,
      targetIp: current.targetIp,
      scenario: ui.scenario,
      buttonLabels: {
        off: current.buttonLabels.off ?? "Выкл",
        scenario: current.buttonLabels.scenario ?? "Сценарий",
        clear: current.buttonLabels.clear ?? "X",
      },
    };

    menuDialog.openTx({
      values,
      scenarioEnabled: ui.scenarioSwitchEnabled,
      onSave: (nextValues) => {
        const targetIp = nextValues.targetIp.trim();
        if (!isValidIpString(targetIp)) {
          window.alert("Ошибка: IP должен быть строкой вида A.B.C.D.");
          return false;
        }
        if (store.hasTargetIp(targetIp, current.windowId)) {
          window.alert("Ошибка: окно с таким target IP уже существует.");
          return false;
        }

        const titlePatch = resolveTitlePatch(current, nextValues.title);
        if (!titlePatch) {
          window.alert("Ошибка: имя окна не должно быть пустым.");
          return false;
        }

        const ipChanged = targetIp !== current.targetIp;
        if (ipChanged) {
          deviceRegistry.disconnectWindow(current.windowId);
        }

        configStore.patchWindowConfig(current.windowId, {
          targetIp,
          title: titlePatch.title,
          titleMode: titlePatch.titleMode,
          buttonLabels: {
            off: nextValues.buttonLabels.off,
            scenario: nextValues.buttonLabels.scenario,
            clear: nextValues.buttonLabels.clear,
          },
        });

        if (ui.groupKey) {
          scenarioManager.setScenario(ui.groupKey, ui.scenarioSwitchEnabled ? nextValues.scenario : 1);
        }

        if (ipChanged) {
          scenarioManager.forgetWindow(current.windowId);
          deviceRegistry.reconnectWindow(current.windowId);
        }

        return true;
      },
      onDelete: () => {
        if (!window.confirm("Удалить окно TX?")) return false;
        deviceRegistry.disconnectWindow(current.windowId);
        scenarioManager.forgetWindow(current.windowId);
        configStore.removeWindowConfig(current.windowId);
        return true;
      },
    });
  });

  function update(nextWindowView: WindowViewModel): void {
    current = nextWindowView;

    titleEl.textContent = current.title || current.targetIp;
    ipEl.textContent = current.targetIp;
    wsEl.textContent = current.ws.status;
    presenceEl.className = `device-window__presence ${current.presence.status === "online" ? "presence--online" : "presence--offline"}`;
    presenceEl.title = current.presence.status;
    presenceLabelEl.textContent = current.presence.status === "online" ? "Online" : "Offline";
    presenceLabelEl.classList.toggle('is-offline', current.presence.status !== 'online');

    const txCh = txCommands.validateTxCh(current.tx.tx_ch);
    const displayTxArr = txCh === null ? null : readTxOutOrZeros(current, txCh);
    txChEl.textContent = txCh === null ? "—" : String(txCh);
    metricUEl.textContent = formatTxMetricValue(current.tx.U, 'В', 2);
    metricIEl.textContent = formatTxMetricValue(current.tx.I, 'А', 2);
    metricPEl.textContent = formatTxMetricValue(current.tx.P, 'Вт', 2);
    metricTEl.textContent = formatTxMetricValue(current.tx.T, '°C', 0);
    outEl.textContent = formatArray(displayTxArr ?? current.tx.frq_tx_out);
    outEl.parentElement?.setAttribute('title', `frq_tx_out ${outEl.textContent}`);

    btnOff.textContent = current.buttonLabels.off ?? "Выкл";
    for (const [index, btnClear] of slotClearButtons.entries()) {
      btnClear.textContent = current.buttonLabels.clear ?? "X";
      const coupledTx = txCh === 3;
      btnClear.title = coupledTx ? `Удалить слот ${index + 1} с автоподстановкой оставшейся частоты` : `Очистить сообщение ${index + 1}`;
      btnClear.ariaLabel = coupledTx ? `Удалить слот ${index + 1} с автоподстановкой оставшейся частоты` : `Очистить сообщение ${index + 1}`;
    }

    for (let index = 0; index < rows.length; index += 1) {
      rows[index].hidden = txCh === null ? true : index >= txCh;
    }

    if (txCh !== null) {
      applyTopDownInputState(txCh);
    } else {
      for (let index = 0; index < slotInputs.length; index += 1) {
        slotInputs[index].readOnly = true;
        slotInputs[index].tabIndex = -1;
        rows[index].classList.remove("tx-row--active");
      }
    }

    btnOff.disabled = txCh === null;

    const ui = scenarioManager.getTxScenarioUiState(current);
    currentGroupKey = ui.groupKey;
    btnScenario.textContent = formatScenarioButtonLabel(current.buttonLabels.scenario ?? "Сценарий", ui.scenario);
    btnScenario.disabled = !ui.scenarioSwitchEnabled;
    renderQueue(ui);

    const editing = slotInputs.some((input) => input === document.activeElement);
    if (!editing && txCh !== null) {
      writeArrayToInputs(displayTxArr ?? readTxOutOrZeros(current, txCh));
      applyTopDownInputState(txCh);
    }
  }

  update(windowView);

  return {
    windowId: windowView.windowId,
    el,
    headerEl,
    update,
    destroy: () => {},
  };
}

/**
 * Назначение:
 *   Создать контроллер окна OPU без отдельного OPU-menu.
 *
 * Preconditions:
 *   - `windowView.deviceType === "opu"`.
 *
 * Postconditions:
 *   - Возвращает DOM-контроллер OPU окна с live update/update-only API.
 *
 * Инварианты:
 *   - Отображаются только OPU state-поля и OPU команды set_*.
 *   - OPU menu не появляется.
 *
 * State transitions:
 *   - user actions -> OPU set_* commands.
 *   - incoming state -> presence/state output updates.
 *
 * Execution Trace:
 *   1. Собрать DOM OPU окна.
 *   2. Привязать handlers set_ugol/set_centr_ugol/set_speed.
 *   3. На update() синхронизировать title/presence/state.
 */
function createOpuWindowController(deps: {
  windowView: WindowViewModel;
  opuCommands: OpuCommandDispatcher;
  keypad: ReturnType<typeof createNumericKeypad>;
}): WindowController {
  const { windowView, opuCommands, keypad } = deps;

  const el = document.createElement("div");
  el.className = "device-window device-window--opu";
  el.innerHTML = `
    <div class="device-window__header device-window__header--opu" data-role="header">
      <div class="device-window__title" data-role="title"></div>
      <div class="opu-header-status">
        <span class="presence presence--offline" data-role="presence"></span>
        <span class="opu-header-status__label" data-role="presence-label">offline</span>
      </div>
    </div>

    <div class="device-window__body device-window__body--opu">
      <div class="opu-ui">
        <div class="opu-gauge" data-role="gauge">
          <div class="opu-gauge__track"></div>
          <div class="opu-gauge__arc"></div>
          <div class="opu-gauge__needle-wrap" data-role="needle-wrap">
            <div class="opu-gauge__needle"></div>
          </div>
          <div class="opu-gauge__labels">
            <span class="opu-gauge__label opu-gauge__label--left">-180°</span>
            <span class="opu-gauge__label opu-gauge__label--center">0°</span>
            <span class="opu-gauge__label opu-gauge__label--right">180°</span>
          </div>
          <div class="opu-gauge__value" data-role="gauge-value">—</div>
        </div>

        <div class="opu-ui__summary">
          <button class="opu-live-chip" type="button" data-role="fill-ugol">
            <span class="opu-live-chip__label">Угол</span>
            <span class="opu-live-chip__value" data-role="ugol-inline">—</span>
          </button>
          <button class="opu-live-chip" type="button" data-role="fill-centr">
            <span class="opu-live-chip__label">Центр</span>
            <span class="opu-live-chip__value" data-role="centr-inline">—</span>
          </button>
          <button class="opu-live-chip" type="button" data-role="fill-speed">
            <span class="opu-live-chip__label">Скорость</span>
            <span class="opu-live-chip__value" data-role="speed-inline">—</span>
          </button>
        </div>

        <div class="opu-ui__commands">
          <div class="opu-cmd-row">
            <label class="opu-cmd-row__label" for="opu-set-ugol-${windowView.windowId}">Угол</label>
            <div class="input-with-keypad opu-cmd-row__input">
              <input class="input" id="opu-set-ugol-${windowView.windowId}" data-role="set-ugol" inputmode="decimal" enterkeyhint="send" />
              <button class="btn btn--ghost btn--sm btn--icon field-keypad-trigger" type="button" data-role="keypad-ugol" title="Экранная клавиатура" aria-label="Экранная клавиатура">⌨</button>
            </div>
            <button class="btn btn--sm opu-cmd-row__send" data-role="send-ugol">SET</button>
          </div>
          <div class="opu-cmd-row">
            <label class="opu-cmd-row__label" for="opu-set-centr-${windowView.windowId}">Центр</label>
            <div class="input-with-keypad opu-cmd-row__input">
              <input class="input" id="opu-set-centr-${windowView.windowId}" data-role="set-centr" inputmode="decimal" enterkeyhint="send" />
              <button class="btn btn--ghost btn--sm btn--icon field-keypad-trigger" type="button" data-role="keypad-centr" title="Экранная клавиатура" aria-label="Экранная клавиатура">⌨</button>
            </div>
            <button class="btn btn--sm opu-cmd-row__send" data-role="send-centr">SET</button>
          </div>
          <div class="opu-cmd-row">
            <label class="opu-cmd-row__label" for="opu-set-speed-${windowView.windowId}">Скорость</label>
            <div class="input-with-keypad opu-cmd-row__input">
              <input class="input" id="opu-set-speed-${windowView.windowId}" data-role="set-speed" inputmode="decimal" enterkeyhint="send" />
              <button class="btn btn--ghost btn--sm btn--icon field-keypad-trigger" type="button" data-role="keypad-speed" title="Экранная клавиатура" aria-label="Экранная клавиатура">⌨</button>
            </div>
            <button class="btn btn--sm opu-cmd-row__send" data-role="send-speed">SET</button>
          </div>
        </div>

        <div class="opu-ui__footer">
          <div class="opu-footer-tile"><div class="opu-footer-tile__label">lat</div><div class="opu-footer-tile__value" data-role="lat">—</div></div>
          <div class="opu-footer-tile"><div class="opu-footer-tile__label">lng</div><div class="opu-footer-tile__value" data-role="lng">—</div></div>
        </div>
      </div>
    </div>
  `;

  const headerEl = el.querySelector<HTMLElement>('[data-role="header"]')!;
  const titleEl = el.querySelector<HTMLElement>('[data-role="title"]')!;
  const presenceEl = el.querySelector<HTMLElement>('[data-role="presence"]')!;
  const presenceLabelEl = el.querySelector<HTMLElement>('[data-role="presence-label"]')!;
  const gaugeEl = el.querySelector<HTMLElement>('[data-role="gauge"]')!;
  const needleWrapEl = el.querySelector<HTMLElement>('[data-role="needle-wrap"]')!;
  const gaugeValueEl = el.querySelector<HTMLElement>('[data-role="gauge-value"]')!;
  const latEl = el.querySelector<HTMLElement>('[data-role="lat"]')!;
  const lngEl = el.querySelector<HTMLElement>('[data-role="lng"]')!;
  const ugolInlineEl = el.querySelector<HTMLElement>('[data-role="ugol-inline"]')!;
  const centrInlineEl = el.querySelector<HTMLElement>('[data-role="centr-inline"]')!;
  const speedInlineEl = el.querySelector<HTMLElement>('[data-role="speed-inline"]')!;

  const inputUgol = el.querySelector<HTMLInputElement>('[data-role="set-ugol"]')!;
  const inputCentr = el.querySelector<HTMLInputElement>('[data-role="set-centr"]')!;
  const inputSpeed = el.querySelector<HTMLInputElement>('[data-role="set-speed"]')!;
  const btnFillUgol = el.querySelector<HTMLButtonElement>('[data-role="fill-ugol"]')!;
  const btnKeypadUgol = el.querySelector<HTMLButtonElement>('[data-role="keypad-ugol"]')!;
  const btnFillCentr = el.querySelector<HTMLButtonElement>('[data-role="fill-centr"]')!;
  const btnKeypadCentr = el.querySelector<HTMLButtonElement>('[data-role="keypad-centr"]')!;
  const btnFillSpeed = el.querySelector<HTMLButtonElement>('[data-role="fill-speed"]')!;
  const btnKeypadSpeed = el.querySelector<HTMLButtonElement>('[data-role="keypad-speed"]')!;
  const btnSendUgol = el.querySelector<HTMLButtonElement>('[data-role="send-ugol"]')!;
  const btnSendCentr = el.querySelector<HTMLButtonElement>('[data-role="send-centr"]')!;
  const btnSendSpeed = el.querySelector<HTMLButtonElement>('[data-role="send-speed"]')!;

  let current = windowView;

  function readNumber(input: HTMLInputElement): number | null {
    const raw = input.value.trim();
    if (raw.length === 0) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function fillFromCurrent(input: HTMLInputElement, value: number): void {
    input.value = Number.isFinite(value) ? formatOpuPlainValue(value) : "";
    focusInputCaret(input);
  }

  function syncOpuInput(input: HTMLInputElement): void {
    const next = sanitizeSignedDecimalInput(input.value, 12);
    if (next === input.value) return;
    input.value = next;
    if (document.activeElement === input) focusInputCaret(input);
  }

  function openOpuKeypad(input: HTMLInputElement, title: string): void {
    openInputKeypad({
      keypad,
      input,
      title,
      allowDecimal: true,
      allowNegative: true,
      maxLength: 12,
      onConfirm: (value) => {
        input.value = sanitizeSignedDecimalInput(value, 12);
        focusInputCaret(input);
      },
    });
  }

  bindInteractiveInputField({ input: inputUgol, openKeypad: () => openOpuKeypad(inputUgol, "set_ugol") });
  bindInteractiveInputField({ input: inputCentr, openKeypad: () => openOpuKeypad(inputCentr, "set_centr_ugol") });
  bindInteractiveInputField({ input: inputSpeed, openKeypad: () => openOpuKeypad(inputSpeed, "set_speed") });

  inputUgol.addEventListener("input", () => syncOpuInput(inputUgol));
  inputCentr.addEventListener("input", () => syncOpuInput(inputCentr));
  inputSpeed.addEventListener("input", () => syncOpuInput(inputSpeed));

  btnKeypadUgol.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openOpuKeypad(inputUgol, "set_ugol");
  });
  btnKeypadCentr.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openOpuKeypad(inputCentr, "set_centr_ugol");
  });
  btnKeypadSpeed.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openOpuKeypad(inputSpeed, "set_speed");
  });

  function sendSetUgol(): void {
    const value = readNumber(inputUgol);
    if (value === null) return;
    opuCommands.sendSetUgol(current.targetIp, value);
  }

  function sendSetCentr(): void {
    const value = readNumber(inputCentr);
    if (value === null) return;
    opuCommands.sendSetCentrUgol(current.targetIp, value);
  }

  function sendSetSpeed(): void {
    const value = readNumber(inputSpeed);
    if (value === null) return;
    opuCommands.sendSetSpeed(current.targetIp, value);
  }

  btnFillUgol.addEventListener("click", () => fillFromCurrent(inputUgol, current.opu.ugol));
  btnFillCentr.addEventListener("click", () => fillFromCurrent(inputCentr, current.opu.centr_ugol));
  btnFillSpeed.addEventListener("click", () => fillFromCurrent(inputSpeed, current.opu.speed));

  btnSendUgol.addEventListener("click", sendSetUgol);
  btnSendCentr.addEventListener("click", sendSetCentr);
  btnSendSpeed.addEventListener("click", sendSetSpeed);

  inputUgol.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    sendSetUgol();
  });
  inputCentr.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    sendSetCentr();
  });
  inputSpeed.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    sendSetSpeed();
  });

  function update(nextWindowView: WindowViewModel): void {
    current = nextWindowView;
    titleEl.textContent = current.title || current.targetIp;

    const isOnline = current.presence.status === "online";
    presenceEl.className = `presence ${isOnline ? "presence--online" : "presence--offline"}`;
    presenceLabelEl.textContent = isOnline ? "online" : "offline";
    presenceLabelEl.className = `opu-header-status__label ${isOnline ? "" : "is-offline"}`.trim();

    const latValue = formatOpuCoordinate(current.opu.lat);
    const lngValue = formatOpuCoordinate(current.opu.lng);
    const ugolValue = formatOpuAngleValue(current.opu.ugol);
    const centrValue = formatOpuAngleValue(current.opu.centr_ugol);
    const speedValue = formatOpuPlainValue(current.opu.speed);

    latEl.textContent = latValue;
    lngEl.textContent = lngValue;
    ugolInlineEl.textContent = ugolValue;
    centrInlineEl.textContent = centrValue;
    speedInlineEl.textContent = speedValue === "—" ? "—" : speedValue;
    gaugeValueEl.textContent = ugolValue;

    const gaugeAngle = getOpuGaugeNeedleAngle(current.opu.ugol);
    gaugeEl.style.setProperty("--opu-angle-deg", `${gaugeAngle}`);
    needleWrapEl.style.setProperty("--opu-angle-deg", `${gaugeAngle}`);

    inputUgol.placeholder = ugolValue === "—" ? "угол" : ugolValue;
    inputCentr.placeholder = centrValue === "—" ? "центр" : centrValue;
    inputSpeed.placeholder = speedValue === "—" ? "скорость" : speedValue;
    btnFillUgol.disabled = ugolValue === "—";
    btnFillCentr.disabled = centrValue === "—";
    btnFillSpeed.disabled = speedValue === "—";
  }

  update(windowView);

  return {
    windowId: windowView.windowId,
    el,
    headerEl,
    update,
    destroy: () => {},
  };
}

function focusInputCaret(input: HTMLInputElement): void {
  if (input.disabled) return;
  input.focus({ preventScroll: true });
  const pos = input.value.length;
  try {
    input.setSelectionRange(pos, pos);
  } catch {
    // fail-soft for non-text-capable inputs
  }
}

function sanitizeSignedDecimalInput(value: string, maxLength = 12): string {
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 12;
  const raw = String(value ?? "").replace(/,/g, ".");
  let result = "";
  let hasDot = false;
  let hasSign = false;

  for (const ch of raw) {
    if (/^\d$/.test(ch)) {
      if (result.length >= limit) break;
      result += ch;
      continue;
    }

    if (ch === "-" && !hasSign && result.length === 0) {
      if (result.length >= limit) break;
      result = "-";
      hasSign = true;
      continue;
    }

    if (ch === "." && !hasDot) {
      const prefix = result === "" || result === "-" ? `${result}0` : result;
      if (prefix.length + 1 > limit) break;
      result = `${prefix}.`;
      hasDot = true;
    }
  }

  return result;
}

function openInputKeypad(deps: {
  keypad: ReturnType<typeof createNumericKeypad>;
  input: HTMLInputElement;
  title: string;
  onConfirm: (value: string) => void;
  allowDecimal?: boolean;
  allowNegative?: boolean;
  maxLength?: number;
  startEmpty?: boolean;
}): void {
  const { keypad, input, title, onConfirm, allowDecimal = false, allowNegative = false, maxLength = 5, startEmpty = false } = deps;
  if (input.disabled || input.readOnly) return;
  focusInputCaret(input);
  keypad.open({
    title,
    initialValue: startEmpty ? "" : input.value,
    allowDecimal,
    allowNegative,
    maxLength,
    onConfirm,
  });
}

function bindInteractiveInputField(deps: {
  input: HTMLInputElement;
  openKeypad: () => void;
  resolveTargetInput?: () => HTMLInputElement;
}): void {
  const { input, openKeypad, resolveTargetInput } = deps;
  let lastClickAt = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  let lastKeypadOpenAt = 0;

  function getTargetInput(): HTMLInputElement {
    return resolveTargetInput ? resolveTargetInput() : input;
  }

  function focusTargetInput(): void {
    const targetInput = getTargetInput();
    if (targetInput.disabled || targetInput.readOnly) return;
    focusInputCaret(targetInput);
  }

  function triggerKeypadOpen(): void {
    const now = performance.now();
    if (now - lastKeypadOpenAt < 120) return;
    lastKeypadOpenAt = now;
    openKeypad();
  }

  input.autocomplete = "off";
  input.spellcheck = false;

  input.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
  });

  input.addEventListener("click", (ev) => {
    ev.stopPropagation();
    focusTargetInput();

    const now = performance.now();
    const withinTime = now - lastClickAt <= 340;
    const withinDistance = Math.hypot(ev.clientX - lastClickX, ev.clientY - lastClickY) <= 6;
    lastClickAt = now;
    lastClickX = ev.clientX;
    lastClickY = ev.clientY;

    if (withinTime && withinDistance) {
      ev.preventDefault();
      lastClickAt = 0;
      triggerKeypadOpen();
    }
  });

  input.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    lastClickAt = 0;
    triggerKeypadOpen();
  });
}

function resolveTitlePatch(current: WindowViewModel, nextTitle: string): { title: string; titleMode: "default" | "custom" } | null {
  const trimmed = nextTitle.trim();
  if (trimmed.length === 0) return null;
  if (current.titleMode === "default" && trimmed === current.title) {
    return { title: current.title, titleMode: "default" };
  }
  return { title: trimmed, titleMode: "custom" };
}

function wheelStepToNumber(step: WheelStepMultiplier): 1 | 2 | 5 | 10 {
  switch (step) {
    case "x2":
      return 2;
    case "x5":
      return 5;
    case "x10":
      return 10;
    case "x1":
    default:
      return 1;
  }
}

function formatScenarioButtonLabel(label: string, scenario: 1 | 2): string {
  const base = label.trim().length > 0 ? label.trim() : "Сценарий";
  return `${base} ${scenario}`;
}

function formatNumber(value: unknown): string {
  return typeof value === "number" ? String(value) : "—";
}

function formatOpuPlainValue(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatOpuAngleValue(value: unknown): string {
  const base = formatOpuPlainValue(value);
  return base === "—" ? base : `${base}°`;
}

function formatOpuCoordinate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(6);
}

function getOpuGaugeNeedleAngle(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const clamped = Math.max(-180, Math.min(180, value));
  return (clamped / 180) * 90;
}

function formatArray(arr: unknown): string {
  return Array.isArray(arr) ? `[${arr.join(", ")}]` : "—";
}

function formatMetricValue(value: unknown): string {
  return typeof value === "number" ? String(value) : "—";
}

function formatTxMetricValue(value: unknown, unit: string, fractionDigits: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const digits = Number.isInteger(value) ? 0 : Math.max(0, fractionDigits);
  const localized = value.toFixed(digits).replace('.', ',').replace(/,00$/, '').replace(/(,\d)0$/, '$1');
  return `${localized}${unit}`;
}

function createBeepPlayer(): () => void {
  const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return () => {
      // fail-soft: audio API not available
    };
  }

  let ctx: AudioContext | null = null;
  let audioUnlocked = false;
  let releaseUnlockListeners: (() => void) | null = null;
  let unlockInFlight: Promise<void> | null = null;

  function ensureContext(): AudioContext {
    if (!ctx) ctx = new AudioCtx();
    return ctx;
  }

  function detachUnlockListeners(): void {
    releaseUnlockListeners?.();
    releaseUnlockListeners = null;
  }

  function armUnlockListeners(): void {
    if (releaseUnlockListeners) return;

    const unlock = () => {
      if (unlockInFlight) return;
      unlockInFlight = (async () => {
        try {
          const audio = ensureContext();
          if (audio.state === "suspended") {
            await audio.resume();
          }
          audioUnlocked = audio.state === "running";
          if (audioUnlocked) {
            detachUnlockListeners();
          }
        } catch {
          // fail-soft: keep silent until the browser allows resume
        } finally {
          unlockInFlight = null;
        }
      })();
    };

    const eventTypes: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "mousedown", "touchstart", "wheel"];
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, unlock, { capture: true, passive: true });
    }

    releaseUnlockListeners = () => {
      for (const eventType of eventTypes) {
        window.removeEventListener(eventType, unlock, { capture: true } as EventListenerOptions);
      }
    };
  }

  armUnlockListeners();

  return () => {
    if (!audioUnlocked) return;

    const audio = ensureContext();
    if (audio.state !== "running") return;

    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.06;

    osc.connect(gain);
    gain.connect(audio.destination);

    const now = audio.currentTime;
    osc.start(now);
    osc.stop(now + 0.08);
  };
}
