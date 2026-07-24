/**
 * MODULE: app/core/typing.ts
 *
 * Назначение:
 *   Детерминированная типизация устройства RX/TX/OPU по алгоритму SSOT:
 *   A) Common.name → B) keysets → unknown(close).
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §4.3 (A→B→unknown)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1 AC1-6 (детали keysets и неоднозначность)
*   - ARCHITECTURE_BASELINE_vNext.3.2.md §2.3 + §4.1
 *
 * Инварианты уровня модуля:
 *   - Типизация выполняется строго по порядку A→B.
 *   - Common считается Common только при полном наборе ключей.
 *   - Если state удовлетворяет условиям более чем одного типа → unknown.
 *   - unknown НЕ допускает fallback эвристик: требуется закрыть WS и не создавать окно.
 *
 * Запрещено:
 *   - "Угадывать" тип по частичным совпадениям вне SSOT keysets.
 *   - Менять тип устройства после первичной фиксации (в рамках slice).
 */

import { CANON, isCommonObject, normalizeDeviceName } from "../contracts/canon.js";

/**
 * @typedef {"rx"|"tx"|"opu"|"unknown"} DeviceTypeOrUnknown
 */

/**
 * @param {Record<string, any>} obj
 * @returns {{ type: DeviceTypeOrUnknown, reason: string }}
 */
export function determineDeviceType(obj) {
  /**
   * Назначение:
   *   Определить тип устройства по первому валидному JSON-object (discovery gate уже пройден).
   *
   * Preconditions:
   *   - obj является валидным CANON JSON-object (не legacy).
   *
   * Postconditions:
   *   - Возвращает {type,reason}; type ∈ {rx,tx,opu,unknown}.
   *
   * Инварианты:
   *   - Приоритет A: Common.name (только если obj = Common по полному набору ключей).
   *   - Приоритет B: keysets по state (≥2 ключа) / required keys (OPU).
   *   - Неоднозначность => unknown.
   *
   * State transitions:
   *   N/A (чистая функция)
   *
   * Execution Trace:
   *   1. Если obj = Common → нормализовать name → маппинг rx/tx/opu или unknown.
   *   2. Иначе посчитать совпадения keysets RX/TX и required keys OPU.
   *   3. Если совпало 0 или >1 типов → unknown.
   *   4. Если совпал ровно 1 тип → вернуть его.
   */
  // 1. A) Common.name
  if (isCommonObject(obj)) {
    const norm = normalizeDeviceName(obj.name);
    if (norm === "rx") return { type: "rx", reason: "A:common.name=rx" };
    if (norm === "tx") return { type: "tx", reason: "A:common.name=tx" };
    if (norm === "opu") return { type: "opu", reason: "A:common.name=opu" };
    return { type: "unknown", reason: "A:common.name_unknown" };
  }

  // 2. B) keysets
  const keys = Object.keys(obj);

  const rxHits = countKeyHits(keys, CANON.TYPING_KEYS.RX_ANY2);
  const txHits = countKeyHits(keys, CANON.TYPING_KEYS.TX_ANY2);

  const opuHasAll = hasAllKeys(keys, CANON.TYPING_KEYS.OPU_REQUIRED);

  /** @type {("rx"|"tx"|"opu")[]} */
  const matches = [];
  if (rxHits >= 2) matches.push("rx");
  if (txHits >= 2) matches.push("tx");
  if (opuHasAll) matches.push("opu");

  // 3. Неоднозначность или отсутствие совпадения.
  if (matches.length !== 1) {
    const reason =
      matches.length === 0 ? "B:no_match" : `B:ambiguous(${matches.join("|")})`;
    return { type: "unknown", reason };
  }

  // 4. Ровно один тип.
  return { type: /** @type {DeviceTypeOrUnknown} */ (matches[0]), reason: "B:keysets" };
}

/**
 * @param {string[]} actualKeys
 * @param {string[]} expectedAny
 * @returns {number}
 */
function countKeyHits(actualKeys, expectedAny) {
  const set = new Set(actualKeys);
  let hits = 0;
  for (const k of expectedAny) {
    if (set.has(k)) hits++;
  }
  return hits;
}

/**
 * @param {string[]} actualKeys
 * @param {string[]} required
 * @returns {boolean}
 */
function hasAllKeys(actualKeys, required) {
  const set = new Set(actualKeys);
  for (const k of required) {
    if (!set.has(k)) return false;
  }
  return true;
}
