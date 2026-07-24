/**
 * MODULE: app/core/presence_tracker.ts
 *
 * Назначение:
 *   Детерминированный presence tracker по правилу 2–3 секунды:
 *   `online = ws=open && valid JSON-object получен в окне времени`.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.3
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.4
 *   - SPRINT_PLAN_vNext.3.2 AC1-11, AC4-12
 *
 * Инварианты уровня модуля:
 *   - Presence оценивается только по WS-status и timestamp последнего валидного JSON-object.
 *   - Монотонное время = `performance.now()`.
 *   - Нет heartbeat/DATA/polling логики.
 *
 * Запрещено:
 *   - Вводить retry/fallback/policy при offline.
 *   - Использовать что-либо кроме WS status + valid JSON timestamps.
 */

import type { OnlineStatus, StateStore } from "./state_store.js";

/**
 * Назначение:
 *   Создать presence tracker с событиями по target IP и периодическим тиком.
 *
 * Preconditions:
 *   - `presenceWindowMs` лежит в диапазоне 2000..3000.
 *   - `store` поддерживает lookup окна по target IP.
 *
 * Postconditions:
 *   - Возвращает API `start/stop/markWsOpen/markWsClosed/markValidObject`.
 *
 * Инварианты:
 *   - Offline наступает сразу при потере WS.
 *   - Online выставляется только если valid JSON-object получен свежо и WS=open.
 *
 * State transitions:
 *   - `runtime/wsStatus`, `runtime/lastValidJsonAt`, `runtime/presence`.
 *
 * Execution Trace:
 *   1. Сохранить deps и interval handle.
 *   2. Реализовать event handlers по target IP.
 *   3. Реализовать tick() для периодического пересчёта всех окон.
 */
export function createPresenceTracker(deps: {
  store: StateStore;
  presenceWindowMs: number;
  tickMs: number;
}): {
  start: () => void;
  stop: () => void;
  markWsOpen: (targetIp: string) => void;
  markWsClosed: (targetIp: string) => void;
  markValidObject: (targetIp: string, atMs: number) => void;
} {
  const { store, presenceWindowMs, tickMs } = deps;
  let timerId: number | null = null;
  const lastValidByWindow = new Map<string, number>();

  function start(): void {
    if (timerId !== null) return;
    timerId = window.setInterval(tick, tickMs);
  }

  function stop(): void {
    if (timerId === null) return;
    window.clearInterval(timerId);
    timerId = null;
  }

  function markWsOpen(targetIp: string): void {
    const windowId = store.getWindowIdByTargetIp(targetIp);
    if (!windowId) return;

    const state = store.getState();
    const runtimeWindow = state.runtime.windows[windowId] ?? null;
    if (!runtimeWindow) return;

    if (runtimeWindow.ws.status !== "open" || runtimeWindow.ws.error !== null) {
      store.dispatch({ type: "runtime/wsStatus", payload: { windowId, status: "open", error: null } });
    }

    const lastValidAt = lastValidByWindow.get(windowId) ?? null;
    if (lastValidAt !== null && performance.now() - lastValidAt <= presenceWindowMs && runtimeWindow.presence.status !== "online") {
      store.dispatch({ type: "runtime/presence", payload: { windowId, status: "online" } });
    }
  }

  function markWsClosed(targetIp: string): void {
    const windowId = store.getWindowIdByTargetIp(targetIp);
    if (!windowId) return;

    lastValidByWindow.delete(windowId);

    const state = store.getState();
    const runtimeWindow = state.runtime.windows[windowId] ?? null;
    if (!runtimeWindow) return;

    if (runtimeWindow.ws.status !== "closed" || runtimeWindow.ws.error !== null) {
      store.dispatch({ type: "runtime/wsStatus", payload: { windowId, status: "closed", error: null } });
    }
    if (runtimeWindow.presence.status !== "offline") {
      store.dispatch({ type: "runtime/presence", payload: { windowId, status: "offline" } });
    }
  }

  function markValidObject(targetIp: string, atMs: number): void {
    const windowId = store.getWindowIdByTargetIp(targetIp);
    if (!windowId) return;

    lastValidByWindow.set(windowId, atMs);

    const state = store.getState();
    const runtimeWindow = state.runtime.windows[windowId] ?? null;
    if (!runtimeWindow) return;

    if (runtimeWindow.ws.status === "open" && runtimeWindow.presence.status !== "online") {
      store.dispatch({ type: "runtime/presence", payload: { windowId, status: "online" } });
    }
  }

  function tick(): void {
    const now = performance.now();
    const state = store.getState();

    for (const windowConfig of state.config.windows) {
      const runtimeWindow = state.runtime.windows[windowConfig.windowId] ?? null;
      if (!runtimeWindow) continue;

      const wsOpen = runtimeWindow.ws.status === "open";
      const lastValidJsonAt = lastValidByWindow.get(windowConfig.windowId) ?? null;
      let desiredStatus: OnlineStatus = "offline";

      if (wsOpen && lastValidJsonAt !== null && now - lastValidJsonAt <= presenceWindowMs) {
        desiredStatus = "online";
      }

      if (runtimeWindow.presence.status !== desiredStatus) {
        store.dispatch({
          type: "runtime/presence",
          payload: { windowId: windowConfig.windowId, status: desiredStatus },
        });
      }
    }
  }

  return {

    start,
    stop,
    markWsOpen,
    markWsClosed,
    markValidObject,
  };
}
