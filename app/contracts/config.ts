/**
 * MODULE: app/contracts/config.ts
 *
 * Назначение:
 *   Каноничный сериализуемый контракт конфигурации Sprint 4:
 *   - AppConfig / WindowConfig / ScenarioGroupPreference,
 *   - дефолтные значения и детерминированные builder-функции,
 *   - строгая валидация импортируемой/автозагружаемой конфигурации.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §4.2, §4.5, §4.8, §4.9, §7.1, §7.2
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.8, §5.6.4, §6.1–§6.4
 *   - SPRINT_PLAN_vNext.3.2 Sprint 4 D4-1..D4-6, AC4-1..AC4-11
 *
 * Инварианты уровня модуля:
 *   - Конфигурация содержит только сериализуемые данные; WS/DOM/FIFO runtime pointers сюда не попадают.
 *   - `windowId` является стабильным идентификатором окна и используется для layout / queue / menu persistence.
 *   - Queue persistence Scenario 2 хранится по `windowId[]`, а не по IP.
 *   - Версия конфигурации детерминирована и проверяется строго.
 *
 * Запрещено:
 *   - Хранить в конфиге WebSocket-объекты, DOM refs, runtime FIFO pointer или любые несериализуемые сущности.
 *   - Выполнять "умные" миграции или скрыто исправлять битую структуру.
 */

export type DeviceType = "rx" | "tx" | "opu";
export type WindowId = string;
export type WheelStepMultiplier = "x1" | "x2" | "x5" | "x10";
export type TitleMode = "default" | "custom";

export type IpRangeConfig = {
  start: string;
  end: string;
};

export type ScenarioGroupPreference = {
  scenario: 1 | 2;
  queueOrder: WindowId[];
};

export type WindowConfig = {
  windowId: WindowId;
  deviceType: DeviceType;
  targetIp: string;
  title: string;
  titleMode: TitleMode;
  buttonLabels: Record<string, string>;
  wheelStepMultiplier?: WheelStepMultiplier;
  order: number;
  createdAtMs: number;
};

export type AppConfig = {
  version: typeof CONFIG_VERSION;
  layoutCustomized: boolean;
  /**
   * Начала пользовательских рядов после первого ряда.
   * Например, order [A,B,C,D] + layoutRowStarts [C] => rows [A,B] / [C,D].
   */
  layoutRowStarts?: WindowId[];
  ipRanges: {
    rx: IpRangeConfig;
    tx: IpRangeConfig;
  };
  windows: WindowConfig[];
  scenarioGroups: Record<string, ScenarioGroupPreference>;
};

export type ConfigValidationResult =
  | { ok: true; config: AppConfig }
  | { ok: false; reason: string };

export const CONFIG_VERSION = "vNext.3" as const;
export const CONFIG_STORAGE_KEY = "radiantos:vNext.3:appConfig" as const;

const DEFAULT_IP_RANGES = Object.freeze({
  rx: Object.freeze({ start: "192.168.1.101", end: "192.168.1.120" }),
  tx: Object.freeze({ start: "192.168.1.121", end: "192.168.1.140" }),
});

/**
 * Назначение:
 *   Создать пустую детерминированную конфигурацию Sprint 4 с дефолтными диапазонами SSOT.
 *
 * Preconditions:
 *   - Внешние зависимости не требуются.
 *
 * Postconditions:
 *   - Возвращает сериализуемый `AppConfig` без окон и без scenarioGroups.
 *
 * Инварианты:
 *   - `version` строго равен `vNext.3`.
 *   - `layoutCustomized=false` до первого drag&drop окон.
 *   - Дефолтные IP ranges соответствуют SSOT/Sprint Plan.
 *
 * State transitions:
 *   - N/A (чистая builder-функция).
 *
 * Execution Trace:
 *   1. Сформировать top-level объект AppConfig.
 *   2. Заполнить дефолтные ranges RX/TX.
 *   3. Инициализировать пустые `windows` и `scenarioGroups`.
 */
