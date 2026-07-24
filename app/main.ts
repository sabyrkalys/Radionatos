/**
 * MODULE: app/main.ts
 *
 * Назначение:
 *   Sprint 4 bootstrap и orchestration root:
 *   - autoload/autosave AppConfig,
 *   - wiring Store / ConfigStore / WsTransport / DeviceRegistry / ScenarioManager,
 *   - mount стартового UI, диалога автопоиска и окон,
 *   - восстановление сохранённых окон и WS reconnect по target IP.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.1–§2.4, §4.1–§4.9, §7.1, §7.2, §11
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §3.2, §4.1–§4.10
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1–4, особенно D4-1..D4-7 / AC4-1..AC4-12
 *   - TECH_STACK_TRANSITION_CONTRACT_vNext.3.md §3, §6, §7
 *
 * Инварианты уровня модуля:
 *   - Единственный runtime transport = WS `ws://<ip>/ws`.
 *   - Browser persistence изолирован в adapter/configStore и не смешивается с WS runtime state.
 *   - При валидном persisted config окна поднимаются автоматически и reconnect-ятся без ручного поиска.
 *   - При отсутствии/ошибке persisted config старт остаётся "только Автопоиск" без падения.
 *
 * Запрещено:
 *   - Любой HTTP/DATA/polling/backend/proxy requirement.
 *   - Hidden migrations/merge при import.
 *   - Расширение бизнес-логики Sprint 1–3 под видом bootstrap-рефакторинга.
 */

import { createBrowserPersistenceAdapter } from "./adapters/browser_persistence.js";
import { createWsTransport } from "./adapters/ws_transport.js";
import { createConfigStore } from "./core/config_store.js";
import { createDeviceRegistry, type IpRanges } from "./core/device_registry.js";
import { createMessageRouter } from "./core/message_router.js";
import { createOpuCommandDispatcher } from "./core/opu_commands.js";
import { createPresenceTracker } from "./core/presence_tracker.js";
import { createRxCommandDispatcher } from "./core/rx_commands.js";
import { createScenarioManager } from "./core/scenario_manager.js";
import { createStateStore } from "./core/state_store.js";
import { createTxCommandDispatcher } from "./core/tx_commands.js";
import { mountAutosearchDialog } from "./ui/autosearch_dialog.js";
import { mountWindows } from "./ui/windows.js";

const PRESENCE_WINDOW_MS = 2500;
const PRESENCE_TICK_MS = 250;
const DISCOVERY_TIMEOUT_MS = 3000;
const SCAN_CONCURRENCY = 24;

bootstrap();

/**
 * Назначение:
 *   Инициализировать всё приложение Sprint 4 и выполнить deterministic startup-path.
 *
 * Preconditions:
 *   - `index.html` содержит mount points `btn-autosearch`, `autosearch-mount`, `windows-root`.
 *   - Browser environment поддерживает DOM/WebSocket/localStorage.
 *
 * Postconditions:
 *   - Смонтирован UI, запущен presence tracker и autosave.
 *   - При валидном persisted config выполнен autoload + reconnect.
 *   - При missing/invalid config приложение остаётся в стартовом состоянии с одной кнопкой "Автопоиск".
 *
 * Инварианты:
 *   - Import = replace current config целиком.
 *   - `newConfig=true` очищает runtime + persistence перед новым scan.
 *   - Config warnings fail-soft и не валят bootstrap.
 *
 * State transitions:
 *   - `store.config`: default -> persisted config (если loaded).
 *   - `store.runtime`: placeholders -> live WS state при reconnect/discovery.
 *
 * Execution Trace:
 *   1. Создать core/adapters/services.
 *   2. Попробовать autoload persisted config.
 *   3. Смонтировать UI.
 *   4. Запустить presence + autosave.
 *   5. Если config loaded -> reconnect сохранённых окон.
 */
