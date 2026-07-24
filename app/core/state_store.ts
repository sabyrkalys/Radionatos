/**
 * MODULE: app/core/state_store.ts
 *
 * Назначение:
 *   Единый StateStore Sprint 4, разделяющий:
 *   - serializable config state (`AppConfig`),
 *   - runtime state окон/устройств (`WindowRuntimeState`).
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.3, §4.1–§4.9, §7.1, §7.2, §11
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §3.2, §4.5, §4.8, §4.10, §5.6.4
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1–4, особенно D4-1..D4-6 / AC4-1..AC4-12
 *
 * Инварианты уровня модуля:
 *   - Runtime и serializable config разделены в одном state tree, но не смешиваются по смыслу.
 *   - `windowId` является primary identity окна; target IP остаётся редактируемым config-полем.
 *   - Store хранит только сериализуемые структуры; live WebSocket-объекты сюда не попадают.
 *   - Одно действие → один новый снапшот → уведомление подписчиков.
 *
 * Запрещено:
 *   - Связывать identity окна только с IP.
 *   - Хранить WS/DOM refs/FIFO runtime pointers в config slice.
 *   - Вводить скрытые side-effects уровня сети/DOM внутри store.
 */

import {
  cloneAppConfig,
  createDefaultAppConfig,
  type AppConfig,
  type DeviceType,
  type WheelStepMultiplier,
  type WindowConfig,
  type WindowId,
} from "../contracts/config.js";

export type WsStatus = "connecting" | "open" | "closed";
export type OnlineStatus = "online" | "offline";

export type CommonState = {
  name: string | null;
  poz: number | null;
  ip: number[] | null;
  mac: number[] | null;
  mask: number[] | null;
  gw: number[] | null;
};

export type FrequencyRange = { min: number; max: number } | null;

export type RxState = {
  ud?: boolean;
  inv?: boolean;
  frq?: number;
  rssi?: number;
  frq_range?: number[];
  frq_ignor?: number[];
  fon_scan?: boolean;
  spectr_rssi?: number[];
};

export type TxState = {
  U?: number;
  I?: number;
  P?: number;
  T?: number;
  tx_ch?: number;
  frq_tx_out?: number[];
  frq_range?: number[];
};

export type OpuState = {
  lat?: number;
  lng?: number;
  ugol?: number;
  centr_ugol?: number;
  speed?: number;
};

export type WindowRuntimeState = {
  windowId: WindowId;
  ws: { status: WsStatus; error: string | null };
  presence: { status: OnlineStatus; lastValidJsonAt: number | null };
  common: CommonState;
  range: FrequencyRange;
  rx: RxState;
  tx: TxState;
  opu: OpuState;
};

export type WindowViewModel = WindowConfig & WindowRuntimeState;

export type AppState = {
  config: AppConfig;
  runtime: {
    windows: Record<WindowId, WindowRuntimeState>;
  };
};

export type StoreAction = {
  type: string;
  payload?: any;
};

type RuntimeFrameBundle = {
  windowId: WindowId;
  commonPatch?: Partial<CommonState> | null;
  range?: FrequencyRange | null;
  rxPatch?: Partial<RxState> | null;
  txPatch?: Partial<TxState> | null;
  opuPatch?: Partial<OpuState> | null;
};

export type StateStore = {
  getState: () => AppState;
  getConfig: () => AppConfig;
  getWindowViews: () => WindowViewModel[];
  getWindowView: (windowId: WindowId) => WindowViewModel | null;
  getWindowIdByTargetIp: (targetIp: string) => WindowId | null;
  hasTargetIp: (targetIp: string, exceptWindowId?: WindowId | null) => boolean;
  subscribe: (listener: (state: AppState) => void) => () => void;
  dispatch: (action: StoreAction) => void;
};

const INITIAL_STATE: AppState = {
  config: createDefaultAppConfig(),
  runtime: {
    windows: {},
  },
};

