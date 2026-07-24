/**
 * MODULE: app/core/device_registry.ts
 *
 * Назначение:
 *   DeviceRegistry / runtime WS orchestration Sprint 4:
 *   - scan по IP ranges с discovery gate,
 *   - deterministic typing A→B→unknown(close),
 *   - создание новых окон/config entries,
 *   - reconnect уже сохранённых окон по target IP,
 *   - антидубликаты по текущему target IP.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.1–§2.4, §4.2–§4.7
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.1, §4.2, §4.8
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1 AC1-3..AC1-11, Sprint 4 AC4-1..AC4-12
 *
 * Инварианты уровня модуля:
 *   - Единственный transport = `ws://<ip>/ws` через ws_transport.
 *   - Discovery success = WS open + >=1 valid JSON-object.
 *   - Unknown type => окно не создаётся, WS закрывается.
 *   - Anti-duplicate работает по актуальному `targetIp`.
 *
 * Запрещено:
 *   - Любой HTTP/DATA/polling.
 *   - Legacy routing/typing.
 *   - New reroute/retry/fallback behavior вне SSOT.
 */

import { isCommonObject, normalizeDeviceName } from "../contracts/canon.js";
import { createWindowConfig, type DeviceType, type WindowId } from "../contracts/config.js";
import type { createWsTransport } from "../adapters/ws_transport.js";
import type { ConfigStore } from "./config_store.js";
import type { createMessageRouter } from "./message_router.js";
import type { createPresenceTracker } from "./presence_tracker.js";
import type { StateStore } from "./state_store.js";
import { determineDeviceType } from "./typing.js";

export type IpRanges = {
  rx: { start: string; end: string };
  tx: { start: string; end: string };
};

type PendingDiscoveryEntry = {
  targetIp: string;
  epoch: number;
  token: number;
  timeoutId: number;
  resolved: boolean;
  openSeen: boolean;
  resolve: (discovered: boolean) => void;
};

type ConnectionOwner =
  | { phase: "discovery"; epoch: number; token: number; windowId: null }
  | { phase: "runtime"; epoch: number; token: number; windowId: WindowId };

type RuntimeOwner = {
  token: number;
  targetIp: string;
};

/**
 * Назначение:
 *   Создать реестр устройств и connect/discovery orchestration слой Sprint 4.
 */
