/**
 * MODULE: app/core/tx_commands.ts
 *
 * Назначение:
 *   TX CommandComposer/Dispatcher (Sprint 3):
 *   - формирует CANON команды TX `{ "frq_tx_in": [...] }`,
 *   - валидирует слоты массива `frq_tx_in[]` по SSOT (0 или валидная частота 4/5 digits в `frq_range`),
 *   - отправляет команды через ws_transport (1 send = 1 JSON-object).
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §6.3 (TX команды: frq_tx_in[]; длина=tx_ch; "Выкл"; X→0)
 *   - ТЗ_vNext.3_Final_SSOT §9 (валидация частоты: 4/5 digits + frq_range; 0=empty)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 3 D3-4..D3-5, AC3-3..AC3-6
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §3.2 (Cmd layer)
 *
 * Инварианты уровня модуля:
 *   - Отправка только через WS `ws://<ip>/ws` (ws_transport).
 *   - 1 команда = 1 JSON-object (1 WS text frame).
 *   - CANON-only: ключ `frq_tx_in` и форма массива из `Примеры JSON.txt`.
 *   - `frq_tx_in.length` MUST равняться `tx_ch` целевого TX (и `tx_ch <= 3`).
 *
 * Запрещено:
 *   - Любой HTTP/DATA/polling.
 *   - Любые legacy-ключи/форматы.
 *   - Любые retry/reroute/fallback политики при offline.
 */

/**
 * @typedef {{ min: number, max: number }} FrequencyRange
 */

/**
 * @typedef {{
 *   ok: true
 * } | {
 *   ok: false,
 *   reason:
 *     | "not_array"
 *     | "length_mismatch"
 *     | "tx_ch_invalid"
 *     | "slot_not_number"
 *     | "slot_not_integer"
 *     | "slot_digits"
 *     | "slot_out_of_range"
 *     | "no_range"
 * }} TxArrayValidation
 *
 * @typedef {{
 *   ok: true,
 *   arr: number[]
 * } | {
 *   ok: false,
 *   reason:
 *     | "not_array"
 *     | "length_mismatch"
 *     | "tx_ch_invalid"
 *     | "slot_not_number"
 *     | "slot_not_integer"
 *     | "slot_digits"
 *     | "slot_out_of_range"
 *     | "no_range"
 *     | "slot_mixed_values"
 * }} TxDispatchShape
 */

/**
 * @param {{
 *   wsTransport: ReturnType<import("../adapters/ws_transport.js").createWsTransport>,
 *   warn: (msg: string) => void
 * }} deps
 * @returns {{
 *   sendFrqTxIn: (ip: string, frqTxIn: number[], txCh: number, range: FrequencyRange | null) => boolean,
 *   shapeFrqTxIn: (frqTxIn: number[], txCh: number, range: FrequencyRange | null) => TxDispatchShape,
 *   validateFrqTxIn: (frqTxIn: number[], txCh: number, range: FrequencyRange | null) => TxArrayValidation,
 *   validateTxCh: (txCh: unknown) => number | null
 * }}
 */