export function createDefaultAppConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    layoutCustomized: false,
    layoutRowStarts: [],
    ipRanges: {
      rx: { ...DEFAULT_IP_RANGES.rx },
      tx: { ...DEFAULT_IP_RANGES.tx },
    },
    windows: [],
    scenarioGroups: {},
  };
}

/**
 * Назначение:
 *   Создать детерминированный набор текстовых лейблов кнопок для окна устройства.
 *
 * Preconditions:
 *   - `deviceType` должен быть одним из `rx | tx | opu`.
 *
 * Postconditions:
 *   - Возвращает новый объект `Record<string,string>` с дефолтными подписями кнопок.
 *
 * Инварианты:
 *   - RX/TX содержат только user-visible labels, которые редактируются через Sprint 4 menu.
 *   - OPU labels фиксированы и не используются для отдельного OPU-menu.
 *
 * State transitions:
 *   - N/A (чистая функция).
 *
 * Execution Trace:
 *   1. Выбрать карту дефолтов по типу устройства.
 *   2. Вернуть новый объект без разделяемых ссылок.
 */
export function createDefaultButtonLabels(deviceType: DeviceType): Record<string, string> {
  if (deviceType === "rx") {
    return {
      scan: "Сканировать",
      inv: "Инвертировать",
      send: "Отправить",
      ignore: "Игнорировать",
      clear: "X",
    };
  }

  if (deviceType === "tx") {
    return {
      off: "Выкл",
      scenario: "Сценарий",
      clear: "X",
    };
  }

  return {
    setUgol: "Установить угол",
    setCentrUgol: "Установить центр",
    setSpeed: "Установить скорость",
  };
}

/**
 * Назначение:
 *   Создать `WindowConfig` для нового окна без примеси runtime-состояния.
 *
 * Preconditions:
 *   - `input.windowId` уникален в пределах текущего AppConfig.
 *   - `input.targetIp` проходит строгую IPv4-валидацию.
 *   - `input.order` и `input.createdAtMs` являются конечными числами.
 *
 * Postconditions:
 *   - Возвращает полностью сериализуемый `WindowConfig`.
 *
 * Инварианты:
 *   - `titleMode="default"` означает, что display-title может быть детерминированно пересчитан из runtime common/range.
 *   - `wheelStepMultiplier` задаётся только для RX; для остальных типов отсутствует.
 *
 * State transitions:
 *   - N/A (чистая builder-функция).
 *
 * Execution Trace:
 *   1. Выбрать дефолтные buttonLabels по типу окна.
 *   2. Сформировать сериализуемый WindowConfig.
 *   3. Для RX добавить дефолтный wheel step `x1`.
 */
export function createWindowConfig(input: {
  windowId: WindowId;
  deviceType: DeviceType;
  targetIp: string;
  title: string;
  order: number;
  createdAtMs: number;
}): WindowConfig {
  return {
    windowId: input.windowId,
    deviceType: input.deviceType,
    targetIp: input.targetIp,
    title: input.title,
    titleMode: "default",
    buttonLabels: createDefaultButtonLabels(input.deviceType),
    wheelStepMultiplier: input.deviceType === "rx" ? "x1" : undefined,
    order: input.order,
    createdAtMs: input.createdAtMs,
  };
}

/**
 * Назначение:
 *   Выполнить глубокое сериализуемое клонирование `AppConfig`.
 *
 * Preconditions:
 *   - `config` является корректным сериализуемым объектом конфигурации.
 *
 * Postconditions:
 *   - Возвращает новый объект без разделяемых ссылок.
 *
 * Инварианты:
 *   - Используется только JSON-safe clone, потому что конфиг обязан быть сериализуемым.
 *
 * State transitions:
 *   - N/A (чистая функция).
 */