export function createDeviceRegistry(deps: {
  store: StateStore;
  configStore: ConfigStore;
  wsTransport: ReturnType<typeof createWsTransport>;
  presenceTracker: ReturnType<typeof createPresenceTracker>;
  messageRouter: ReturnType<typeof createMessageRouter>;
  discoveryTimeoutMs: number;
  scanConcurrency: number;
}): {
  scan: (ranges: IpRanges) => Promise<{ attempted: number; discovered: number }>;
  activateQueuedWindows: () => Promise<void>;
  prepareFreshScan: () => Promise<void>;
  closeAll: () => void;
  disconnectWindow: (windowId: WindowId) => void;
  connectConfiguredWindows: () => void;
  connectWindow: (windowId: WindowId, resetRuntime?: boolean) => void;
  reconnectWindow: (windowId: WindowId) => void;
} {
  const { store, configStore, wsTransport, presenceTracker, messageRouter, discoveryTimeoutMs, scanConcurrency } = deps;

  const pendingDiscovery = new Map<string, PendingDiscoveryEntry>();
  const reconnectTimers = new Map<WindowId, number>();
  const reconnectSuppressed = new Set<WindowId>();
  const runtimeSilenceTimers = new Map<WindowId, number>();
  const connectionOwnersByIp = new Map<string, ConnectionOwner>();
  const runtimeOwnersByWindow = new Map<WindowId, RuntimeOwner>();
  const queuedRuntimeActivationIds: WindowId[] = [];
  const queuedRuntimeActivationSet = new Set<WindowId>();

  const runtimeSilenceTimeoutMs = Math.max(discoveryTimeoutMs, 4000);
  const transportDrainTimeoutMs = Math.max(300, Math.min(800, discoveryTimeoutMs));
  const runtimeActivationGapMs = 60;

  let scanEpoch = 0;
  let connectionSeq = 0;

  function nextConnectionToken(): number {
    connectionSeq += 1;
    return connectionSeq;
  }

  function beginDiscoveryEpoch(): number {
    scanEpoch += 1;
    return scanEpoch;
  }

  function clearReconnectTimer(windowId: WindowId): void {
    const existing = reconnectTimers.get(windowId);
    if (existing === undefined) return;
    window.clearTimeout(existing);
    reconnectTimers.delete(windowId);
  }

  function clearRuntimeSilenceTimer(windowId: WindowId): void {
    const existing = runtimeSilenceTimers.get(windowId);
    if (existing === undefined) return;
    window.clearTimeout(existing);
    runtimeSilenceTimers.delete(windowId);
  }

  function suppressReconnect(windowId: WindowId): void {
    reconnectSuppressed.add(windowId);
    clearReconnectTimer(windowId);
    clearRuntimeSilenceTimer(windowId);
  }

  function allowReconnect(windowId: WindowId): void {
    reconnectSuppressed.delete(windowId);
    clearReconnectTimer(windowId);
    clearRuntimeSilenceTimer(windowId);
  }

  function shouldAutoReconnect(windowId: WindowId, targetIp: string): boolean {
    const windowView = store.getWindowView(windowId);
    if (!windowView) return false;
    if (windowView.targetIp !== targetIp) return false;
    if (reconnectSuppressed.has(windowId)) return false;
    return true;
  }

  function scheduleReconnect(windowId: WindowId, targetIp: string): void {
    if (!shouldAutoReconnect(windowId, targetIp)) return;
    if (reconnectTimers.has(windowId)) return;

    const timeoutId = window.setTimeout(() => {
      reconnectTimers.delete(windowId);
      if (!shouldAutoReconnect(windowId, targetIp)) return;
      connectWindow(windowId, false);
    }, 1500);

    reconnectTimers.set(windowId, timeoutId);
  }

  function armRuntimeSilenceTimer(windowId: WindowId, targetIp: string): void {
    clearRuntimeSilenceTimer(windowId);
    if (!shouldAutoReconnect(windowId, targetIp)) return;

    const timeoutId = window.setTimeout(() => {
      runtimeSilenceTimers.delete(windowId);
      if (!shouldAutoReconnect(windowId, targetIp)) return;

      const runtimeWindow = store.getState().runtime.windows[windowId] ?? null;
      if (!runtimeWindow || runtimeWindow.ws.status !== "open") return;

      wsTransport.close(targetIp);
    }, runtimeSilenceTimeoutMs);

    runtimeSilenceTimers.set(windowId, timeoutId);
  }

  function setDiscoveryOwner(targetIp: string, epoch: number, token: number): void {
    connectionOwnersByIp.set(targetIp, { phase: "discovery", epoch, token, windowId: null });
  }

  function clearDiscoveryOwner(targetIp: string, token?: number): void {
    const current = connectionOwnersByIp.get(targetIp);
    if (!current || current.phase !== "discovery") return;
    if (token !== undefined && current.token !== token) return;
    connectionOwnersByIp.delete(targetIp);
  }

  function setRuntimeOwner(windowId: WindowId, targetIp: string, token: number): void {
    clearRuntimeOwner(windowId);
    connectionOwnersByIp.set(targetIp, { phase: "runtime", epoch: scanEpoch, token, windowId });
    runtimeOwnersByWindow.set(windowId, { token, targetIp });
  }

  function clearRuntimeOwner(windowId: WindowId): void {
    const runtimeOwner = runtimeOwnersByWindow.get(windowId);
    if (!runtimeOwner) return;

    runtimeOwnersByWindow.delete(windowId);

    const current = connectionOwnersByIp.get(runtimeOwner.targetIp);
    if (
      current &&
      current.phase === "runtime" &&
      current.windowId === windowId &&
      current.token === runtimeOwner.token
    ) {
      connectionOwnersByIp.delete(runtimeOwner.targetIp);
    }
  }

  function isCurrentDiscoveryOwner(targetIp: string, epoch: number, token: number): boolean {
    const current = connectionOwnersByIp.get(targetIp);
    return !!current && current.phase === "discovery" && current.epoch === epoch && current.token === token;
  }

  function isCurrentRuntimeOwner(windowId: WindowId, targetIp: string, token: number): boolean {
    const windowView = store.getWindowView(windowId);
    if (!windowView || windowView.targetIp !== targetIp) return false;

    const runtimeOwner = runtimeOwnersByWindow.get(windowId);
    if (!runtimeOwner || runtimeOwner.token !== token || runtimeOwner.targetIp !== targetIp) return false;

    const current = connectionOwnersByIp.get(targetIp);
    return !!current && current.phase === "runtime" && current.windowId === windowId && current.token === token;
  }

  function consumePendingDiscovery(targetIp: string, epoch: number, token: number): PendingDiscoveryEntry | null {
    const pending = pendingDiscovery.get(targetIp);
    if (!pending || pending.resolved) return null;
    if (pending.epoch !== epoch || pending.token !== token) return null;

    pending.resolved = true;
    pendingDiscovery.delete(targetIp);
    window.clearTimeout(pending.timeoutId);
    return pending;
  }

  function cancelPendingDiscovery(targetIp: string): void {
    const pending = pendingDiscovery.get(targetIp);
    if (!pending || pending.resolved) return;

    pending.resolved = true;
    pendingDiscovery.delete(targetIp);
    window.clearTimeout(pending.timeoutId);
    clearDiscoveryOwner(targetIp, pending.token);
    pending.resolve(false);
    wsTransport.close(targetIp);
  }

  function cancelAllPendingDiscovery(): void {
    const targets = Array.from(pendingDiscovery.keys());
    for (const targetIp of targets) {
      cancelPendingDiscovery(targetIp);
    }
  }

  function clearQueuedRuntimeActivations(): void {
    queuedRuntimeActivationIds.length = 0;
    queuedRuntimeActivationSet.clear();
  }

  function queueRuntimeActivation(windowId: WindowId): void {
    if (queuedRuntimeActivationSet.has(windowId)) return;
    queuedRuntimeActivationSet.add(windowId);
    queuedRuntimeActivationIds.push(windowId);
  }

  function takeQueuedRuntimeActivations(): WindowId[] {
    const queued = queuedRuntimeActivationIds.slice();
    clearQueuedRuntimeActivations();
    return queued;
  }

  function markAllRuntimeWindowsClosed(): void {
    for (const windowView of store.getWindowViews()) {
      store.dispatch({
        type: "runtime/wsStatus",
        payload: { windowId: windowView.windowId, status: "closed", error: null },
      });
      store.dispatch({ type: "runtime/presence", payload: { windowId: windowView.windowId, status: "offline" } });
    }
  }

  function invalidateLifecycleState(): void {
    beginDiscoveryEpoch();
    cancelAllPendingDiscovery();
    clearQueuedRuntimeActivations();
    connectionOwnersByIp.clear();
    runtimeOwnersByWindow.clear();
  }

  async function prepareFreshScan(): Promise<void> {
    const windowViews = store.getWindowViews();
    for (const windowView of windowViews) {
      suppressReconnect(windowView.windowId);
      clearRuntimeOwner(windowView.windowId);
    }

    invalidateLifecycleState();
    await wsTransport.closeAllAndWait(transportDrainTimeoutMs);
    markAllRuntimeWindowsClosed();
  }

  function closeAll(): void {
    for (const windowView of store.getWindowViews()) {
      suppressReconnect(windowView.windowId);
      clearRuntimeOwner(windowView.windowId);
    }

    invalidateLifecycleState();
    wsTransport.closeAll();
    markAllRuntimeWindowsClosed();
  }

  function disconnectWindow(windowId: WindowId): void {
    const windowView = store.getWindowView(windowId);
    if (!windowView) return;

    suppressReconnect(windowId);
    clearRuntimeOwner(windowId);
    queuedRuntimeActivationSet.delete(windowId);
    wsTransport.close(windowView.targetIp);
    store.dispatch({ type: "runtime/wsStatus", payload: { windowId, status: "closed", error: null } });
    store.dispatch({ type: "runtime/presence", payload: { windowId, status: "offline" } });
  }

  function connectConfiguredWindows(): void {
    for (const windowView of store.getWindowViews()) {
      connectWindow(windowView.windowId, false);
    }
  }

  function reconnectWindow(windowId: WindowId): void {
    connectWindow(windowId, true);
  }

  function connectWindow(windowId: WindowId, resetRuntime = false): void {
    void connectWindowWithSettle(windowId, resetRuntime);
  }

  async function connectWindowWithSettle(windowId: WindowId, resetRuntime = false): Promise<void> {
    const windowView = store.getWindowView(windowId);
    if (!windowView) return;

    const targetIp = windowView.targetIp;
    const token = nextConnectionToken();

    allowReconnect(windowId);
    clearRuntimeOwner(windowId);
    setRuntimeOwner(windowId, targetIp, token);
    clearDiscoveryOwner(targetIp);

    if (resetRuntime) {
      store.dispatch({ type: "runtime/resetWindow", payload: { windowId } });
    }

    store.dispatch({ type: "runtime/wsStatus", payload: { windowId, status: "connecting", error: null } });

    await wsTransport.closeAndWait(targetIp, transportDrainTimeoutMs);
    if (!isCurrentRuntimeOwner(windowId, targetIp, token)) return;

    wsTransport.connect(targetIp, {
      onOpen: () => {
        if (!isCurrentRuntimeOwner(windowId, targetIp, token)) return;
        allowReconnect(windowId);
        presenceTracker.markWsOpen(targetIp);
        armRuntimeSilenceTimer(windowId, targetIp);
      },
      onValidObject: (obj) => {
        if (!isCurrentRuntimeOwner(windowId, targetIp, token)) return;
        messageRouter.route(targetIp, obj);
        presenceTracker.markValidObject(targetIp, performance.now());
        armRuntimeSilenceTimer(windowId, targetIp);
      },
      onInvalidFrame: () => {
        // fail-soft: invalid frame does not update presence/state
      },
      onError: () => {
        if (!isCurrentRuntimeOwner(windowId, targetIp, token)) return;
        clearRuntimeSilenceTimer(windowId);
        store.dispatch({
          type: "runtime/wsStatus",
          payload: { windowId, status: "closed", error: "ws_error" },
        });
        scheduleReconnect(windowId, targetIp);
      },
      onClose: () => {
        if (!isCurrentRuntimeOwner(windowId, targetIp, token)) return;
        presenceTracker.markWsClosed(targetIp);
        clearRuntimeSilenceTimer(windowId);
        scheduleReconnect(windowId, targetIp);
      },
    });
  }

  async function scan(ranges: IpRanges): Promise<{ attempted: number; discovered: number }> {
    const epoch = beginDiscoveryEpoch();
    cancelAllPendingDiscovery();
    clearQueuedRuntimeActivations();

    const ipList = buildUnionIpList(ranges);
    const targets = ipList.filter((targetIp) => !store.hasTargetIp(targetIp));

    let discovered = 0;
    await runPool(targets, scanConcurrency, async (targetIp) => {
      const added = await tryDiscover(targetIp, epoch);
      if (added) discovered += 1;
    });

    return { attempted: targets.length, discovered };
  }

  async function activateQueuedWindows(): Promise<void> {
    while (queuedRuntimeActivationIds.length > 0) {
      const queued = takeQueuedRuntimeActivations();
      for (let index = 0; index < queued.length; index += 1) {
        const windowId = queued[index];
        const windowView = store.getWindowView(windowId);
        if (!windowView) continue;

        await connectWindowWithSettle(windowId, false);
        if (index < queued.length - 1) {
          await delay(runtimeActivationGapMs);
        }
      }
    }
  }

  async function tryDiscover(targetIp: string, epoch: number): Promise<boolean> {
    await prepareDiscoveryTarget(targetIp);

    return new Promise<boolean>((resolve) => {
      const token = nextConnectionToken();
      const timeoutId = window.setTimeout(() => {
        const pending = consumePendingDiscovery(targetIp, epoch, token);
        if (!pending) return;

        clearDiscoveryOwner(targetIp, token);
        wsTransport.close(targetIp);
        pending.resolve(false);
      }, discoveryTimeoutMs);

      pendingDiscovery.set(targetIp, {
        targetIp,
        epoch,
        token,
        timeoutId,
        resolved: false,
        openSeen: false,
        resolve,
      });
      setDiscoveryOwner(targetIp, epoch, token);

      wsTransport.connect(targetIp, {
        onOpen: () => {
          if (!isCurrentDiscoveryOwner(targetIp, epoch, token)) return;
          const pending = pendingDiscovery.get(targetIp);
          if (!pending || pending.resolved || pending.epoch !== epoch || pending.token !== token) return;
          pending.openSeen = true;
        },

        onValidObject: (obj) => {
          if (!isCurrentDiscoveryOwner(targetIp, epoch, token)) return;

          const pending = pendingDiscovery.get(targetIp);
          if (!pending || pending.resolved || pending.epoch !== epoch || pending.token !== token) return;
          if (!pending.openSeen) return;

          const typing = determineDeviceType(obj as Record<string, any>);
          if (typing.type === "unknown") return;

          const consumed = consumePendingDiscovery(targetIp, epoch, token);
          if (!consumed) return;

          void handleDiscoveredTypedObject(targetIp, obj, typing.type, epoch, token)
            .then((added) => {
              consumed.resolve(added);
            })
            .catch(() => {
              clearDiscoveryOwner(targetIp, token);
              wsTransport.close(targetIp);
              consumed.resolve(false);
            });
        },

        onInvalidFrame: () => {
          // fail-soft
        },

        onError: () => {
          if (!isCurrentDiscoveryOwner(targetIp, epoch, token)) return;
          const pending = consumePendingDiscovery(targetIp, epoch, token);
          if (!pending) return;

          clearDiscoveryOwner(targetIp, token);
          wsTransport.close(targetIp);
          pending.resolve(false);
        },

        onClose: () => {
          if (!isCurrentDiscoveryOwner(targetIp, epoch, token)) return;
          const pending = consumePendingDiscovery(targetIp, epoch, token);
          if (!pending) return;

          clearDiscoveryOwner(targetIp, token);
          pending.resolve(false);
        },
      });
    });
  }

  async function prepareDiscoveryTarget(targetIp: string): Promise<void> {
    cancelPendingDiscovery(targetIp);

    const currentOwner = connectionOwnersByIp.get(targetIp);
    if (currentOwner?.phase === "runtime") {
      runtimeOwnersByWindow.delete(currentOwner.windowId);
    }
    connectionOwnersByIp.delete(targetIp);

    await wsTransport.closeAndWait(targetIp, transportDrainTimeoutMs);
  }

  async function handleDiscoveredTypedObject(
    targetIp: string,
    firstObj: Record<string, unknown>,
    deviceType: DeviceType,
    epoch: number,
    token: number,
  ): Promise<boolean> {
    if (!isCurrentDiscoveryOwner(targetIp, epoch, token)) {
      return false;
    }

    if (store.hasTargetIp(targetIp)) {
      clearDiscoveryOwner(targetIp, token);
      await wsTransport.closeAndWait(targetIp, transportDrainTimeoutMs);
      return false;
    }

    const windowId = generateWindowId(deviceType);
    const createdAtMs = Date.now();
    const order = store.getWindowViews().length;
    const title = buildInitialTitle(deviceType, firstObj);

    configStore.addWindowConfig(
      createWindowConfig({
        windowId,
        deviceType,
        targetIp,
        title,
        order,
        createdAtMs,
      }),
    );

    messageRouter.route(targetIp, firstObj);
    suppressReconnect(windowId);
    clearDiscoveryOwner(targetIp, token);
    await wsTransport.closeAndWait(targetIp, transportDrainTimeoutMs);

    const currentWindow = store.getWindowView(windowId);
    if (!currentWindow || currentWindow.targetIp !== targetIp) {
      return false;
    }

    queueRuntimeActivation(windowId);
    return true;
  }

  return {
    scan,
    activateQueuedWindows,
    prepareFreshScan,
    closeAll,
    disconnectWindow,
    connectConfiguredWindows,
    connectWindow,
    reconnectWindow,
  };
}