export function createTxCommandDispatcher(deps) {
  /**
   * Назначение:
   *   Создать детерминированный dispatch слой TX команд.
   *
   * Preconditions:
   *   - deps.wsTransport реализует WS-only send(ip,obj).
   *   - deps.warn показывает предупреждения без изменения layout.
   *
   * Postconditions:
   *   - Возвращает API для отправки `frq_tx_in[]` и для валидации tx_ch/массива.
   *
   * Инварианты:
   *   - Команда TX всегда отправляется одним JSON-object вида `{ frq_tx_in: number[] }`.
   *   - При нарушении валидации команда не отправляется (fail-soft + warn).
   *
   * State transitions:
   *   - N/A (side-effect: outbound WS frame)
   *
   * Execution trace:
   *   1. Сохранить wsTransport и warn.
   *   2. Реализовать validateTxCh(tx_ch) по SSOT (<=3).
   *   3. Реализовать validateFrqTxIn(frqTxIn,txCh,range).
   *   4. Реализовать sendFrqTxIn() как validate → wsTransport.send.
   */
  const { wsTransport, warn } = deps;

  /**
   * @param {unknown} txCh
   * @returns {number|null}
   */
  function validateTxCh(txCh) {
    // SSOT: tx_ch <= 3; tx_ch определяет количество активных слотов.
    if (typeof txCh !== "number") return null;
    if (!Number.isInteger(txCh)) return null;
    if (txCh < 1 || txCh > 3) return null;
    return txCh;
  }

  /**
   * @param {number[]} frqTxIn
   * @param {number} txCh
   * @param {FrequencyRange|null} range
   * @returns {TxArrayValidation}
   */
  function validateFrqTxIn(frqTxIn, txCh, range) {
    // 1) tx_ch валиден и в пределах SSOT.
    if (validateTxCh(txCh) === null) return { ok: false, reason: "tx_ch_invalid" };

    // 2) Массив.
    if (!Array.isArray(frqTxIn)) return { ok: false, reason: "not_array" };

    // 3) Длина строго равна tx_ch.
    if (frqTxIn.length !== txCh) return { ok: false, reason: "length_mismatch" };

    // 4) Диапазон обязателен для не-нулевых значений.
    if (!range) {
      // Допускаем только массив из нулей (иначе не можем проверить попадание в frq_range).
      const allZero = frqTxIn.every((x) => x === 0);
      if (allZero) return { ok: true };
      return { ok: false, reason: "no_range" };
    }

    // 5) Проверка каждого слота.
    for (const x of frqTxIn) {
      if (typeof x !== "number") return { ok: false, reason: "slot_not_number" };
      if (x === 0) continue; // SSOT: 0 = empty.

      if (!Number.isInteger(x)) return { ok: false, reason: "slot_not_integer" };

      const abs = Math.abs(x);
      const is4 = abs >= 1000 && abs <= 9999;
      const is5 = abs >= 10000 && abs <= 99999;
      if (!is4 && !is5) return { ok: false, reason: "slot_digits" };

      if (x < range.min || x > range.max) return { ok: false, reason: "slot_out_of_range" };
    }

    return { ok: true };
  }


  /**
   * @param {number[]} frqTxIn
   * @param {number} txCh
   * @param {FrequencyRange|null} range
   * @returns {TxDispatchShape}
   */
  function shapeFrqTxIn(frqTxIn, txCh, range) {
    const baseValidation = validateFrqTxIn(frqTxIn, txCh, range);
    if (!baseValidation.ok) return baseValidation;

    // Interop profile текущей TX-платы: 3 связанных генератора, но каждый слот
    // может хранить свою частоту. Нули внутри массива запрещены железом, поэтому
    // любой logical gap заполняем опорным значением из уже существующих частот.
    //
    // Примеры:
    //   [5452,0,0]   -> [5452,5452,5452]
    //   [5452,5600,0] -> [5452,5600,5452]
    //   [0,5600,5800] -> [5600,5600,5800]
    if (txCh !== 3) {
      return { ok: true, arr: frqTxIn.slice() };
    }

    const nonZeroValues = frqTxIn.filter((x) => x !== 0);
    if (nonZeroValues.length === 0) {
      return { ok: true, arr: new Array(txCh).fill(0) };
    }

    const fillValue = nonZeroValues[0];
    const shaped = frqTxIn.map((x) => (x === 0 ? fillValue : x));
    const shapedValidation = validateFrqTxIn(shaped, txCh, range);
    if (!shapedValidation.ok) return shapedValidation;

    return { ok: true, arr: shaped };
  }

  /**
   * @param {TxArrayValidation} v
   * @returns {string}
   */
  function buildWarnText(v) {
    if (v.ok) return "";
    switch (v.reason) {
      case "tx_ch_invalid":
        return "Ошибка: tx_ch невалиден (ожидается целое 1..3).";
      case "not_array":
        return "Ошибка: frq_tx_in должен быть массивом.";
      case "length_mismatch":
        return "Ошибка: длина frq_tx_in должна строго равняться tx_ch.";
      case "no_range":
        return "Ошибка: диапазон frq_range ещё не получен от TX (нельзя отправить ненулевую частоту).";
      case "slot_not_number":
        return "Ошибка: каждый слот frq_tx_in должен быть числом.";
      case "slot_not_integer":
        return "Ошибка: частота должна быть целым числом.";
      case "slot_digits":
        return "Ошибка: частота должна быть 4- или 5-значным числом (или 0).";
      case "slot_out_of_range":
        return "Ошибка: частота вне диапазона frq_range целевого TX.";
      case "slot_mixed_values":
        return "Ошибка: для текущей TX-платы требуется одинаковая частота во всех 3 каналах.";
      default:
        return "Ошибка: невалидный массив frq_tx_in.";
    }
  }

  /**
   * @param {string} ip
   * @param {number[]} frqTxIn
   * @param {number} txCh
   * @param {FrequencyRange|null} range
   * @returns {boolean}
   */
  function sendFrqTxIn(ip, frqTxIn, txCh, range) {
    const shaped = shapeFrqTxIn(frqTxIn, txCh, range);
    if (!("arr" in shaped)) {
      warn(buildWarnText(shaped));
      return false;
    }

    // SSOT: 1 WS frame = 1 JSON-object.
    const sent = wsTransport.send(ip, { frq_tx_in: shaped.arr });
    if (!sent) {
      warn("Ошибка: команда TX не отправлена — WebSocket закрыт или недоступен.");
      return false;
    }
    return true;
  }

  return {
    sendFrqTxIn,
    shapeFrqTxIn,
    validateFrqTxIn,
    validateTxCh,
  };
}