/**
 * Назначение:
 *   Создать StateStore Sprint 4 с helper-selectors для config/runtime slice.
 *
 * Preconditions:
 *   - Внешние зависимости не требуются.
 *
 * Postconditions:
 *   - Возвращает API `getState / getConfig / getWindowViews / subscribe / dispatch`.
 *
 * Инварианты:
 *   - Каждое `dispatch()` работает на копии state и не мутирует предыдущий снапшот.
 *   - `getWindowViews()` объединяет config/runtime по `windowId` и сортирует окна по `order`.
 *   - Runtime placeholder существует для каждого config-window.
 *
 * State transitions:
 *   - `state: AppState -> AppState` для каждого действия.
 *
 * Execution Trace:
 *   1. Инициализировать state из `INITIAL_STATE`.
 *   2. Инициализировать набор подписчиков.
 *   3. Реализовать selectors по `windowId` и `targetIp`.
 *   4. Реализовать `dispatch()` как clone -> reduce -> normalize -> notify.
 */
export function createStateStore(): StateStore {
  let state = deepClone(INITIAL_STATE);
  const listeners = new Set<(state: AppState) => void>();

  function getState(): AppState {
    return state;
  }

  function getConfig(): AppConfig {
    return cloneAppConfig(state.config);
  }

  function getWindowViews(): WindowViewModel[] {
    return buildWindowViews(state);
  }

  function getWindowView(windowId: WindowId): WindowViewModel | null {
    return getWindowViews().find((windowView) => windowView.windowId === windowId) ?? null;
  }

  function getWindowIdByTargetIp(targetIp: string): WindowId | null {
    const windowConfig = state.config.windows.find((item) => item.targetIp === targetIp);
    return windowConfig?.windowId ?? null;
  }

  function hasTargetIp(targetIp: string, exceptWindowId: WindowId | null = null): boolean {
    return state.config.windows.some(
      (windowConfig) => windowConfig.targetIp === targetIp && windowConfig.windowId !== exceptWindowId,
    );
  }

  function subscribe(listener: (state: AppState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispatch(action: StoreAction): void {
    const next = deepClone(state);
    reduce(next, action);
    normalize(next);
    state = next;

    for (const listener of listeners) {
      listener(state);
    }
  }

  return {
    getState,
    getConfig,
    getWindowViews,
    getWindowView,
    getWindowIdByTargetIp,
    hasTargetIp,
    subscribe,
    dispatch,
  };
}

/**
 * Назначение:
 *   Применить одно детерминированное действие к копии state.
 *
 * Preconditions:
 *   - `state` является mutable-копией текущего снапшота.
 *   - `action.type` соответствует одному из поддерживаемых reducer-case.
 *
 * Postconditions:
 *   - Изменены только те ветви state, которых касается действие.
 *
 * Инварианты:
 *   - Reducer не создаёт network/DOM side-effects.
 *   - Любая неизвестная action type игнорируется fail-soft.
 *
 * State transitions:
 *   - `config/*` меняют serializable slice.
 *   - `runtime/*` меняют runtime slice.
 *
 * Execution Trace:
 *   1. Разобрать `action.type`.
 *   2. Применить локальное изменение к `state`.
 *   3. Неизвестный тип оставить без эффекта.
 */
function reduce(state: AppState, action: StoreAction): void {
  switch (action.type) {
    case "config/replaceAll": {
      const config = cloneAppConfig(action.payload.config as AppConfig);
      state.config = config;
      state.runtime.windows = {};
      for (const windowConfig of config.windows) {
        state.runtime.windows[windowConfig.windowId] = createEmptyWindowRuntime(windowConfig.windowId);
      }
      return;
    }

    case "config/setIpRanges": {
      state.config.ipRanges = {
        rx: { ...action.payload.rx },
        tx: { ...action.payload.tx },
      };
      return;
    }

    case "config/addWindow": {
      const windowConfig = deepClone(action.payload.windowConfig as WindowConfig);
      if (state.config.windows.some((item) => item.windowId === windowConfig.windowId)) return;
      if (state.config.windows.some((item) => item.targetIp === windowConfig.targetIp)) return;
      state.config.windows.push(windowConfig);
      state.runtime.windows[windowConfig.windowId] = createEmptyWindowRuntime(windowConfig.windowId);
      return;
    }

    case "config/updateWindow": {
      const { windowId, patch } = action.payload as { windowId: WindowId; patch: Partial<WindowConfig> };
      const windowConfig = state.config.windows.find((item) => item.windowId === windowId);
      if (!windowConfig) return;
      Object.assign(windowConfig, patch);
      return;
    }

    case "config/removeWindow": {
      const { windowId } = action.payload as { windowId: WindowId };
      state.config.windows = state.config.windows.filter((item) => item.windowId !== windowId);
      delete state.runtime.windows[windowId];

      const nextScenarioGroups: AppConfig["scenarioGroups"] = {};
      for (const [groupKey, preference] of Object.entries(state.config.scenarioGroups)) {
        const queueOrder = preference.queueOrder.filter((item) => item !== windowId);
        if (queueOrder.length === 0) continue;
        nextScenarioGroups[groupKey] = {
          scenario: preference.scenario,
          queueOrder,
        };
      }
      state.config.scenarioGroups = nextScenarioGroups;
      return;
    }

    case "config/setWindowOrder": {
      const { windowIds, layoutCustomized, layoutRowStarts } = action.payload as {
        windowIds: WindowId[];
        layoutCustomized: boolean;
        layoutRowStarts?: WindowId[];
      };
      const orderMap = new Map(windowIds.map((windowId, index) => [windowId, index]));
      for (const windowConfig of state.config.windows) {
        if (orderMap.has(windowConfig.windowId)) {
          windowConfig.order = orderMap.get(windowConfig.windowId) ?? windowConfig.order;
        }
      }
      state.config.layoutCustomized = layoutCustomized;
      state.config.layoutRowStarts = Array.isArray(layoutRowStarts) ? layoutRowStarts.slice() : [];
      return;
    }

    case "config/setScenarioGroup": {
      const { groupKey, scenario, queueOrder } = action.payload as {
        groupKey: string;
        scenario: 1 | 2;
        queueOrder: WindowId[];
      };
      state.config.scenarioGroups[groupKey] = {
        scenario,
        queueOrder: queueOrder.slice(),
      };
      return;
    }

    case "config/deleteScenarioGroup": {
      const { groupKey } = action.payload as { groupKey: string };
      delete state.config.scenarioGroups[groupKey];
      return;
    }

    case "runtime/ensureWindow": {
      const { windowId } = action.payload as { windowId: WindowId };
      if (!state.runtime.windows[windowId]) {
        state.runtime.windows[windowId] = createEmptyWindowRuntime(windowId);
      }
      return;
    }

    case "runtime/resetWindow": {
      const { windowId } = action.payload as { windowId: WindowId };
      state.runtime.windows[windowId] = createEmptyWindowRuntime(windowId);
      return;
    }

    case "runtime/clearAll": {
      state.runtime.windows = {};
      return;
    }

    case "runtime/wsStatus": {
      const { windowId, status, error } = action.payload as {
        windowId: WindowId;
        status: WsStatus;
        error: string | null;
      };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.ws.status = status;
      runtimeWindow.ws.error = error;
      return;
    }

    case "runtime/presence": {
      const { windowId, status } = action.payload as { windowId: WindowId; status: OnlineStatus };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.presence.status = status;
      return;
    }

    case "runtime/lastValidJsonAt": {
      const { windowId, atMs } = action.payload as { windowId: WindowId; atMs: number };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.presence.lastValidJsonAt = atMs;
      return;
    }

    case "runtime/validJsonSeen": {
      const { windowId, atMs } = action.payload as { windowId: WindowId; atMs: number };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.presence.lastValidJsonAt = atMs;
      if (runtimeWindow.ws.status === "open") {
        runtimeWindow.presence.status = "online";
      }
      return;
    }

    case "runtime/commonPatch": {
      const { windowId, patch } = action.payload as { windowId: WindowId; patch: Partial<CommonState> };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.common = { ...runtimeWindow.common, ...patch };
      return;
    }

    case "runtime/range": {
      const { windowId, range } = action.payload as { windowId: WindowId; range: FrequencyRange };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.range = range;
      return;
    }

    case "runtime/rxPatch": {
      const { windowId, patch } = action.payload as { windowId: WindowId; patch: Partial<RxState> };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.rx = { ...runtimeWindow.rx, ...patch };
      return;
    }

    case "runtime/txPatch": {
      const { windowId, patch } = action.payload as { windowId: WindowId; patch: Partial<TxState> };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.tx = { ...runtimeWindow.tx, ...patch };
      return;
    }

    case "runtime/opuPatch": {
      const { windowId, patch } = action.payload as { windowId: WindowId; patch: Partial<OpuState> };
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      runtimeWindow.opu = { ...runtimeWindow.opu, ...patch };
      return;
    }

    case "runtime/windowFrameBundle": {
      const { windowId, commonPatch, range, rxPatch, txPatch, opuPatch } = action.payload as RuntimeFrameBundle;
      const runtimeWindow = ensureRuntimeWindow(state, windowId);
      if (commonPatch && Object.keys(commonPatch).length > 0) {
        runtimeWindow.common = { ...runtimeWindow.common, ...commonPatch };
      }
      if (range !== undefined) {
        runtimeWindow.range = range;
      }
      if (rxPatch && Object.keys(rxPatch).length > 0) {
        runtimeWindow.rx = { ...runtimeWindow.rx, ...rxPatch };
      }
      if (txPatch && Object.keys(txPatch).length > 0) {
        runtimeWindow.tx = { ...runtimeWindow.tx, ...txPatch };
      }
      if (opuPatch && Object.keys(opuPatch).length > 0) {
        runtimeWindow.opu = { ...runtimeWindow.opu, ...opuPatch };
      }
      return;
    }

    default:
      return;
  }
}

/**
 * Назначение:
 *   Нормализовать state после reducer-шага: order, runtime placeholders и default titles.
 *
 * Preconditions:
 *   - `state` уже содержит reducer-изменения текущего действия.
 *
 * Postconditions:
 *   - `config.windows` упорядочены последовательностью `0..N-1`.
 *   - Для каждого config-window существует runtime placeholder.
 *   - Для окон с `titleMode="default"` display-title детерминированно пересчитан из runtime common/range и suffix rules.
 *
 * Инварианты:
 *   - Группировка одинаковых RX/TX для suffix rules использует `type + common.name + frq_range`.
 *   - User-edited `titleMode="custom"` никогда не переписывается normalize-логикой.
 *   - OPU-menu не появляется; normalization меняет только data state.
 *
 * State transitions:
 *   - `config.windows[*].order`: arbitrary -> sequential
 *   - `config.windows[*].title`: old default -> recomputed default
 *
 * Execution Trace:
 *   1. Упорядочить окна и обеспечить runtime placeholders.
 *   2. Сформировать base-title для окон с `titleMode=default`.
 *   3. Для одинаковых RX/TX применить suffix `(1)`, `(2)` по `createdAtMs`.
 *   4. Удалить runtime entries, отсутствующие в config.
 */
function normalizeLayoutRowStarts(rowStarts: WindowId[] | undefined, orderedWindowIds: WindowId[]): WindowId[] {
  if (!rowStarts || rowStarts.length === 0) return [];

  const allowed = new Set(orderedWindowIds);
  const firstWindowId = orderedWindowIds[0] ?? null;
  const normalized: WindowId[] = [];
  const seen = new Set<string>();

  for (const rowStart of rowStarts) {
    if (!allowed.has(rowStart)) continue;
    if (rowStart === firstWindowId) continue;
    if (seen.has(rowStart)) continue;
    seen.add(rowStart);
    normalized.push(rowStart);
  }

  normalized.sort((left, right) => orderedWindowIds.indexOf(left) - orderedWindowIds.indexOf(right));
  return normalized;
}

function normalize(state: AppState): void {
  const sortedWindows = state.config.layoutCustomized
    ? state.config.windows
        .slice()
        .sort((a, b) => a.order - b.order || a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId))
    : state.config.windows
        .slice()
        .sort(
          (a, b) =>
            getDefaultTypeRank(a.deviceType) - getDefaultTypeRank(b.deviceType) ||
            a.createdAtMs - b.createdAtMs ||
            a.windowId.localeCompare(b.windowId),
        );

  state.config.windows = sortedWindows.map((windowConfig, index) => ({
    ...windowConfig,
    order: index,
    buttonLabels: { ...windowConfig.buttonLabels },
  }));

  const orderedWindowIds = state.config.windows.map((windowConfig) => windowConfig.windowId);
  state.config.layoutRowStarts = normalizeLayoutRowStarts(state.config.layoutRowStarts, orderedWindowIds);

  const configWindowIds = new Set(orderedWindowIds);
  for (const windowConfig of state.config.windows) {
    if (!state.runtime.windows[windowConfig.windowId]) {
      state.runtime.windows[windowConfig.windowId] = createEmptyWindowRuntime(windowConfig.windowId);
    }
  }
  for (const runtimeWindowId of Object.keys(state.runtime.windows)) {
    if (!configWindowIds.has(runtimeWindowId)) {
      delete state.runtime.windows[runtimeWindowId];
    }
  }

  const baseTitleMap = new Map<WindowId, string>();
  for (const windowConfig of state.config.windows) {
    if (windowConfig.titleMode !== "default") continue;
    const runtimeWindow = state.runtime.windows[windowConfig.windowId] ?? createEmptyWindowRuntime(windowConfig.windowId);
    baseTitleMap.set(windowConfig.windowId, computeBaseDefaultTitle(windowConfig, runtimeWindow));
  }

  const suffixGroups = new Map<string, WindowConfig[]>();
  for (const windowConfig of state.config.windows) {
    if (windowConfig.titleMode !== "default") continue;
    const runtimeWindow = state.runtime.windows[windowConfig.windowId];
    const identityKey = computeIdentityKeyForDefaultTitle(windowConfig.deviceType, runtimeWindow);
    if (!identityKey) continue;

    const list = suffixGroups.get(identityKey);
    if (list) list.push(windowConfig);
    else suffixGroups.set(identityKey, [windowConfig]);
  }

  for (const windowConfig of state.config.windows) {
    if (windowConfig.titleMode !== "default") continue;
    windowConfig.title = baseTitleMap.get(windowConfig.windowId) ?? windowConfig.title;
  }

  for (const group of suffixGroups.values()) {
    group.sort((a, b) => a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId));
    for (let index = 0; index < group.length; index += 1) {
      const windowConfig = group[index];
      const baseTitle = baseTitleMap.get(windowConfig.windowId) ?? windowConfig.title;
      windowConfig.title = index === 0 ? baseTitle : `${baseTitle} (${index})`;
    }
  }
}

