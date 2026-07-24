/**
 * MODULE: app/ui/numeric_keypad.ts
 *
 * Назначение:
 *   Экранная цифровая клавиатура (Sprint 2+) для ввода значений в RX/TX/OPU:
 *   - открытие по double click на поле частоты / по иконке клавиатуры,
 *   - режимы: только цифры либо число с десятичной точкой/знаком,
 *   - подтверждение "Ввод" вызывает callback,
 *   - закрытие без подтверждения (backdrop/кнопка "Закрыть").
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT (рис.3 — цифровая клавиатура)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 2 D2-2 (RX Input UX)
 *
 * Инварианты уровня модуля:
 *   - Клавиатура не отправляет WS команды напрямую; только возвращает ввод.
 *   - Не добавляет новых режимов/кнопок сверх необходимого для ввода частоты.
 *
 * Запрещено:
 *   - Любой сетевой код.
 *   - Любые изменения layout окна RX (это overlay поверх UI).
 */

/**
 * @typedef {{
 *   open: (opts: {
 *     title: string,
 *     initialValue: string,
 *     onConfirm: (value: string) => void,
 *     allowDecimal?: boolean,
 *     allowNegative?: boolean,
 *     maxLength?: number
 *   }) => void,
 *   close: () => void,
 *   isOpen: () => boolean
 * }} NumericKeypadApi
 */

/**
 * @param {{ mountPoint: HTMLElement }} deps
 * @returns {NumericKeypadApi}
 */
export function createNumericKeypad(deps) {
  /**
   * Назначение:
   *   Создать overlay клавиатуры и вернуть API управления.
   *
   * Preconditions:
   *   - mountPoint существует (обычно document.body).
   *
   * Postconditions:
   *   - В mountPoint добавлена разметка overlay (скрыта по умолчанию).
   */
  const { mountPoint } = deps;

  /** @type {(value: string) => void | null} */
  let onConfirm = null;

  /** @type {string} */
  let value = "";

  /** @type {boolean} */
  let opened = false;

  /** @type {boolean} */
  let allowDecimal = false;

  /** @type {boolean} */
  let allowNegative = false;

  /** @type {number} */
  let maxLength = 5;

  const root = document.createElement("div");
  root.className = "keypad";
  root.hidden = true;
  root.innerHTML = `
    <div class="keypad__backdrop" data-role="backdrop"></div>
    <div class="keypad__panel" role="dialog" aria-modal="true">
      <div class="keypad__header">
        <div class="keypad__title" data-role="title">Ввод</div>
        <button class="btn btn--ghost btn--sm" data-role="close">Закрыть</button>
      </div>

      <div class="keypad__display" data-role="display"></div>

      <div class="keypad__grid" data-role="grid"></div>

      <div class="keypad__footer">
        <button class="btn" data-role="enter">Ввод</button>
      </div>
    </div>
  `;

  mountPoint.appendChild(root);

  const backdrop = /** @type {HTMLElement} */ (root.querySelector('[data-role="backdrop"]'));
  const titleEl = /** @type {HTMLElement} */ (root.querySelector('[data-role="title"]'));
  const displayEl = /** @type {HTMLElement} */ (root.querySelector('[data-role="display"]'));
  const gridEl = /** @type {HTMLElement} */ (root.querySelector('[data-role="grid"]'));
  renderKeys();
  const btnClose = /** @type {HTMLButtonElement} */ (root.querySelector('[data-role="close"]'));
  const btnEnter = /** @type {HTMLButtonElement} */ (root.querySelector('[data-role="enter"]'));

  function getKeys() {
    const base = [
      "7",
      "8",
      "9",
      "4",
      "5",
      "6",
      "1",
      "2",
      "3",
    ];
    const tail = [];
    if (allowNegative) tail.push("-");
    tail.push(allowDecimal ? "." : "C");
    tail.push("0");
    tail.push("←");
    if (allowDecimal) tail.push("C");
    return [...base, ...tail];
  }

  function renderKeys() {
    gridEl.replaceChildren();
    for (const k of getKeys()) {
      const b = document.createElement("button");
      b.className = "btn keypad__key";
      b.type = "button";
      b.textContent = k;
      b.dataset.key = k;
      gridEl.appendChild(b);
    }
  }

  function isOpen() {
    return opened;
  }

  function render() {
    displayEl.textContent = value || "—";
  }

  function sanitize(next) {
    const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 5;
    const raw = String(next ?? "").replace(/,/g, ".");

    if (!allowDecimal && !allowNegative) {
      const digitsOnly = raw.replace(/\D/g, "");
      return digitsOnly.slice(0, limit);
    }

    let result = "";
    let hasDot = false;
    let hasSign = false;

    for (const ch of raw) {
      if (/^\d$/.test(ch)) {
        if (result.length >= limit) break;
        result += ch;
        continue;
      }

      if (ch === "-" && allowNegative && !hasSign && result.length === 0) {
        if (result.length >= limit) break;
        result = "-";
        hasSign = true;
        continue;
      }

      if (ch === "." && allowDecimal && !hasDot) {
        const prefix = result === "" || result === "-" ? `${result}0` : result;
        if (prefix.length + 1 > limit) break;
        result = `${prefix}.`;
        hasDot = true;
      }
    }

    return result;
  }

  function close() {
    opened = false;
    root.hidden = true;
    onConfirm = null;
    value = "";
  }

  /**
   * @param {{ title: string, initialValue: string, onConfirm: (value: string) => void }} opts
   */
  function open(opts) {
    opened = true;
    root.hidden = false;

    titleEl.textContent = opts.title;
    onConfirm = opts.onConfirm;
    allowDecimal = opts.allowDecimal === true;
    allowNegative = opts.allowNegative === true;
    maxLength = Number.isFinite(opts.maxLength) && opts.maxLength > 0 ? Math.floor(opts.maxLength) : 5;
    renderKeys();
    value = sanitize(opts.initialValue);
    render();
  }

  function enter() {
    if (!onConfirm) {
      close();
      return;
    }
    const v = value;
    const cb = onConfirm;
    close();
    cb(v);
  }

  // Backdrop/close.
  backdrop.addEventListener("click", close);
  btnClose.addEventListener("click", close);

  // Keys.
  gridEl.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    const k = t?.dataset?.key;
    if (!k) return;

    if (k === "C") {
      value = "";
      render();
      return;
    }

    if (k === "←") {
      value = value.slice(0, -1);
      render();
      return;
    }

    // digit
    value = sanitize(value + k);
    render();
  });

  btnEnter.addEventListener("click", enter);

  // Keyboard helpers (deterministic, no extra modes).
  window.addEventListener("keydown", (ev) => {
    if (!opened) return;

    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }

    if (ev.key === "Enter") {
      ev.preventDefault();
      enter();
      return;
    }

    if (ev.key === "Backspace") {
      ev.preventDefault();
      value = value.slice(0, -1);
      render();
      return;
    }

    if (/^\d$/.test(ev.key)) {
      ev.preventDefault();
      value = sanitize(value + ev.key);
      render();
      return;
    }

    if (allowDecimal && (ev.key === "." || ev.key === ",")) {
      ev.preventDefault();
      value = sanitize(`${value}.`);
      render();
      return;
    }

    if (allowNegative && ev.key === "-") {
      ev.preventDefault();
      value = sanitize(`-${value}`);
      render();
    }
  });

  return { open, close, isOpen };
}
