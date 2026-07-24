/**
 * MODULE: app/core/config_store.ts
 *
 * Назначение:
 *   ConfigStore Sprint 4:
 *   - единая точка работы с serializable AppConfig,
 *   - автозагрузка/автосохранение через PersistenceAdapter,
 *   - export/import JSON,
 *   - dispatch-only mutations config slice без примеси runtime WS state.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §4.2, §4.5, §4.8, §4.9
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.8, §5.6.4
 *   - SPRINT_PLAN_vNext.3.2 Sprint 4 D4-1..D4-6, AC4-1..AC4-11
 *
 * Инварианты уровня модуля:
 *   - ConfigStore работает только с serializable AppConfig и не трогает runtime WS объекты напрямую.
 *   - Autosave срабатывает только при изменении config slice, а не при каждом runtime tick.
 *   - Import = replace current config целиком после строгой валидации.
 *
 * Запрещено:
 *   - Hidden merge/migration/autofix на импорте.
 *   - Скрыто изменять runtime routing/FIFO semantics под видом config persistence.
 */

import type { BrowserPersistenceAdapter, ImportReadResult, PersistenceLoadResult } from "../adapters/browser_persistence.js";
import {
  cloneAppConfig,
  createDefaultAppConfig,
  type AppConfig,
  type DeviceType,
  type ScenarioGroupPreference,
  type WheelStepMultiplier,
  type WindowConfig,
  type WindowId,
} from "../contracts/config.js";
import type { StateStore } from "./state_store.js";

export type ConfigStore = {
  loadPersistedConfig: () => PersistenceLoadResult;
  startAutosave: () => () => void;
  getConfig: () => AppConfig;
  replaceConfig: (config: AppConfig) => void;
  updateIpRanges: (ranges: AppConfig["ipRanges"]) => void;
  addWindowConfig: (windowConfig: WindowConfig) => void;
  patchWindowConfig: (
    windowId: WindowId,
    patch: Partial<{
      targetIp: string;
      title: string;
      titleMode: "default" | "custom";
      buttonLabels: Record<string, string>;
      wheelStepMultiplier: WheelStepMultiplier | undefined;
    }>,
  ) => void;
  removeWindowConfig: (windowId: WindowId) => void;
  setWindowOrder: (windowIds: WindowId[], layoutCustomized?: boolean, layoutRowStarts?: WindowId[]) => void;
  setScenarioPreference: (groupKey: string, preference: ScenarioGroupPreference) => void;
  deleteScenarioPreference: (groupKey: string) => void;
  clearPersistedConfig: () => void;
  exportConfigToFile: () => void;
  importConfigFile: (file: File) => Promise<ImportReadResult>;
};

/**
 * Назначение:
 *   Создать ConfigStore поверх StateStore и browser persistence adapter.
 *
 * Preconditions:
 *   - `store` реализует config/runtime state separation.
 *   - `persistenceAdapter` реализует load/save/export/import для AppConfig.
 *
 * Postconditions:
 *   - Возвращает ConfigStore API для autoload/autosave/export/import и config-mutations.
 *
 * Инварианты:
 *   - Любая config mutation выполняется через `store.dispatch("config/*")`.
 *   - Autosave использует JSON snapshot only for config slice.
 *
 * State transitions:
 *   - `store.config` меняется только через ConfigStore методы либо `config/replaceAll`.
 *   - `localStorage` обновляется при фактическом изменении config snapshot.
 *
 * Execution Trace:
 *   1. Зафиксировать store и adapter.
 *   2. Реализовать thin wrapper methods для config mutations.
 *   3. Реализовать autosave через compare(lastSavedSnapshot, nextSnapshot).
 */
export function createConfigStore(deps: {
  store: StateStore;
  persistenceAdapter: BrowserPersistenceAdapter;
}): ConfigStore {
  const { store, persistenceAdapter } = deps;

  function loadPersistedConfig(): PersistenceLoadResult {
    return persistenceAdapter.load();
  }

  function startAutosave(): () => void {
    let lastSnapshot = JSON.stringify(store.getConfig());

    return store.subscribe(() => {
      const nextSnapshot = JSON.stringify(store.getConfig());
      if (nextSnapshot === lastSnapshot) return;
      lastSnapshot = nextSnapshot;
      persistenceAdapter.save(store.getConfig());
    });
  }

  function getConfig(): AppConfig {
    return store.getConfig();
  }

  function replaceConfig(config: AppConfig): void {
    store.dispatch({ type: "config/replaceAll", payload: { config: cloneAppConfig(config) } });
  }

  function updateIpRanges(ranges: AppConfig["ipRanges"]): void {
    store.dispatch({
      type: "config/setIpRanges",
      payload: {
        rx: { ...ranges.rx },
        tx: { ...ranges.tx },
      },
    });
  }

  function addWindowConfig(windowConfig: WindowConfig): void {
    store.dispatch({
      type: "config/addWindow",
      payload: { windowConfig: cloneWindowConfig(windowConfig) },
    });
  }

  function patchWindowConfig(
    windowId: WindowId,
    patch: Partial<{
      targetIp: string;
      title: string;
      titleMode: "default" | "custom";
      buttonLabels: Record<string, string>;
      wheelStepMultiplier: WheelStepMultiplier | undefined;
    }>,
  ): void {
    store.dispatch({
      type: "config/updateWindow",
      payload: {
        windowId,
        patch: {
          ...patch,
          buttonLabels: patch.buttonLabels ? { ...patch.buttonLabels } : undefined,
        },
      },
    });
  }

  function removeWindowConfig(windowId: WindowId): void {
    store.dispatch({ type: "config/removeWindow", payload: { windowId } });
  }

  function setWindowOrder(windowIds: WindowId[], layoutCustomized = true, layoutRowStarts: WindowId[] = []): void {
    store.dispatch({
      type: "config/setWindowOrder",
      payload: {
        windowIds: windowIds.slice(),
        layoutCustomized,
        layoutRowStarts: layoutRowStarts.slice(),
      },
    });
  }

  function setScenarioPreference(groupKey: string, preference: ScenarioGroupPreference): void {
    store.dispatch({
      type: "config/setScenarioGroup",
      payload: {
        groupKey,
        scenario: preference.scenario,
        queueOrder: preference.queueOrder.slice(),
      },
    });
  }

  function deleteScenarioPreference(groupKey: string): void {
    store.dispatch({ type: "config/deleteScenarioGroup", payload: { groupKey } });
  }

  function clearPersistedConfig(): void {
    persistenceAdapter.clear();
    replaceConfig(createDefaultAppConfig());
  }

  function exportConfigToFile(): void {
    persistenceAdapter.exportConfig(store.getConfig());
  }

  async function importConfigFile(file: File): Promise<ImportReadResult> {
    return persistenceAdapter.readConfigFile(file);
  }

  return {
    loadPersistedConfig,
    startAutosave,
    getConfig,
    replaceConfig,
    updateIpRanges,
    addWindowConfig,
    patchWindowConfig,
    removeWindowConfig,
    setWindowOrder,
    setScenarioPreference,
    deleteScenarioPreference,
    clearPersistedConfig,
    exportConfigToFile,
    importConfigFile,
  };
}

function cloneWindowConfig(windowConfig: WindowConfig): WindowConfig {
  return JSON.parse(JSON.stringify(windowConfig)) as WindowConfig;
}