function buildInitialTitle(deviceType: DeviceType, firstObj: Record<string, unknown>): string {
  const commonName = isCommonObject(firstObj)
    ? normalizeDeviceName(firstObj.name) ?? deviceType
    : deviceType;

  if (deviceType === "opu") {
    return commonName;
  }

  const range = parseFrqRange(firstObj.frq_range);
  if (!range) {
    return `${commonName} ?-?`;
  }

  return `${commonName} ${range.min}-${range.max}`;
}

function parseFrqRange(value: unknown): { min: number; max: number } | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return { min: value[0], max: value[1] };
}

function generateWindowId(deviceType: DeviceType): WindowId {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (typeof randomUuid === "string" && randomUuid.length > 0) {
    return `${deviceType}-${randomUuid}`;
  }
  return `${deviceType}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildUnionIpList(ranges: IpRanges): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const targetIp of expandRange(ranges.rx.start, ranges.rx.end)) {
    if (seen.has(targetIp)) continue;
    seen.add(targetIp);
    out.push(targetIp);
  }

  for (const targetIp of expandRange(ranges.tx.start, ranges.tx.end)) {
    if (seen.has(targetIp)) continue;
    seen.add(targetIp);
    out.push(targetIp);
  }

  return out;
}

function expandRange(startIp: string, endIp: string): string[] {
  const start = ipToInt(startIp);
  const end = ipToInt(endIp);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const out: string[] = [];

  for (let current = min; current <= max; current += 1) {
    out.push(intToIp(current));
  }

  return out;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((part) => Number(part));
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0);
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers = new Array(Math.max(1, concurrency)).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
  });
}