export function cloneAppConfig(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

/**
 * Назначение:
 *   Детерминированно пронумеровать layout order окон последовательностью `0..N-1`.
 *
 * Preconditions:
 *   - `windows` содержит уникальные `windowId`.
 *
 * Postconditions:
 *   - Возвращает новый массив `WindowConfig[]`, отсортированный по `order`, затем по `createdAtMs`, затем по `windowId`.
 *   - Каждое окно получает уникальный `order` без пропусков.
 *
 * Инварианты:
 *   - Функция не меняет содержимое window settings, кроме `order`.
 *   - Дет. tie-break исключает дрейф порядка при одинаковых `order`.
 *
 * State transitions:
 *   - N/A (чистая нормализация массива).
 *
 * Execution Trace:
 *   1. Отсортировать копию массива по `order` / `createdAtMs` / `windowId`.
 *   2. Переназначить `order = index`.
 *   3. Вернуть новый массив.
 */
export function ensureSequentialWindowOrder(windows: WindowConfig[]): WindowConfig[] {
  const sorted = windows
    .slice()
    .sort((a, b) => a.order - b.order || a.createdAtMs - b.createdAtMs || a.windowId.localeCompare(b.windowId));

  return sorted.map((windowConfig, index) => ({
    ...windowConfig,
    order: index,
    buttonLabels: { ...windowConfig.buttonLabels },
  }));
}

/**
 * Назначение:
 *   Строго проверить значение как `AppConfig` Sprint 4 и вернуть детерминированный результат валидации.
 *
 * Preconditions:
 *   - `value` может быть любым результатом `JSON.parse()` / localStorage / FileReader.
 *
 * Postconditions:
 *   - `ok=true` только если структура полностью соответствует поддерживаемому config-моделю Sprint 4.
 *   - `ok=false` при любой несовместимости версии, формы или primitive types.
 *
 * Инварианты:
 *   - Никаких "умных" миграций, дополнения полей по умолчанию или скрытой коррекции повреждённого JSON.
 *   - Проверяются required top-level fields, window shapes, queue arrays и уникальность targetIp/windowId.
 *
 * State transitions:
 *   - N/A (чистая функция-валидатор).
 *
 * Execution Trace:
 *   1. Проверить top-level object и `version`.
 *   2. Провалидировать `ipRanges`, `layoutCustomized`, optional `layoutRowStarts`, `windows`, `scenarioGroups`.
 *   3. Проверить уникальность `windowId` и `targetIp`.
 *   4. Нормализовать window order последовательностью 0..N-1.
 *   5. Вернуть `ok:true` с клоном конфигурации либо `ok:false` с причиной.
 */
export function validateAppConfig(value: unknown): ConfigValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "config_not_object" };
  }

  if (value.version !== CONFIG_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }

  if (typeof value.layoutCustomized !== "boolean") {
    return { ok: false, reason: "layoutCustomized_invalid" };
  }

  if (value.layoutRowStarts !== undefined && !Array.isArray(value.layoutRowStarts)) {
    return { ok: false, reason: "layoutRowStarts_invalid" };
  }

  if (!isPlainObject(value.ipRanges)) {
    return { ok: false, reason: "ipRanges_invalid" };
  }

  const rxRange = validateIpRangeConfig(value.ipRanges.rx);
  if (!rxRange.ok) {
    const reason = (rxRange as { ok: false; reason: string }).reason;
    return { ok: false, reason: `ipRanges.rx.${reason}` };
  }

  const txRange = validateIpRangeConfig(value.ipRanges.tx);
  if (!txRange.ok) {
    const reason = (txRange as { ok: false; reason: string }).reason;
    return { ok: false, reason: `ipRanges.tx.${reason}` };
  }

  if (!Array.isArray(value.windows)) {
    return { ok: false, reason: "windows_not_array" };
  }

  if (!isPlainObject(value.scenarioGroups)) {
    return { ok: false, reason: "scenarioGroups_invalid" };
  }

  const windowIds = new Set<string>();
  const targetIps = new Set<string>();
  const windows: WindowConfig[] = [];

  for (let index = 0; index < value.windows.length; index += 1) {
    const validated = validateWindowConfig(value.windows[index]);
    if (!validated.ok) {
      const reason = (validated as { ok: false; reason: string }).reason;
      return { ok: false, reason: `windows[${index}].${reason}` };
    }

    if (windowIds.has(validated.windowConfig.windowId)) {
      return { ok: false, reason: `windows[${index}].windowId_duplicate` };
    }
    if (targetIps.has(validated.windowConfig.targetIp)) {
      return { ok: false, reason: `windows[${index}].targetIp_duplicate` };
    }

    windowIds.add(validated.windowConfig.windowId);
    targetIps.add(validated.windowConfig.targetIp);
    windows.push(validated.windowConfig);
  }

  const validatedLayoutRowStarts = validateLayoutRowStarts(value.layoutRowStarts, windowIds);
  if (!validatedLayoutRowStarts.ok) {
    const reason = (validatedLayoutRowStarts as { ok: false; reason: string }).reason;
    return { ok: false, reason: `layoutRowStarts.${reason}` };
  }

  const scenarioGroups: Record<string, ScenarioGroupPreference> = {};
  for (const [groupKey, prefValue] of Object.entries(value.scenarioGroups)) {
    const validatedPref = validateScenarioGroupPreference(prefValue, windowIds);
    if (!validatedPref.ok) {
      const reason = (validatedPref as { ok: false; reason: string }).reason;
      return { ok: false, reason: `scenarioGroups.${groupKey}.${reason}` };
    }
    scenarioGroups[groupKey] = validatedPref.preference;
  }

  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      layoutCustomized: value.layoutCustomized,
      layoutRowStarts: normalizeLayoutRowStarts(
        validatedLayoutRowStarts.rowStarts,
        ensureSequentialWindowOrder(windows).map((windowConfig) => windowConfig.windowId),
      ),
      ipRanges: { rx: rxRange.range, tx: txRange.range },
      windows: ensureSequentialWindowOrder(windows),
      scenarioGroups,
    },
  };
}

