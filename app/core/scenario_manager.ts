/**
 * MODULE: app/core/scenario_manager.ts
 *
 * Назначение:
 *   ScenarioManager Sprint 4:
 *   - Scenario 1 / Scenario 2 routing RX -> TX,
 *   - persisted scenario selection и persisted queue order по stable `windowId`,
 *   - runtime-only FIFO pointer и runtime shadow для no-echo последовательностей.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §6.3, §7.1, §7.2, §9, §11
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.10, §5.6.4, §5.6.5, §6.6
 *   - SPRINT_PLAN_vNext.3.2 Sprint 3 AC3-7..AC3-14 + Sprint 4 D4-3..D4-5 / AC4-5..AC4-7
 *
 * Инварианты уровня модуля:
 *   - Group key identical TX = `type + common.name + frq_range`; user-edited title/menu label на него не влияет.
 *   - Persisted queue order хранится по `windowId[]`, runtime routing всё равно отправляет на фактический target IP окна.
 *   - FIFO pointer остаётся runtime-only и не персистится.
 *   - Offline/out-of-range target в Scenario 2 не вызывает reroute/retry/fallback.
 *
 * Запрещено:
 *   - Любые policy changes для offline/no-range beyond SSOT.
 *   - Использовать display-title как часть group key.
 */

import { normalizeDeviceName } from "../contracts/canon.js";
import type { ConfigStore } from "./config_store.js";
import type { StateStore, WindowViewModel } from "./state_store.js";
import type { createTxCommandDispatcher } from "./tx_commands.js";

export type TxScenarioUiState = {
  groupKey: string | null;
  groupSize: number;
  scenario: 1 | 2;
  scenarioSwitchEnabled: boolean;
  queue: Array<{ windowId: string; title: string; online: boolean }>;
};

type FifoPointer = {
  deviceIndex: number;
  slotIndex: number;
};

type Scenario1Cursor = {
  mode: "fill" | "fifo";
  slotIndex: number;
};

type RuntimeShadowState = {
  createdAtMs: number;
  txCh: number;
  rawArr: number[];
  lastDeviceSig: string;
};

/**
 * Назначение:
 *   Создать ScenarioManager с persisted queue/scenario config и runtime-only FIFO/shadow state.
 *
 * Preconditions:
 *   - `store` предоставляет merged window views с current targetIp/runtime state.
 *   - `configStore` умеет сохранять scenario preference по groupKey.
 *   - `txCommands` валидирует и отправляет CANON `frq_tx_in[]`.
 *
 * Postconditions:
 *   - Возвращает API UI-state / scenario toggle / queue reorder / RX->TX routing.
 *
 * Инварианты:
 *   - Persisted model = scenario + queueOrder(windowId[]).
 *   - Runtime model = pointer + txShadow, без persistence surface.
 *
 * State transitions:
 *   - `config.scenarioGroups[groupKey]` меняется при scenario toggle / queue reorder / queue normalization.
 *   - `groupPointer[groupKey]` advance only after successful Scenario 2 send.
 *
 * Execution Trace:
 *   1. Инициализировать runtime maps listeners/pointer/shadow.
 *   2. Реализовать deterministic group-key и queue normalization.
 *   3. Реализовать Scenario 1 broadcast.
 *   4. Реализовать Scenario 2 single-target FIFO.
 */
