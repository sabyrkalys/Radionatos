/**
 * MODULE: app/core/opu_commands.ts
 *
 * Назначение:
 *   OPU CommandComposer/Dispatcher (Sprint 3):
 *   - формирует CANON команды OPU `set_ugol/set_centr_ugol/set_speed`,
 *   - выполняет только базовую проверку "это число" (SSOT не задаёт диапазоны),
 *   - отправляет команды через ws_transport (1 send = 1 JSON-object).
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §6.5 (OPU команды: set_ugol/set_centr_ugol/set_speed)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 3 D3-12, AC3-16
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §3.2 (Cmd layer)
 *
 * Инварианты уровня модуля:
 *   - Отправка только через WS `ws://<ip>/ws` (ws_transport).
 *   - 1 команда = 1 JSON-object.
 *   - Валидация диапазонов НЕ вводится (только Number.isFinite).
 *
 * Запрещено:
 *   - Любой HTTP/DATA/polling.
 *   - Любые legacy-ключи/форматы.
 *   - Объединять несколько команд в один JSON-object.
 */

/**
 * @param {{
 *   wsTransport: ReturnType<import("../adapters/ws_transport.js").createWsTransport>,
 *   warn: (msg: string) => void
 * }} deps
 * @returns {{
 *   sendSetUgol: (ip: string, value: number) => boolean,
 *   sendSetCentrUgol: (ip: string, value: number) => boolean,
 *   sendSetSpeed: (ip: string, value: number) => boolean,
 *   isValidNumber: (value: unknown) => value is number
 * }}
 */
export function createOpuCommandDispatcher(deps) {
  /**
   * Назначение:
   *   Создать dispatch слой команд OPU.
   *
   * Preconditions:
   *   - deps.wsTransport реализует WS-only send(ip,obj).
   *   - deps.warn показывает предупреждения (fail-soft).
   *
   * Postconditions:
   *   - Возвращает функции отправки OPU команд, каждая отправляет ровно один JSON-object.
   *
   * Инварианты:
   *   - Диапазоны не валидируются (SSOT не задаёт); валидируется только "это число".
   *   - Команда не отправляется при NaN/Infinity.
   *
   * State transitions:
   *   - N/A (side-effect: outbound WS frame)
   *
   * Execution trace:
   *   1. Сохранить wsTransport и warn.
   *   2. Реализовать isValidNumber().
   *   3. Реализовать sendSet* как isValidNumber → wsTransport.send.
   */
  const { wsTransport, warn } = deps;

  /**
   * @param {unknown} value
   * @returns {value is number}
   */
  function isValidNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  /**
   * @param {string} ip
   * @param {number} value
   * @returns {boolean}
   */
  function sendSetUgol(ip, value) {
    /**
     * Назначение:
     *   Отправить OPU команду `set_ugol` одним CANON JSON-object.
     *
     * Preconditions:
     *   - ip соответствует целевому OPU устройству.
     *   - value должен быть конечным числом (`Number.isFinite`).
     *
     * Postconditions:
     *   - При валидном value выполняется ровно один вызов wsTransport.send(ip, { set_ugol: value }).
     *   - При невалидном value команда не отправляется и вызывается warn().
     *
     * Инварианты:
     *   - Никакая диапазонная валидация сверх SSOT не добавляется.
     *   - WS payload shape фиксирован: `{ "set_ugol": N }`.
     *
     * State transitions:
     *   - N/A (side-effect only: outbound WS frame / warning).
     *
     * Execution Trace:
     *   1. Проверить value через isValidNumber().
     *   2. При ошибке вызвать warn() и вернуть false.
     *   3. При успехе отправить `{ set_ugol: value }` через wsTransport.send().
     */
    if (!isValidNumber(value)) {
      warn("Ошибка: ugol должен быть числом.");
      return false;
    }
    return wsTransport.send(ip, { set_ugol: value });
  }

  /**
   * @param {string} ip
   * @param {number} value
   * @returns {boolean}
   */
  function sendSetCentrUgol(ip, value) {
    /**
     * Назначение:
     *   Отправить OPU команду `set_centr_ugol` одним CANON JSON-object.
     *
     * Preconditions:
     *   - ip соответствует целевому OPU устройству.
     *   - value должен быть конечным числом (`Number.isFinite`).
     *
     * Postconditions:
     *   - При валидном value выполняется ровно один вызов wsTransport.send(ip, { set_centr_ugol: value }).
     *   - При невалидном value команда не отправляется и вызывается warn().
     *
     * Инварианты:
     *   - Никакая диапазонная валидация сверх SSOT не добавляется.
     *   - WS payload shape фиксирован: `{ "set_centr_ugol": N }`.
     *
     * State transitions:
     *   - N/A (side-effect only: outbound WS frame / warning).
     *
     * Execution Trace:
     *   1. Проверить value через isValidNumber().
     *   2. При ошибке вызвать warn() и вернуть false.
     *   3. При успехе отправить `{ set_centr_ugol: value }` через wsTransport.send().
     */
    if (!isValidNumber(value)) {
      warn("Ошибка: centr_ugol должен быть числом.");
      return false;
    }
    return wsTransport.send(ip, { set_centr_ugol: value });
  }

  /**
   * @param {string} ip
   * @param {number} value
   * @returns {boolean}
   */
  function sendSetSpeed(ip, value) {
    /**
     * Назначение:
     *   Отправить OPU команду `set_speed` одним CANON JSON-object.
     *
     * Preconditions:
     *   - ip соответствует целевому OPU устройству.
     *   - value должен быть конечным числом (`Number.isFinite`).
     *
     * Postconditions:
     *   - При валидном value выполняется ровно один вызов wsTransport.send(ip, { set_speed: value }).
     *   - При невалидном value команда не отправляется и вызывается warn().
     *
     * Инварианты:
     *   - Никакая диапазонная валидация сверх SSOT не добавляется.
     *   - WS payload shape фиксирован: `{ "set_speed": N }`.
     *
     * State transitions:
     *   - N/A (side-effect only: outbound WS frame / warning).
     *
     * Execution Trace:
     *   1. Проверить value через isValidNumber().
     *   2. При ошибке вызвать warn() и вернуть false.
     *   3. При успехе отправить `{ set_speed: value }` через wsTransport.send().
     */
    if (!isValidNumber(value)) {
      warn("Ошибка: speed должен быть числом.");
      return false;
    }
    return wsTransport.send(ip, { set_speed: value });
  }

  return {
    sendSetUgol,
    sendSetCentrUgol,
    sendSetSpeed,
    isValidNumber,
  };
}
