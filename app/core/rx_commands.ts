/**
 * MODULE: app/core/rx_commands.ts
 *
 * Назначение:
 *   RX CommandComposer/Dispatcher (Sprint 2):
 *   - формирует CANON команды RX (scan/inv/set_frq/set_frq_ignor/set_fon_scan),
 *   - валидирует частоту по SSOT (4/5 digits + frq_range; 0 = пусто),
 *   - отправляет команды через ws_transport (1 send = 1 JSON-object).
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.1–2.4 (WS-only, JSON-only, frame rule)
 *   - ТЗ_vNext.3_Final_SSOT §5 (RX commands)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 2 D2-3..D2-4 (RX Commands + Validation)
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §3.2 (Cmd layer)
 *
 * Инварианты уровня модуля:
 *   - Отправка только через WS `ws://<ip>/ws` (ws_transport).
 *   - 1 команда = 1 JSON-object в одном WS text frame.
 *   - CANON-only: ключи/формы строго из `Примеры JSON.txt`.
 *   - Валидация частоты обязательна для set_frq и для заполнения ignore.
 *
 * Запрещено:
 *   - Любой HTTP/DATA/polling.
 *   - Любая RX→TX интеграция (Scenario/FIFO) — Sprint 3.
 *   - Любые retry/fallback политики при offline.
 */

/**
 * @typedef {{ min: number, max: number }} FrequencyRange
 */

/**
 * @typedef {{
 *   ok: true,
 *   value: number
 * } | {
 *   ok: false,
 *   reason: "empty" | "not_integer" | "digits" | "out_of_range" | "no_range"
 * }} FrequencyValidation
 */

/**
 * @param {{
 *   wsTransport: ReturnType<import("../adapters/ws_transport.js").createWsTransport>,
 *   warn: (msg: string) => void
 * }} deps
 * @returns {{
 *   sendScan: (ip: string) => boolean,
 *   sendInvToggle: (ip: string, currentInv: boolean | undefined) => boolean,
 *   sendSetFrq: (ip: string, frq: number, range: FrequencyRange | null) => boolean,
 *   sendSetFrqIgnor: (ip: string, ignor: number[]) => boolean,
 *   sendSetFonScan: (ip: string, enabled: boolean) => boolean,
 *   validateFrq: (frq: number, range: FrequencyRange | null) => FrequencyValidation
 * }}
 */
export function createRxCommandDispatcher(deps) {
  /**
   * Назначение:
   *   Создать детерминированный dispatch слой RX команд.
   *
   * Preconditions:
   *   - deps.wsTransport реализует WS-only send(ip,obj).
   *   - deps.warn показывает минимальное предупреждение без изменения layout (SprintPlan D2-4).
   *
   * Postconditions:
   *   - Возвращает набор функций отправки RX команд (CANON формы).
   *
   * Инварианты:
   *   - Команды не отправляются, если нарушен контракт валидации (fail-soft + warn).
   *
   * Execution Trace:
   *   1. Обернуть wsTransport.send минимальными проверками формы.
   *   2. Реализовать validateFrq() строго по SSOT.
   *   3. Реализовать send* методы, формируя ровно один JSON-object.
   */
  const { wsTransport, warn } = deps;

  function sendScan(ip) {
    return wsTransport.send(ip, { scan: true });
  }

  function sendInvToggle(ip, currentInv) {
    // SSOT: inv отправляется как true/false (toggle).
    const next = typeof currentInv === "boolean" ? !currentInv : true;
    return wsTransport.send(ip, { inv: next });
  }

  function sendSetFrq(ip, frq, range) {
    const v = validateFrq(frq, range);
    if (!v.ok) {
      warn(buildFrqWarnText(v));
      return false;
    }
    return wsTransport.send(ip, { set_frq: v.value });
  }

  function sendSetFrqIgnor(ip, ignor) {
    // SSOT: массив строго длины 5.
    if (!Array.isArray(ignor) || ignor.length !== 5 || ignor.some((x) => typeof x !== "number")) {
      warn("Ошибка: set_frq_ignor должен быть массивом из 5 чисел.");
      return false;
    }
    return wsTransport.send(ip, { set_frq_ignor: ignor });
  }

  function sendSetFonScan(ip, enabled) {
    // Sprint 2: поддержка команды на уровне dispatcher без добавления UI-триггера.
    return wsTransport.send(ip, { set_fon_scan: !!enabled });
  }

  return {
    sendScan,
    sendInvToggle,
    sendSetFrq,
    sendSetFrqIgnor,
    sendSetFonScan,
    validateFrq,
  };
}

/**
 * Назначение:
 *   Проверить валидность частоты по SSOT (Sprint 2 D2-4).
 *
 * Preconditions:
 *   - frq является числом (получено из UI парсинга или из расчёта по графику).
 *   - range либо {min,max}, либо null (если диапазон ещё не известен).
 *
 * Postconditions:
 *   - ok=true только если:
 *     1) frq — целое,
 *     2) frq != 0,
 *     3) frq имеет 4 или 5 цифр,
 *     4) range != null и frq попадает в [min..max].
 *
 * Инварианты:
 *   - Никаких эвристик/приведения типов: только строгая проверка.
 *
 * @param {number} frq
 * @param {FrequencyRange | null} range
 * @returns {FrequencyValidation}
 */
export function validateFrq(frq, range) {
  // 1) 0 = "пусто" по SSOT.
  if (frq === 0) return { ok: false, reason: "empty" };

  // 2) Только целые.
  if (!Number.isInteger(frq)) return { ok: false, reason: "not_integer" };

  // 3) 4 или 5 цифр.
  const abs = Math.abs(frq);
  const is4 = abs >= 1000 && abs <= 9999;
  const is5 = abs >= 10000 && abs <= 99999;
  if (!is4 && !is5) return { ok: false, reason: "digits" };

  // 4) Диапазон должен быть известен и частота должна попадать в него.
  if (!range) return { ok: false, reason: "no_range" };
  if (frq < range.min || frq > range.max) return { ok: false, reason: "out_of_range" };

  return { ok: true, value: frq };
}

/**
 * @param {FrequencyValidation} v
 * @returns {string}
 */
function buildFrqWarnText(v) {
  if (v.ok) return "";
  switch (v.reason) {
    case "empty":
      return "Ошибка: частота не задана (0/пусто).";
    case "not_integer":
      return "Ошибка: частота должна быть целым числом.";
    case "digits":
      return "Ошибка: частота должна быть 4- или 5-значным числом.";
    case "no_range":
      return "Ошибка: диапазон частот frq_range ещё не получен от устройства.";
    case "out_of_range":
      return "Ошибка: частота вне диапазона frq_range.";
    default:
      return "Ошибка: невалидная частота.";
  }
}