function bootstrap(): void {
  const store = createStateStore();
  const persistenceAdapter = createBrowserPersistenceAdapter();
  const configStore = createConfigStore({ store, persistenceAdapter });
  const wsTransport = createWsTransport();
  const messageRouter = createMessageRouter({ store });

  const presenceTracker = createPresenceTracker({
    store,
    presenceWindowMs: PRESENCE_WINDOW_MS,
    tickMs: PRESENCE_TICK_MS,
  });

  const rxCommands = createRxCommandDispatcher({
    wsTransport,
    warn: (message) => window.alert(message),
  });

  const txCommands = createTxCommandDispatcher({
    wsTransport,
    warn: (message) => window.alert(message),
  });

  const opuCommands = createOpuCommandDispatcher({
    wsTransport,
    warn: (message) => window.alert(message),
  });

  const scenarioManager = createScenarioManager({
    store,
    configStore,
    txCommands,
  });

  const deviceRegistry = createDeviceRegistry({
    store,
    configStore,
    wsTransport,
    presenceTracker,
    messageRouter,
    discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    scanConcurrency: SCAN_CONCURRENCY,
  });

  const autoloadResult = configStore.loadPersistedConfig();
  const autoloadedConfig = autoloadResult.kind === "loaded" ? autoloadResult.config : null;
  if (autoloadedConfig) {
    scenarioManager.resetEphemera();
    configStore.replaceConfig(autoloadedConfig);
  } else if (autoloadResult.kind === "invalid") {
    console.warn("[config] autoload invalid; startup continues with empty state", autoloadResult.reason);
  }

  const btnAutosearch = document.getElementById("btn-autosearch") as HTMLButtonElement | null;
  const autosearchMount = document.getElementById("autosearch-mount") as HTMLElement | null;
  const windowsMount = document.getElementById("windows-root") as HTMLElement | null;

  if (!btnAutosearch || !autosearchMount || !windowsMount) {
    throw new Error("Bootstrap failed: missing required DOM mount points.");
  }

  let scanInFlight = false;

  const autosearchDialog = mountAutosearchDialog({
    mountPoint: autosearchMount,
    getCurrentRanges: () => store.getConfig().ipRanges,
    onScan: async (ranges, newConfig) => {
      await runExclusiveScan(async () => {
        if (newConfig) {
          await deviceRegistry.prepareFreshScan();
          scenarioManager.resetEphemera();
          configStore.clearPersistedConfig();
        }

        configStore.updateIpRanges(ranges);
        await deviceRegistry.scan(ranges);
        await deviceRegistry.activateQueuedWindows();
      });
    },
    onExportConfig: () => {
      configStore.exportConfigToFile();
    },
    onImportConfig: async (file) => {
      if (scanInFlight) {
        return {
          ok: false as const,
          warning: "Поиск уже выполняется. Дождитесь завершения текущего цикла.",
        };
      }

      const imported = await configStore.importConfigFile(file);
      if (!imported.ok) {
        const reason = (imported as { ok: false; reason: string }).reason;
        return {
          ok: false as const,
          warning: explainConfigWarning(reason, "import"),
        };
      }

      setScanBusy(true);
      try {
        await deviceRegistry.prepareFreshScan();
        scenarioManager.resetEphemera();
        configStore.replaceConfig(imported.config);
        deviceRegistry.connectConfiguredWindows();
        return { ok: true as const };
      } finally {
        setScanBusy(false);
      }
    },
  });

  function setScanBusy(busy: boolean): void {
    scanInFlight = busy;
    btnAutosearch.disabled = busy;
    btnAutosearch.textContent = busy ? "Автопоиск..." : "Автопоиск";
    autosearchDialog.setBusy(busy);
  }

  async function runExclusiveScan(task: () => Promise<void>): Promise<void> {
    if (scanInFlight) return;
    setScanBusy(true);
    try {
      await task();
    } finally {
      setScanBusy(false);
    }
  }

  btnAutosearch.addEventListener("click", () => {
    if (scanInFlight) return;
    autosearchDialog.open();
  });

  mountWindows({
    mountPoint: windowsMount,
    store,
    configStore,
    deviceRegistry,
    rxCommands,
    txCommands,
    opuCommands,
    scenarioManager,
  });

  presenceTracker.start();
  configStore.startAutosave();

  if (autoloadedConfig && autoloadedConfig.windows.length > 0) {
    deviceRegistry.connectConfiguredWindows();
  }
}

function explainConfigWarning(reason: string, mode: "autoload" | "import"): string {
  const prefix = mode === "import" ? "Импорт отклонён" : "Автозагрузка конфигурации отклонена";

  switch (reason) {
    case "import_json_parse_failed":
    case "autoload_json_parse_failed":
      return `${prefix}: JSON не удалось распарсить.`;
    case "unsupported_version":
      return `${prefix}: неподдерживаемая версия конфигурации.`;
    case "config_not_object":
      return `${prefix}: корневой JSON должен быть объектом.`;
    case "windows_not_array":
      return `${prefix}: поле windows должно быть массивом.`;
    case "scenarioGroups_invalid":
      return `${prefix}: поле scenarioGroups имеет невалидную форму.`;
    default:
      return `${prefix}: конфигурация не прошла строгую валидацию (${reason}).`;
  }
}
