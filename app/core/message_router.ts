/**
 * MODULE: app/core/message_router.ts
 *
 * Назначение:
 *   Дет. router/parser входящих CANON JSON-object сообщений:
 *   - Common patch,
 *   - RX/TX/OPU state patch,
 *   - derived range update.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.4, §4.3, §5.1–§5.4
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.3
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1–4 (WS JSON-only invariants)
 *
 * Инварианты уровня модуля:
 *   - Валидность JSON-object уже подтверждена ws_transport/canon layer.
 *   - Router не типизирует устройство заново: тип окна уже зафиксирован discovery/config layer.
 *   - Некорректные типы полей игнорируются fail-soft.
 *
 * Запрещено:
 *   - Legacy routing по устаревшим ключам.
 *   - Падение runtime на частичных/битых state сообщениях.
 */

import { isCommonObject } from "../contracts/canon.js";
import type { StateStore } from "./state_store.js";

/**
 * Назначение:
 *   Создать router входящих сообщений, который адресует state-патчи по текущему target IP окна.
 *
 * Preconditions:
 *   - `store` поддерживает lookup `getWindowIdByTargetIp(targetIp)`.
 *
 * Postconditions:
 *   - Возвращает `route(targetIp,obj)`, который применяет Common/state patches к runtime slice.
 *
 * Инварианты:
 *   - Если target IP не сопоставлен ни одному окну, сообщение игнорируется fail-soft.
 *   - Common определяется только по полному набору ключей.
 *
 * State transitions:
 *   - `runtime/commonPatch`, `runtime/rxPatch`, `runtime/txPatch`, `runtime/opuPatch`, `runtime/range`.
 *
 * Execution Trace:
 *   1. Найти `windowId` по target IP.
 *   2. Если obj=Common — применить common patch.
 *   3. Иначе патчить state по типу окна.
 *   4. Если присутствует валидный `frq_range`, обновить derived range.
 */