/**
 * Назначение:
 *   Проверить строку как строгий IPv4 без эвристик и автокоррекций.
 *
 * Preconditions:
 *   - `value` может быть любым входом пользователя/JSON.
 *
 * Postconditions:
 *   - `true` только если строка имеет форму `A.B.C.D` и каждый октет — целое число `[0..255]`.
 *
 * Инварианты:
 *   - Никаких trim/repair внутри валидатора; внешний код обязан передавать уже финальное значение.
 *
 * State transitions:
 *   - N/A (чистая функция).
 */
function validateLayoutRowStarts(
  value: unknown,
  knownWindowIds: Set<string>,
): { ok: true; rowStarts: WindowId[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, rowStarts: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "not_array" };

  const seen = new Set<string>();
  const rowStarts: WindowId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rowStart = value[index];
    if (typeof rowStart !== "string" || rowStart.length === 0) {
      return { ok: false, reason: `[${index}]_invalid` };
    }
    if (!knownWindowIds.has(rowStart)) {
      return { ok: false, reason: `[${index}]_unknown_windowId` };
    }
    if (seen.has(rowStart)) {
      return { ok: false, reason: `[${index}]_duplicate` };
    }
    seen.add(rowStart);
    rowStarts.push(rowStart);
  }

  return { ok: true, rowStarts };
}

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

export function isValidIpString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const numberValue = Number(part);
    if (!Number.isInteger(numberValue) || numberValue < 0 || numberValue > 255) {
      return false;
    }
  }

  return true;
}

function validateIpRangeConfig(value: unknown):
  | { ok: true; range: IpRangeConfig }
  | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "not_object" };
  if (!isValidIpString(value.start)) return { ok: false, reason: "start_invalid" };
  if (!isValidIpString(value.end)) return { ok: false, reason: "end_invalid" };
  return { ok: true, range: { start: value.start, end: value.end } };
}

