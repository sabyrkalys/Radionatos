/**
 * MODULE: app/contracts/canon.ts
 *
 * Назначение:
 *   Каноничный (CANON) слой протокольных констант и минимальных проверок
 *   для vNext.3 WS-driven реализации.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.2–2.4 (WS-only, JSON-only, discovery gate)
 *   - ТЗ_vNext.3_Final_SSOT §4.3 (детерминированная типизация A→B→unknown(close))
 *   - ТЗ_vNext.3_Final_SSOT §5 (каноничный JSON-контракт)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1 AC1-5..AC1-6 (валидный JSON-object; Common=полный набор ключей)
*   - ARCHITECTURE_BASELINE_vNext.3.2.md §2.3 + §5
 *
 * Инварианты уровня модуля:
 *   - "Валидное сообщение" для discovery/presence = JSON, распарсенный именно в объект (не array, не null).
 *   - LEGACY (устаревшие ключи) не используется как источник реализации:
 *     такие сообщения считаются invalid (fail-soft) и не влияют на presence/discovery/state.
 *   - Этот модуль не делает типизацию и не реализует доменную логику окон.
 *
 * Запрещено:
 *   - Использовать legacy-ключи как основание для роутинга/типизации/состояния.
 *   - Считать валидным JSON не-объект (array/string/number/null).
 *   - Добавлять новые поля протокола, отсутствующие в SSOT CANON.
 */

