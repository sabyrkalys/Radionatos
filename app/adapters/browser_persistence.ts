/**
 * MODULE: app/adapters/browser_persistence.ts
 *
 * Назначение:
 *   Browser-native persistence adapter Sprint 4:
 *   - autoload/autosave через localStorage,
 *   - export JSON в файл на компьютере,
 *   - import JSON из файла пользователя,
 *   - строгая валидация без скрытых миграций.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §4.9
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.8
 *   - SPRINT_PLAN_vNext.3.2 Sprint 4 D4-1..D4-2, AC4-1..AC4-4, AC4-11
 *
 * Инварианты уровня модуля:
 *   - Persistence изолирован от runtime WS state.
 *   - Storage key детерминирован и стабилен.
 *   - Import всегда заменяет конфигурацию целиком только после строгой валидации.
 *
 * Запрещено:
 *   - Любые скрытые merge/migration/autofix операции.
 *   - Хранить в browser persistence что-либо кроме сериализуемого AppConfig JSON.
 */

import {
  CONFIG_STORAGE_KEY,
  cloneAppConfig,
  type AppConfig,
  validateAppConfig,
} from "../contracts/config.js";

export type PersistenceLoadResult =
  | { kind: "loaded"; config: AppConfig }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

export type ImportReadResult =
  | { ok: true; config: AppConfig }
  | { ok: false; reason: string };

export type BrowserPersistenceAdapter = {
  load: () => PersistenceLoadResult;
  save: (config: AppConfig) => boolean;
  clear: () => void;
  exportConfig: (config: AppConfig, fileName?: string) => void;
  readConfigFile: (file: File) => Promise<ImportReadResult>;
  getStorageKey: () => string;
};

/**
 * Назначение:
 *   Создать browser persistence adapter со строгой localStorage/file-JSON семантикой.
 *
 * Preconditions:
 *   - Выполняется в браузерной среде с доступными `localStorage`, `Blob`, `FileReader`.
 *
 * Postconditions:
 *   - Возвращает adapter API для load/save/clear/export/readConfigFile.
 *
 * Инварианты:
 *   - `load()` и `readConfigFile()` всегда валидируют AppConfig через единый validator.
 *   - `save()` сериализует только `cloneAppConfig(config)`.
 *
 * State transitions:
 *   - localStorage[storageKey]: absent/string -> string/absent.
 *
 * Execution Trace:
 *   1. Зафиксировать deterministic storage key.
 *   2. Реализовать load/save/clear над localStorage.
 *   3. Реализовать export через Blob + object URL.
 *   4. Реализовать import reader через FileReader + JSON.parse + validateAppConfig().
 */
export function createBrowserPersistenceAdapter(): BrowserPersistenceAdapter {
  const storageKey = CONFIG_STORAGE_KEY;

  function getStorageKey(): string {
    return storageKey;
  }

  function load(): PersistenceLoadResult {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return { kind: "missing" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "invalid", reason: "autoload_json_parse_failed" };
    }

    const validation = validateAppConfig(parsed);
    if (!validation.ok) {
      const reason = (validation as { ok: false; reason: string }).reason;
      return { kind: "invalid", reason };
    }

    return { kind: "loaded", config: cloneAppConfig(validation.config) };
  }

  function save(config: AppConfig): boolean {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(cloneAppConfig(config), null, 2));
      return true;
    } catch {
      return false;
    }
  }

  function clear(): void {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // fail-soft
    }
  }

  function exportConfig(config: AppConfig, fileName = buildExportFileName()): void {
    const payload = JSON.stringify(cloneAppConfig(config), null, 2);
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async function readConfigFile(file: File): Promise<ImportReadResult> {
    const text = await readFileAsText(file);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "import_json_parse_failed" };
    }

    const validation = validateAppConfig(parsed);
    if (!validation.ok) {
      const reason = (validation as { ok: false; reason: string }).reason;
      return { ok: false, reason };
    }

    return { ok: true, config: cloneAppConfig(validation.config) };
  }

  return {
    load,
    save,
    clear,
    exportConfig,
    readConfigFile,
    getStorageKey,
  };
}

function buildExportFileName(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `radiantos_config_${yyyy}-${mm}-${dd}.json`;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("file_read_failed"));
    reader.readAsText(file, "utf-8");
  });
}