function validateWindowConfig(value: unknown):
  | { ok: true; windowConfig: WindowConfig }
  | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "not_object" };
  if (typeof value.windowId !== "string" || value.windowId.length === 0) {
    return { ok: false, reason: "windowId_invalid" };
  }
  if (!isDeviceType(value.deviceType)) return { ok: false, reason: "deviceType_invalid" };
  if (!isValidIpString(value.targetIp)) return { ok: false, reason: "targetIp_invalid" };
  if (typeof value.title !== "string") return { ok: false, reason: "title_invalid" };
  if (value.titleMode !== "default" && value.titleMode !== "custom") {
    return { ok: false, reason: "titleMode_invalid" };
  }
  if (!Number.isFinite(value.order)) return { ok: false, reason: "order_invalid" };
  if (!Number.isFinite(value.createdAtMs)) return { ok: false, reason: "createdAtMs_invalid" };
  if (!isPlainObject(value.buttonLabels)) return { ok: false, reason: "buttonLabels_invalid" };

  if (value.deviceType === "rx") {
    if (!isWheelStepMultiplier(value.wheelStepMultiplier)) {
      return { ok: false, reason: "wheelStepMultiplier_invalid" };
    }
    if (!validateButtonLabelKeys(value.buttonLabels, ["scan", "inv", "send", "ignore", "clear"])) {
      return { ok: false, reason: "buttonLabels_keys_invalid" };
    }
  } else if (value.deviceType === "tx") {
    if (value.wheelStepMultiplier !== undefined) {
      return { ok: false, reason: "wheelStepMultiplier_forbidden" };
    }
    if (!validateButtonLabelKeys(value.buttonLabels, ["off", "scenario", "clear"])) {
      return { ok: false, reason: "buttonLabels_keys_invalid" };
    }
  } else {
    if (value.wheelStepMultiplier !== undefined) {
      return { ok: false, reason: "wheelStepMultiplier_forbidden" };
    }
    if (!validateButtonLabelKeys(value.buttonLabels, ["setUgol", "setCentrUgol", "setSpeed"])) {
      return { ok: false, reason: "buttonLabels_keys_invalid" };
    }
  }

  return {
    ok: true,
    windowConfig: {
      windowId: value.windowId as string,
      deviceType: value.deviceType as DeviceType,
      targetIp: value.targetIp as string,
      title: value.title as string,
      titleMode: value.titleMode as TitleMode,
      buttonLabels: { ...(value.buttonLabels as Record<string, string>) },
      wheelStepMultiplier: value.wheelStepMultiplier as WheelStepMultiplier | undefined,
      order: Math.trunc(value.order as number),
      createdAtMs: Math.trunc(value.createdAtMs as number),
    },
  };
}

function validateScenarioGroupPreference(
  value: unknown,
  knownWindowIds: Set<string>,
):
  | { ok: true; preference: ScenarioGroupPreference }
  | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "not_object" };
  if (value.scenario !== 1 && value.scenario !== 2) {
    return { ok: false, reason: "scenario_invalid" };
  }
  if (!Array.isArray(value.queueOrder)) {
    return { ok: false, reason: "queueOrder_not_array" };
  }

  const queueOrder: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.queueOrder.length; index += 1) {
    const item = value.queueOrder[index];
    if (typeof item !== "string" || item.length === 0) {
      return { ok: false, reason: `queueOrder[${index}]_invalid` };
    }
    if (!knownWindowIds.has(item)) {
      return { ok: false, reason: `queueOrder[${index}]_unknown_windowId` };
    }
    if (seen.has(item)) {
      return { ok: false, reason: `queueOrder[${index}]_duplicate` };
    }
    seen.add(item);
    queueOrder.push(item);
  }

  return {
    ok: true,
    preference: {
      scenario: value.scenario,
      queueOrder,
    },
  };
}

function validateButtonLabelKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  for (const key of expectedKeys) {
    if (typeof value[key] !== "string") return false;
  }
  return true;
}

function isWheelStepMultiplier(value: unknown): value is WheelStepMultiplier {
  return value === "x1" || value === "x2" || value === "x5" || value === "x10";
}

function isDeviceType(value: unknown): value is DeviceType {
  return value === "rx" || value === "tx" || value === "opu";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