export function createMessageRouter(deps: { store: StateStore }): { route: (targetIp: string, obj: Record<string, unknown>) => void } {
  const { store } = deps;

  function route(targetIp: string, obj: Record<string, unknown>): void {
    const state = store.getState();
    const windowConfig = state.config.windows.find((item) => item.targetIp === targetIp) ?? null;
    if (!windowConfig) return;

    const windowId = windowConfig.windowId;
    const runtimeWindow = state.runtime.windows[windowId] ?? null;
    if (!runtimeWindow) return;

    /** @type {Partial<import("./state_store.js").CommonState> | null} */
    let commonPatch = null;
    /** @type {Partial<import("./state_store.js").RxState> | null} */
    let rxPatch = null;
    /** @type {Partial<import("./state_store.js").TxState> | null} */
    let txPatch = null;
    /** @type {Partial<import("./state_store.js").OpuState> | null} */
    let opuPatch = null;
    /** @type {import("./state_store.js").FrequencyRange | undefined} */
    let range;

    if (isCommonObject(obj)) {
      commonPatch = {
        name: typeof obj.name === "string" ? obj.name : runtimeWindow.common.name,
        poz: typeof obj.poz === "number" ? obj.poz : runtimeWindow.common.poz,
        ip: isNumberArray(obj.ip) ? obj.ip : runtimeWindow.common.ip,
        mac: isNumberArray(obj.mac) ? obj.mac : runtimeWindow.common.mac,
        mask: isNumberArray(obj.mask) ? obj.mask : runtimeWindow.common.mask,
        gw: isNumberArray(obj.gw) ? obj.gw : runtimeWindow.common.gw,
      };
    }

    if (windowConfig.deviceType === "rx") {
      const patch = {} as Record<string, unknown>;
      if (typeof obj.ud === "boolean") patch.ud = obj.ud;
      if (typeof obj.inv === "boolean") patch.inv = obj.inv;
      if (typeof obj.frq === "number") patch.frq = obj.frq;
      if (typeof obj.rssi === "number") patch.rssi = obj.rssi;
      if (isNumberArrayWithLength(obj.frq_range, 2)) patch.frq_range = obj.frq_range;
      if (isNumberArrayWithLength(obj.frq_ignor, 5)) patch.frq_ignor = obj.frq_ignor;
      if (typeof obj.fon_scan === "boolean") patch.fon_scan = obj.fon_scan;
      const spectr = coerceSpectrRssi100(obj.spectr_rssi);
      if (spectr) patch.spectr_rssi = spectr;
      rxPatch = Object.keys(patch).length > 0 ? patch : null;
      range = parseFrqRange(obj.frq_range) ?? undefined;
    } else if (windowConfig.deviceType === "tx") {
      const patch = {} as Record<string, unknown>;
      if (typeof obj.U === "number") patch.U = obj.U;
      if (typeof obj.I === "number") patch.I = obj.I;
      if (typeof obj.P === "number") patch.P = obj.P;
      if (typeof obj.T === "number") patch.T = obj.T;
      if (typeof obj.tx_ch === "number") patch.tx_ch = obj.tx_ch;
      if (isNumberArray(obj.frq_tx_out)) patch.frq_tx_out = obj.frq_tx_out;
      if (isNumberArrayWithLength(obj.frq_range, 2)) patch.frq_range = obj.frq_range;
      txPatch = Object.keys(patch).length > 0 ? patch : null;
      range = parseFrqRange(obj.frq_range) ?? undefined;
    } else {
      const patch = {} as Record<string, unknown>;
      if (typeof obj.lat === "number") patch.lat = obj.lat;
      if (typeof obj.lng === "number") patch.lng = obj.lng;
      if (typeof obj.ugol === "number") patch.ugol = obj.ugol;
      if (typeof obj.centr_ugol === "number") patch.centr_ugol = obj.centr_ugol;
      if (typeof obj.speed === "number") patch.speed = obj.speed;
      opuPatch = Object.keys(patch).length > 0 ? patch : null;
    }

    if (!commonPatch && !rxPatch && !txPatch && !opuPatch && range === undefined) return;

    const changed =
      patchDiffers(runtimeWindow.common, commonPatch) ||
      patchDiffers(runtimeWindow.rx, rxPatch) ||
      patchDiffers(runtimeWindow.tx, txPatch) ||
      patchDiffers(runtimeWindow.opu, opuPatch) ||
      frequencyRangeDiffers(runtimeWindow.range, range);

    if (!changed) return;

    store.dispatch({
      type: "runtime/windowFrameBundle",
      payload: {
        windowId,
        commonPatch,
        range,
        rxPatch,
        txPatch,
        opuPatch,
      },
    });
  }

  return { route };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isNumberArrayWithLength(value: unknown, expectedLength: number): value is number[] {
  return isNumberArray(value) && value.length === expectedLength;
}

function parseFrqRange(value: unknown): { min: number; max: number } | null {
  if (!isNumberArrayWithLength(value, 2)) return null;
  return { min: value[0], max: value[1] };
}

function coerceSpectrRssi100(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 100) return null;

  const first100 = value.slice(0, 100);
  if (!first100.every((item) => typeof item === "number")) return null;

  return /** @type {number[]} */ (first100);
}

function patchDiffers<T extends Record<string, unknown>>(current: T, patch: Partial<T> | null): boolean {
  if (!patch) return false;
  for (const [key, value] of Object.entries(patch)) {
    if (!valueEquals(current[key as keyof T], value)) return true;
  }
  return false;
}

function frequencyRangeDiffers(current: { min: number; max: number } | null, next: { min: number; max: number } | undefined): boolean {
  if (next === undefined) return false;
  if (current === null || next === null) return current !== next;
  return current.min !== next.min || current.max !== next.max;
}

function valueEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!valueEquals(left[index], right[index])) return false;
    }
    return true;
  }

  return left === right;
}