export function createScenarioManager(deps: {
  store: StateStore;
  configStore: ConfigStore;
  txCommands: ReturnType<typeof createTxCommandDispatcher>;
}): {
  subscribe: (fn: () => void) => () => void;
  getTxScenarioUiState: (txWindow: WindowViewModel) => TxScenarioUiState;
  setScenario: (groupKey: string, next: 1 | 2) => void;
  moveQueueItem: (groupKey: string, fromIndex: number, toIndex: number) => void;
  routeRxFrequencyToTx: (frq: number) => void;
  getDisplayTxArray: (txWindow: WindowViewModel) => number[] | null;
  getRawTxArray: (txWindow: WindowViewModel) => number[] | null;
  rememberTxArray: (txWindow: WindowViewModel, arr: number[]) => void;
  forgetWindow: (windowId: string) => void;
  resetEphemera: () => void;
} {
  const { store, configStore, txCommands } = deps;

  const listeners = new Set<() => void>();
  const groupPointer = new Map<string, FifoPointer>();
  const scenario1CursorByGroup = new Map<string, Scenario1Cursor>();
  const runtimeTxShadow = new Map<string, RuntimeShadowState>();

  /**
   * Назначение:
   *   Подписать UI на изменения ScenarioManager runtime/config state, влияющие на queue/scenario rendering.
   *
   * Preconditions:
   *   - `fn` является side-effect-safe listener без предположений о порядке вызова.
   *
   * Postconditions:
   *   - Возвращает unsubscribe callback.
   *
   * Инварианты:
   *   - Исключения listener-ов не должны ломать ScenarioManager.
   *
   * State transitions:
   *   - listeners: add -> remove через возвращённую функцию.
   *
   * Execution Trace:
   *   1. Добавить listener в Set.
   *   2. Вернуть callback удаления listener-а.
   */
  function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // fail-soft
      }
    }
  }

  /**
   * Назначение:
   *   Построить UI-state для TX окна: active scenario, доступность переключателя и очередь Scenario 2.
   *
   * Preconditions:
   *   - `txWindow` относится к окну TX из текущего merged state.
   *
   * Postconditions:
   *   - Возвращает детерминированный снимок scenario/queue для рендера.
   *
   * Инварианты:
   *   - При отсутствии детерминируемого group key окно ведёт себя как standalone TX со Scenario 1.
   *   - Queue UI всегда строится по persisted `windowId[]`, нормализованному на текущий состав группы.
   *
   * State transitions:
   *   - Может косвенно нормализовать persisted queue/scenario через `getOrNormalizeGroupState()`.
   *
   * Execution Trace:
   *   1. Определить group key.
   *   2. Если группа не определена — вернуть standalone UI-state.
   *   3. Иначе нормализовать persisted state группы и собрать queue view models.
   */
  function getTxScenarioUiState(txWindow: WindowViewModel): TxScenarioUiState {
    const groupKey = computeGroupKey(txWindow);
    if (!groupKey) {
      return {
        groupKey: null,
        groupSize: 1,
        scenario: 1,
        scenarioSwitchEnabled: false,
        queue: [{ windowId: txWindow.windowId, title: txWindow.title || txWindow.targetIp, online: txWindow.presence.status === "online" }],
      };
    }

    const members = getGroupMembers(groupKey);
    const groupState = getOrNormalizeGroupState(groupKey, members);

    return {
      groupKey,
      groupSize: members.length,
      scenario: members.length > 1 ? groupState.scenario : 1,
      scenarioSwitchEnabled: members.length > 1,
      queue: groupState.queueWindowIds
        .map((windowId) => members.find((member) => member.windowId === windowId) ?? null)
        .filter((member): member is WindowViewModel => member !== null)
        .map((member) => ({
          windowId: member.windowId,
          title: member.title || member.targetIp,
          online: member.presence.status === "online",
        })),
    };
  }

  /**
   * Назначение:
   *   Зафиксировать persisted выбор Scenario 1/2 для группы одинаковых TX устройств.
   *
   * Preconditions:
   *   - `groupKey` соответствует deterministic key `type+common.name+frq_range`.
   *
   * Postconditions:
   *   - В config persistence сохранён scenario для группы.
   *
   * Инварианты:
   *   - Scenario 2 допустим только при размере группы > 1; иначе принудительно сохраняется Scenario 1.
   *
   * State transitions:
   *   - `config.scenarioGroups[groupKey].scenario` -> `1 | 2`.
   *
   * Execution Trace:
   *   1. Получить текущих членов группы.
   *   2. Нормализовать queue state.
   *   3. Сохранить допустимое значение scenario и уведомить listeners.
   */
  function setScenario(groupKey: string, next: 1 | 2): void {
    const members = getGroupMembers(groupKey);
    if (members.length === 0) return;

    const groupState = getOrNormalizeGroupState(groupKey, members);
    const scenario = next === 2 && members.length > 1 ? 2 : 1;
    configStore.setScenarioPreference(groupKey, {
      scenario,
      queueOrder: groupState.queueWindowIds,
    });

    if (groupState.scenario !== scenario) {
      groupPointer.set(groupKey, { deviceIndex: 0, slotIndex: 0 });
      scenario1CursorByGroup.delete(groupKey);
      for (const member of members) {
        runtimeTxShadow.delete(member.windowId);
      }
    }

    notify();
  }

  /**
   * Назначение:
   *   Переставить элемент persisted очереди Scenario 2 drag&drop-операцией.
   *
   * Preconditions:
   *   - `fromIndex/toIndex` относятся к текущему queue rendering группы.
   *
   * Postconditions:
   *   - Новая последовательность `windowId[]` сохранена в config persistence.
   *
   * Инварианты:
   *   - Состав очереди не меняется; меняется только относительный порядок существующих `windowId`.
   *   - FIFO pointer не прыгает за границы queue после перестановки.
   *
   * State transitions:
   *   - `config.scenarioGroups[groupKey].queueOrder` -> reordered queue.
   *
   * Execution Trace:
   *   1. Нормализовать текущую queue.
   *   2. Clamp-нуть индексы.
   *   3. Переставить элемент и сохранить новую queue.
   *   4. Нормализовать runtime pointer и уведомить listeners.
   */
  function moveQueueItem(groupKey: string, fromIndex: number, toIndex: number): void {
    const members = getGroupMembers(groupKey);
    if (members.length === 0) return;

    const groupState = getOrNormalizeGroupState(groupKey, members);
    const queue = groupState.queueWindowIds.slice();
    const from = clampInt(fromIndex, 0, queue.length - 1);
    const to = clampInt(toIndex, 0, queue.length - 1);
    if (from === to) return;

    const [item] = queue.splice(from, 1);
    queue.splice(to, 0, item);

    configStore.setScenarioPreference(groupKey, {
      scenario: groupState.scenario,
      queueOrder: queue,
    });

    const pointer = groupPointer.get(groupKey) ?? { deviceIndex: 0, slotIndex: 0 };
    pointer.deviceIndex = queue.length === 0 ? 0 : clampInt(pointer.deviceIndex, 0, queue.length - 1);
    groupPointer.set(groupKey, pointer);
    notify();
  }

  /**
   * Назначение:
   *   Маршрутизировать валидную RX частоту на все deterministic TX groups согласно Scenario 1/2.
   *
   * Preconditions:
   *   - `frq` уже проверена RX side как валидная frequency candidate.
   *
   * Postconditions:
   *   - Для каждой группы одинаковых TX выполнена Scenario 1 broadcast либо Scenario 2 single-target FIFO send attempt.
   *
   * Инварианты:
   *   - Offline/out-of-range TX не получают команды.
   *   - Scenario 2 pointer advance происходит только после successful send.
   *
   * State transitions:
   *   - runtime group pointers/shadows обновляются только в пределах успешных send paths.
   *
   * Execution Trace:
   *   1. Собрать deterministic группы TX.
   *   2. Нормализовать persisted queue/scenario по каждой группе.
   *   3. Выполнить Scenario 1 или Scenario 2 routing.
   */
  function routeRxFrequencyToTx(frq: number): void {
    const groups = new Map<string, WindowViewModel[]>();
    let changed = false;

    for (const windowView of store.getWindowViews()) {
      if (windowView.deviceType !== "tx") continue;
      const groupKey = computeGroupKey(windowView);
      if (!groupKey) continue;
      const list = groups.get(groupKey);
      if (list) list.push(windowView);
      else groups.set(groupKey, [windowView]);
    }

    for (const [groupKey, members] of groups) {
      const groupState = getOrNormalizeGroupState(groupKey, members);
      if (groupState.scenario === 2 && members.length > 1) {
        changed = routeScenario2(groupKey, members, groupState.queueWindowIds, groupState.pointer, frq) || changed;
      } else {
        changed = routeScenario1(groupKey, members, groupState.queueWindowIds, frq) || changed;
      }
    }

    if (changed) notify();
  }

  function computeGroupKey(windowView: WindowViewModel): string | null {
    if (windowView.deviceType !== "tx") return null;
    if (!windowView.range) return null;
    if (!windowView.common.name) return null;

    const nameKey = normalizeDeviceName(windowView.common.name);
    if (!nameKey) return null;

    return `${windowView.deviceType}|${nameKey}|${windowView.range.min}-${windowView.range.max}`;
  }

  function getGroupMembers(groupKey: string): WindowViewModel[] {
    return store
      .getWindowViews()
      .filter((windowView) => windowView.deviceType === "tx" && computeGroupKey(windowView) === groupKey)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId));
  }

  function getOrNormalizeGroupState(
    groupKey: string,
    members: WindowViewModel[],
  ): { scenario: 1 | 2; queueWindowIds: string[]; pointer: FifoPointer } {
    const savedPreference = configStore.getConfig().scenarioGroups[groupKey] ?? null;

    const knownQueueIds = savedPreference?.queueOrder.filter((windowId) => members.some((member) => member.windowId === windowId)) ?? [];
    const newMembers = members
      .filter((member) => !knownQueueIds.includes(member.windowId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId))
      .map((member) => member.windowId);

    const normalizedQueue = [...knownQueueIds, ...newMembers];
    const scenario = savedPreference?.scenario === 2 && members.length > 1 ? 2 : 1;

    const needsPersist =
      savedPreference === null ||
      savedPreference.scenario !== scenario ||
      savedPreference.queueOrder.length !== normalizedQueue.length ||
      savedPreference.queueOrder.some((windowId, index) => normalizedQueue[index] !== windowId);

    if (needsPersist) {
      configStore.setScenarioPreference(groupKey, {
        scenario,
        queueOrder: normalizedQueue,
      });
    }

    const pointer = groupPointer.get(groupKey) ?? { deviceIndex: 0, slotIndex: 0 };
    pointer.deviceIndex = normalizedQueue.length === 0 ? 0 : clampInt(pointer.deviceIndex, 0, normalizedQueue.length - 1);

    const selectedWindowId = normalizedQueue[pointer.deviceIndex] ?? null;
    const selectedWindow = selectedWindowId ? members.find((member) => member.windowId === selectedWindowId) ?? null : null;
    const txCh = selectedWindow ? txCommands.validateTxCh(selectedWindow.tx.tx_ch) : null;
    pointer.slotIndex = txCh === null ? 0 : clampInt(pointer.slotIndex, 0, txCh - 1);
    groupPointer.set(groupKey, pointer);

    return {
      scenario,
      queueWindowIds: normalizedQueue,
      pointer: { ...pointer },
    };
  }

  function getOrderedMembersByQueue(members: WindowViewModel[], queueWindowIds: string[]): WindowViewModel[] {
    return queueWindowIds
      .map((windowId) => members.find((member) => member.windowId === windowId) ?? null)
      .filter((member): member is WindowViewModel => member !== null);
  }

  function getEligibleTxMembersForFrq(
    members: WindowViewModel[],
    queueWindowIds: string[],
    frq: number,
  ): Array<{ member: WindowViewModel; txCh: number }> {
    const orderedMembers = getOrderedMembersByQueue(members, queueWindowIds);
    const eligible: Array<{ member: WindowViewModel; txCh: number }> = [];

    for (const member of orderedMembers) {
      if (member.presence.status !== "online") continue;
      if (!member.range) continue;
      if (frq < member.range.min || frq > member.range.max) continue;
      const txCh = txCommands.validateTxCh(member.tx.tx_ch);
      if (txCh === null) continue;
      eligible.push({ member, txCh });
    }

    return eligible;
  }

  function findFirstZeroSlot(rawArr: number[]): number {
    return rawArr.findIndex((item) => item === 0);
  }

  function deriveScenario1CursorFromRaw(
    eligibleMembers: Array<{ member: WindowViewModel; txCh: number }>,
    txCh: number,
  ): Scenario1Cursor {
    if (eligibleMembers.length === 0) {
      return { mode: "fill", slotIndex: 0 };
    }

    let sharedFilledPrefix = 0;
    for (let slotIndex = 0; slotIndex < txCh; slotIndex += 1) {
      const allFilled = eligibleMembers.every(({ member }) => {
        const rawArr = readRuntimeTxArray(member, txCh);
        return rawArr[slotIndex] !== 0;
      });
      if (!allFilled) break;
      sharedFilledPrefix += 1;
    }

    if (sharedFilledPrefix < txCh) {
      return { mode: "fill", slotIndex: sharedFilledPrefix };
    }

    return { mode: "fifo", slotIndex: 0 };
  }

  function findScenario2FirstFreeTarget(
    eligibleMembers: Array<{ member: WindowViewModel; txCh: number }>,
  ): { member: WindowViewModel; txCh: number; slotIndex: number } | null {
    for (const entry of eligibleMembers) {
      const rawArr = readRuntimeTxArray(entry.member, entry.txCh);
      const slotIndex = findFirstZeroSlot(rawArr);
      if (slotIndex !== -1) {
        return { ...entry, slotIndex };
      }
    }

    return null;
  }

  function invalidateGroupEphemera(groupKey: string | null): void {
    if (!groupKey) return;
    groupPointer.delete(groupKey);
    scenario1CursorByGroup.delete(groupKey);
  }

  function routeScenario1(groupKey: string, members: WindowViewModel[], queueWindowIds: string[], frq: number): boolean {
    const eligibleMembers = getEligibleTxMembersForFrq(members, queueWindowIds, frq);
    if (eligibleMembers.length === 0) return false;

    const txCh = eligibleMembers[0].txCh;
    const homogenousMembers = eligibleMembers.filter((entry) => entry.txCh === txCh);
    if (homogenousMembers.length === 0) return false;

    let cursor = scenario1CursorByGroup.get(groupKey) ?? null;
    if (!cursor || cursor.slotIndex < 0 || cursor.slotIndex >= txCh) {
      cursor = deriveScenario1CursorFromRaw(homogenousMembers, txCh);
    }

    const slotIndex = clampInt(cursor.slotIndex, 0, txCh - 1);
    let successfulSends = 0;

    for (const { member } of homogenousMembers) {
      const base = readRuntimeTxArray(member, txCh);
      const intent = base.slice();
      intent[slotIndex] = frq;

      const sent = txCommands.sendFrqTxIn(member.targetIp, intent, txCh, member.range);
      if (!sent) continue;

      writeRuntimeTxArray(member, txCh, intent);
      successfulSends += 1;
    }

    if (successfulSends === 0) return false;

    if (cursor.mode === "fill") {
      if (slotIndex < txCh - 1) {
        scenario1CursorByGroup.set(groupKey, { mode: "fill", slotIndex: slotIndex + 1 });
      } else {
        scenario1CursorByGroup.set(groupKey, { mode: "fifo", slotIndex: 0 });
      }
    } else {
      scenario1CursorByGroup.set(groupKey, { mode: "fifo", slotIndex: (slotIndex + 1) % txCh });
    }

    return true;
  }

  function routeScenario2(
    groupKey: string,
    members: WindowViewModel[],
    queueWindowIds: string[],
    pointer: FifoPointer,
    frq: number,
  ): boolean {
    if (queueWindowIds.length === 0) return false;

    const eligibleMembers = getEligibleTxMembersForFrq(members, queueWindowIds, frq);
    if (eligibleMembers.length === 0) return false;

    const freeTarget = findScenario2FirstFreeTarget(eligibleMembers);
    if (freeTarget) {
      const base = readRuntimeTxArray(freeTarget.member, freeTarget.txCh);
      const intent = base.slice();
      intent[freeTarget.slotIndex] = frq;

      const sent = txCommands.sendFrqTxIn(freeTarget.member.targetIp, intent, freeTarget.txCh, freeTarget.member.range);
      if (!sent) return false;

      writeRuntimeTxArray(freeTarget.member, freeTarget.txCh, intent);
      if (!groupPointer.has(groupKey)) {
        groupPointer.set(groupKey, { deviceIndex: 0, slotIndex: 0 });
      }
      return true;
    }

    const queueEligibleIds = queueWindowIds.filter((windowId) => eligibleMembers.some((entry) => entry.member.windowId === windowId));
    if (queueEligibleIds.length === 0) return false;

    const normalizedPointer = groupPointer.get(groupKey) ?? { ...pointer };
    const selectedWindowId = queueEligibleIds[clampInt(normalizedPointer.deviceIndex, 0, queueEligibleIds.length - 1)];
    const selectedEntry = eligibleMembers.find((entry) => entry.member.windowId === selectedWindowId) ?? null;
    if (!selectedEntry) return false;

    const slotIndex = clampInt(normalizedPointer.slotIndex, 0, selectedEntry.txCh - 1);
    const base = readRuntimeTxArray(selectedEntry.member, selectedEntry.txCh);
    const intent = base.slice();
    intent[slotIndex] = frq;

    const sent = txCommands.sendFrqTxIn(selectedEntry.member.targetIp, intent, selectedEntry.txCh, selectedEntry.member.range);
    if (!sent) return false;

    writeRuntimeTxArray(selectedEntry.member, selectedEntry.txCh, intent);
    groupPointer.set(groupKey, advancePointer(normalizedPointer, queueEligibleIds.length, selectedEntry.txCh));
    return true;
  }

  function readRuntimeTxArray(member: WindowViewModel, txCh: number): number[] {
    const deviceBase = normalizeTxArray(member.tx.frq_tx_out, txCh);
    const deviceSig = computeTxBasisSig(member, txCh, deviceBase);
    const shadow = runtimeTxShadow.get(member.windowId);

    if (!shadow || shadow.createdAtMs !== member.createdAtMs || shadow.txCh !== txCh) {
      runtimeTxShadow.set(member.windowId, {
        createdAtMs: member.createdAtMs,
        txCh,
        rawArr: deviceBase.slice(),
        lastDeviceSig: deviceSig,
      });
      return deviceBase;
    }

    if (shadow.lastDeviceSig !== deviceSig) {
      const shapedShadow = txCommands.shapeFrqTxIn(shadow.rawArr, txCh, member.range ?? null);
      const expectedDeviceArr = "arr" in shapedShadow ? shapedShadow.arr : shadow.rawArr;

      if (arraysEqual(expectedDeviceArr, deviceBase)) {
        runtimeTxShadow.set(member.windowId, {
          ...shadow,
          lastDeviceSig: deviceSig,
        });
        return shadow.rawArr.slice();
      }

      runtimeTxShadow.set(member.windowId, {
        createdAtMs: member.createdAtMs,
        txCh,
        rawArr: deviceBase.slice(),
        lastDeviceSig: deviceSig,
      });
      return deviceBase;
    }

    return shadow.rawArr.slice();
  }

  function writeRuntimeTxArray(member: WindowViewModel, txCh: number, arr: number[]): void {
    const existing = runtimeTxShadow.get(member.windowId);
    const deviceBase = normalizeTxArray(member.tx.frq_tx_out, txCh);

    runtimeTxShadow.set(member.windowId, {
      createdAtMs: member.createdAtMs,
      txCh,
      rawArr: arr.slice(),
      lastDeviceSig:
        existing && existing.createdAtMs === member.createdAtMs && existing.txCh === txCh
          ? existing.lastDeviceSig
          : computeTxBasisSig(member, txCh, deviceBase),
    });
  }

  function getDisplayTxArray(txWindow: WindowViewModel): number[] | null {
    const txCh = txCommands.validateTxCh(txWindow.tx.tx_ch);
    if (txCh === null) return null;
    const rawArr = readRuntimeTxArray(txWindow, txCh);
    const shaped = txCommands.shapeFrqTxIn(rawArr, txCh, txWindow.range ?? null);
    return "arr" in shaped ? shaped.arr : rawArr;
  }

  function getRawTxArray(txWindow: WindowViewModel): number[] | null {
    const txCh = txCommands.validateTxCh(txWindow.tx.tx_ch);
    if (txCh === null) return null;
    return readRuntimeTxArray(txWindow, txCh);
  }

  function rememberTxArray(txWindow: WindowViewModel, arr: number[]): void {
    const txCh = txCommands.validateTxCh(txWindow.tx.tx_ch);
    if (txCh === null) return;
    if (arr.length !== txCh) return;
    writeRuntimeTxArray(txWindow, txCh, arr);
    invalidateGroupEphemera(computeGroupKey(txWindow));
    notify();
  }

  /**
   * Назначение:
   *   Очистить runtime-only ephemeral state, связанный с удалённым или ретаргетируемым окном.
   *
   * Preconditions:
   *   - `windowId` может как существовать в текущем config, так и уже быть удалённым.
   *
   * Postconditions:
   *   - Runtime shadow по `windowId` удалён.
   *   - Queue pointers по группам, где окно больше не существует, нормализуются при следующем обращении.
   *
   * Инварианты:
   *   - Persisted config при этом не меняется.
   *
   * State transitions:
   *   - `runtimeTxShadow.delete(windowId)`.
   *
   * Execution Trace:
   *   1. Удалить shadow state по windowId.
   *   2. Пройти по pointers и clamp/remove те группы, где queue стала пустой.
   */
  function forgetWindow(windowId: string): void {
    runtimeTxShadow.delete(windowId);

    const groupKeys = new Set([...groupPointer.keys(), ...scenario1CursorByGroup.keys()]);
    for (const groupKey of groupKeys) {
      const members = getGroupMembers(groupKey);
      if (members.length === 0) {
        groupPointer.delete(groupKey);
        scenario1CursorByGroup.delete(groupKey);
        continue;
      }

      const normalized = getOrNormalizeGroupState(groupKey, members);
      if (normalized.queueWindowIds.length === 0) {
        groupPointer.delete(groupKey);
        scenario1CursorByGroup.delete(groupKey);
        continue;
      }

      const pointer = groupPointer.get(groupKey);
      if (pointer) {
        pointer.deviceIndex = clampInt(pointer.deviceIndex, 0, normalized.queueWindowIds.length - 1);
        groupPointer.set(groupKey, pointer);
      }
    }
  }

  /**
   * Назначение:
   *   Полностью сбросить runtime-only FIFO pointers и runtime TX shadow state.
   *
   * Preconditions:
   *   - Используется перед полной заменой config/import/newConfig reset.
   *
   * Postconditions:
   *   - Все runtime-only карты ScenarioManager очищены.
   *
   * Инварианты:
   *   - Persisted scenario/queue preferences не затрагиваются.
   *
   * State transitions:
   *   - `groupPointer.clear()`
   *   - `runtimeTxShadow.clear()`
   *
   * Execution Trace:
   *   1. Очистить runtime pointers.
   *   2. Очистить runtime shadow.
   */
  function resetEphemera(): void {
    groupPointer.clear();
    scenario1CursorByGroup.clear();
    runtimeTxShadow.clear();
  }

  return {
    subscribe,
    getTxScenarioUiState,
    setScenario,
    moveQueueItem,
    routeRxFrequencyToTx,
    getDisplayTxArray,
    getRawTxArray,
    rememberTxArray,
    forgetWindow,
    resetEphemera,
  };
}

function arraysEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function normalizeTxArray(arr: number[] | undefined, txCh: number): number[] {
  if (!Array.isArray(arr) || arr.length !== txCh) return new Array(txCh).fill(0);
  return arr.map((item) => (typeof item === "number" ? item : 0));
}

function computeTxBasisSig(member: WindowViewModel, txCh: number, arr: number[]): string {
  return `${member.createdAtMs}|${txCh}|${arr.join(",")}`;
}

function advancePointer(pointer: FifoPointer, queueLength: number, txCh: number): FifoPointer {
  let deviceIndex = pointer.deviceIndex;
  let slotIndex = pointer.slotIndex + 1;

  if (slotIndex >= txCh) {
    slotIndex = 0;
    deviceIndex += 1;
  }

  if (queueLength > 0 && deviceIndex >= queueLength) {
    deviceIndex = 0;
  }

  return { deviceIndex, slotIndex };
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? (value | 0) : 0;
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}