export const CANON = Object.freeze({
  COMMON_KEYS_FULL: ["name", "ip", "mac", "mask", "gw", "poz"],

  // Ключи для типизации по state (приоритет B), строго как в SSOT.
  TYPING_KEYS: Object.freeze({
    RX_ANY2: ["ud", "inv", "frq", "frq_range", "spectr_rssi"],
    TX_ANY2: ["U", "I", "P", "T", "tx_ch", "frq_tx_out", "frq_range"],
    OPU_REQUIRED: ["lat", "lng", "ugol"],
  }),

  // Набор явно устаревших ключей (legacy contamination).
  // Используется только для признания сообщения invalid, без какой-либо "поддержки legacy".
  LEGACY_KEYS: [
    "NAME",
    "UD",
    "INV",
    "FRQ",
    "RSSI",
    "FRQ1",
    "FRQ2",
    "FRQ3",
    "FREQ_min",
    "FREQ_max",
    "FREQ_SCAN_min",
    "FREQ_SCAN_max",
    "SPECTRUM_RSSI",
    "CH_ignor",
    "set_CH_ignor",
  ],
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  /**
   * Назначение:
   *   Минимальная проверка "JSON-object" для vNext.3 протокола:
   *   валидным для discovery/presence считается только plain object (не массив, не null).
   *
   * Preconditions:
   *   - value может быть любым значением (unknown).
   *
   * Postconditions:
   *   - true только если value является объектом, не null и не Array.
   *
   * Инварианты:
   *   - JSON не-object (array/string/number/null) никогда не считается валидным сообщением.
   *
   * State transitions:
   *   N/A (чистая функция)
   */
  // 1. Отсечь всё, что не typeof "object" или является null.
  // 2. Отсечь Array (массив не является JSON-object по контракту).
  // 3. Вернуть булев результат проверки.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} text
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function safeJsonParse(text) {
  /**
   * Назначение:
   *   Fail-soft парсинг JSON без исключений наружу.
   *
   * Preconditions:
   *   - text является строкой WS text frame.
   *
   * Postconditions:
   *   - Никогда не бросает исключение.
   *   - ok=true только при успешном JSON.parse().
   *
   * Инварианты:
   *   - Ошибка парсинга не приводит к падению приложения.
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. Выполнить JSON.parse(text) в try/catch.
   *   2. При успехе вернуть {ok:true,value}.
   *   3. При ошибке вернуть {ok:false,error}.
   */
  // 1. Парсим JSON (fail-soft).
  try {
    // 2. Успех: вернуть результат.
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    // 3. Ошибка: вернуть ok=false.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {Record<string, any>} obj
 * @returns {boolean}
 */
export function looksLikeLegacy(obj) {
  /**
   * Назначение:
   *   Детектировать "legacy contamination" по явно устаревшим ключам.
   *
   * Preconditions:
   *   - obj уже проверен как plain object.
   *
   * Postconditions:
   *   - true означает: объект содержит хотя бы один ключ из списка legacy.
   *
   * Инварианты:
   *   - Legacy-детект НЕ является поддержкой legacy-протокола.
   *   - Детект используется только чтобы считать сообщение invalid (fail-soft).
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. Перебрать список CANON.LEGACY_KEYS.
   *   2. Если найден любой ключ (own property) — вернуть true.
   *   3. Иначе вернуть false.
   */
  // 1. Перебираем запрещённые ключи.
  for (const k of CANON.LEGACY_KEYS) {
    // 2. Любое совпадение => legacy contamination.
    if (Object.prototype.hasOwnProperty.call(obj, k)) return true;
  }
  // 3. Совпадений нет.
  return false;
}

/**
 * @param {string} textFrame
 * @returns {{
 *   kind: "valid",
 *   obj: Record<string, any>
 * } | {
 *   kind: "invalid",
 *   reason: "json_parse" | "not_object" | "legacy_contamination"
 * }}
 */
export function parseWsTextFrame(textFrame) {
  /**
   * Назначение:
   *   Превратить WS text frame в валидный CANON JSON-object либо отфильтровать как invalid (fail-soft).
   *
   * Preconditions:
   *   - textFrame получен из одного WS text frame (1 frame = 1 JSON value).
   *
   * Postconditions:
   *   - kind="valid" только если JSON распарсился именно в объект и он не legacy-contaminated.
   *   - kind="invalid" во всех остальных случаях.
   *
   * Инварианты:
   *   - "valid" здесь означает годность для discovery/presence (а не "соответствие схеме устройства").
   *   - LEGACY считается invalid и не влияет на presence/discovery/state.
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. safeJsonParse(textFrame).
   *   2. Если parse error → invalid(json_parse).
   *   3. Если результат не объект → invalid(not_object).
   *   4. Если legacy contamination → invalid(legacy_contamination).
   *   5. Иначе → valid(obj).
   */
  // 1. Парсим JSON.
  const parsed = safeJsonParse(textFrame);

  // 2. Ошибка парсинга.
  if (!parsed.ok) return { kind: "invalid", reason: "json_parse" };

  // 3. Валидность по форме: только объект.
  if (!isPlainObject(parsed.value)) return { kind: "invalid", reason: "not_object" };

  // 4. Legacy contamination => invalid.
  const obj = /** @type {Record<string, any>} */ (parsed.value);
  if (looksLikeLegacy(obj)) return { kind: "invalid", reason: "legacy_contamination" };

  // 5. CANON JSON-object.
  return { kind: "valid", obj };
}

/**
 * @param {Record<string, any>} obj
 * @returns {boolean}
 */
export function isCommonObject(obj) {
  /**
   * Назначение:
   *   Детерминированно распознать Common JSON по полному набору ключей.
   *
   * Preconditions:
   *   - obj является plain object.
   *
   * Postconditions:
   *   - true только если obj содержит ПОЛНЫЙ набор ключей Common (как в SSOT/SprintPlan).
   *
   * Инварианты:
   *   - Частичный Common НЕ считается Common (нельзя "додумывать").
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. Проверить наличие всех ключей из CANON.COMMON_KEYS_FULL.
   *   2. При первом отсутствующем ключе вернуть false.
   *   3. Если все ключи присутствуют — вернуть true.
   */
  // 1. Все ключи Common должны присутствовать.
  for (const k of CANON.COMMON_KEYS_FULL) {
    // 2. Любой пропуск => не Common.
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  }
  // 3. Полный набор ключей найден.
  return true;
}

/**
 * @param {unknown} name
 * @returns {string|null}
 */
export function normalizeDeviceName(name) {
  /**
   * Назначение:
   *   Нормализовать Common.name для детерминированной типизации (lowercase + trim).
   *
   * Preconditions:
   *   - name может быть любым типом (fail-soft).
   *
   * Postconditions:
   *   - Возвращает строку в нижнем регистре либо null.
   *
   * Инварианты:
   *   - Никаких эвристик: только trim + lower-case.
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. Если name не строка — вернуть null.
   *   2. Иначе trim() + toLowerCase() и вернуть.
   */
  // 1. Только строка допускается как имя.
  if (typeof name !== "string") return null;

  // 2. Нормализация.
  return name.trim().toLowerCase();
}