function buildWindowViews(state: AppState): WindowViewModel[] {
  return state.config.windows
    .slice()
    .sort((a, b) => a.order - b.order || a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId))
    .map((windowConfig) => {
      const runtimeWindow = state.runtime.windows[windowConfig.windowId] ?? createEmptyWindowRuntime(windowConfig.windowId);
      return {
        ...windowConfig,
        ...runtimeWindow,
        buttonLabels: { ...windowConfig.buttonLabels },
      };
    });
}

function createEmptyWindowRuntime(windowId: WindowId): WindowRuntimeState {
  return {
    windowId,
    ws: { status: "closed", error: null },
    presence: { status: "offline", lastValidJsonAt: null },
    common: {
      name: null,
      poz: null,
      ip: null,
      mac: null,
      mask: null,
      gw: null,
    },
    range: null,
    rx: {},
    tx: {},
    opu: {},
  };
}

function ensureRuntimeWindow(state: AppState, windowId: WindowId): WindowRuntimeState {
  if (!state.runtime.windows[windowId]) {
    state.runtime.windows[windowId] = createEmptyWindowRuntime(windowId);
  }
  return state.runtime.windows[windowId];
}

function computeBaseDefaultTitle(windowConfig: WindowConfig, runtimeWindow: WindowRuntimeState): string {
  const fallbackName = windowConfig.deviceType;
  const runtimeName = typeof runtimeWindow.common.name === "string" && runtimeWindow.common.name.trim().length > 0
    ? runtimeWindow.common.name.trim()
    : null;

  const name = runtimeName ?? fallbackName;

  if (windowConfig.deviceType === "opu") {
    return name;
  }

  if (runtimeWindow.range) {
    return `${name} ${runtimeWindow.range.min}-${runtimeWindow.range.max}`.trim();
  }

  return windowConfig.title || `${name} ?-?`;
}

function getDefaultTypeRank(deviceType: DeviceType): number {
  switch (deviceType) {
    case "rx":
      return 0;
    case "tx":
      return 1;
    case "opu":
      return 2;
    default:
      return 99;
  }
}

function computeIdentityKeyForDefaultTitle(
  deviceType: DeviceType,
  runtimeWindow: WindowRuntimeState | undefined,
): string | null {
  if (!runtimeWindow) return null;
  if (deviceType !== "rx" && deviceType !== "tx") return null;
  if (!runtimeWindow.range) return null;
  if (!runtimeWindow.common.name) return null;

  return `${deviceType}|${runtimeWindow.common.name.trim().toLowerCase()}|${runtimeWindow.range.min}-${runtimeWindow.range.max}`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export { INITIAL_STATE };
