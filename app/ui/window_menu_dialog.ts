/**
 * MODULE: app/ui/window_menu_dialog.ts
 *
 * Назначение:
 *   DOM-only modal dialog для RX/TX window menus Sprint 4:
 *   - редактирование title / target IP / button labels,
 *   - RX wheel step,
 *   - TX scenario selection,
 *   - delete window action.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §7.1, §7.2
 *   - SPRINT_PLAN_vNext.3.2 Sprint 4 D4-6 / AC4-8..AC4-10
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.9.1, §4.9.2
 *
 * Инварианты уровня модуля:
 *   - OPU menu не реализуется.
 *   - Диалог не изменяет config/runtime сам; он только возвращает validated form values в callbacks.
 *   - Формы RX и TX детерминированно содержат только SSOT-разрешённые поля.
 *
 * Запрещено:
 *   - Добавлять поля OPU menu.
 *   - Прятать delete/retarget logic внутри диалога.
 */

import type { WheelStepMultiplier } from "../contracts/config.js";

export type RxMenuValues = {
  title: string;
  targetIp: string;
  wheelStepMultiplier: WheelStepMultiplier;
  buttonLabels: {
    scan: string;
    inv: string;
    send: string;
    ignore: string;
    clear: string;
  };
};

export type TxMenuValues = {
  title: string;
  targetIp: string;
  scenario: 1 | 2;
  buttonLabels: {
    off: string;
    scenario: string;
    clear: string;
  };
};

export type WindowMenuDialog = {
  openRx: (opts: {
    values: RxMenuValues;
    onSave: (values: RxMenuValues) => boolean | void;
    onDelete: () => boolean | void;
  }) => void;
  openTx: (opts: {
    values: TxMenuValues;
    scenarioEnabled: boolean;
    onSave: (values: TxMenuValues) => boolean | void;
    onDelete: () => boolean | void;
  }) => void;
  close: () => void;
};

/**
 * Назначение:
 *   Создать единый переиспользуемый modal dialog для RX/TX window menus.
 *
 * Preconditions:
 *   - `mountPoint` существует в DOM (обычно `document.body`).
 *
 * Postconditions:
 *   - Возвращает API `openRx/openTx/close`.
 *
 * Инварианты:
 *   - Одновременно открыт не более один window-menu dialog.
 *   - Диалог закрывается через backdrop / close button / успешный save / delete.
 *
 * State transitions:
 *   - DOM hidden=true/false для backdrop/modal.
 *   - Inner form content пересобирается при каждом `openRx/openTx`.
 *
 * Execution Trace:
 *   1. Создать базовый backdrop+modal shell.
 *   2. Реализовать helper для наполнения RX формы.
 *   3. Реализовать helper для наполнения TX формы.
 *   4. На save вернуть form values в переданный callback.
 */
export function createWindowMenuDialog(deps: { mountPoint: HTMLElement }): WindowMenuDialog {
  const { mountPoint } = deps;

  const root = document.createElement("div");
  root.className = "window-menu-root";
  root.innerHTML = `
    <div class="modal-backdrop" data-role="backdrop" hidden></div>
    <div class="modal modal--wide" data-role="modal" hidden>
      <div class="modal__header">
        <div class="modal__title" data-role="title">Меню окна</div>
        <button class="btn btn--ghost" data-role="close">Закрыть</button>
      </div>
      <div class="modal__body" data-role="body"></div>
      <div class="modal__footer">
        <button class="btn btn--secondary" data-role="delete">Удалить окно</button>
        <button class="btn" data-role="save">Сохранить</button>
      </div>
    </div>
  `;
  mountPoint.appendChild(root);

  const backdrop = root.querySelector<HTMLElement>('[data-role="backdrop"]');
  const modal = root.querySelector<HTMLElement>('[data-role="modal"]');
  const titleEl = root.querySelector<HTMLElement>('[data-role="title"]');
  const bodyEl = root.querySelector<HTMLElement>('[data-role="body"]');
  const btnClose = root.querySelector<HTMLButtonElement>('[data-role="close"]');
  const btnDelete = root.querySelector<HTMLButtonElement>('[data-role="delete"]');
  const btnSave = root.querySelector<HTMLButtonElement>('[data-role="save"]');

  let onDelete: (() => void) | null = null;
  let onSave: (() => void) | null = null;

  function close(): void {
    if (backdrop) backdrop.hidden = true;
    if (modal) modal.hidden = true;
    if (bodyEl) bodyEl.innerHTML = "";
    onDelete = null;
    onSave = null;
  }

  function openRx(opts: {
    values: RxMenuValues;
    onSave: (values: RxMenuValues) => boolean | void;
    onDelete: () => boolean | void;
  }): void {
    if (!bodyEl || !titleEl) return;
    titleEl.textContent = "RX меню";
    bodyEl.innerHTML = renderRxForm(opts.values);
    onDelete = () => {
      const result = opts.onDelete();
      if (result !== false) close();
    };
    onSave = () => {
      const values = readRxForm(bodyEl);
      const result = opts.onSave(values);
      if (result !== false) close();
    };
    if (backdrop) backdrop.hidden = false;
    if (modal) modal.hidden = false;
  }

  function openTx(opts: {
    values: TxMenuValues;
    scenarioEnabled: boolean;
    onSave: (values: TxMenuValues) => boolean | void;
    onDelete: () => boolean | void;
  }): void {
    if (!bodyEl || !titleEl) return;
    titleEl.textContent = "TX меню";
    bodyEl.innerHTML = renderTxForm(opts.values, opts.scenarioEnabled);
    onDelete = () => {
      const result = opts.onDelete();
      if (result !== false) close();
    };
    onSave = () => {
      const values = readTxForm(bodyEl, opts.values.scenario);
      const result = opts.onSave(values);
      if (result !== false) close();
    };
    if (backdrop) backdrop.hidden = false;
    if (modal) modal.hidden = false;
  }

  backdrop?.addEventListener("click", close);
  btnClose?.addEventListener("click", close);
  btnDelete?.addEventListener("click", () => onDelete?.());
  btnSave?.addEventListener("click", () => onSave?.());

  return {
    openRx,
    openTx,
    close,
  };
}

function renderRxForm(values: RxMenuValues): string {
  return `
    <div class="form-grid form-grid--stacked">
      <div class="form-row"><div class="form-label">Имя окна</div><div class="form-controls"><input class="input input--wide" data-role="title" value="${escapeHtmlAttr(values.title)}" /></div></div>
      <div class="form-row"><div class="form-label">IP</div><div class="form-controls"><input class="input input--wide" data-role="target-ip" value="${escapeHtmlAttr(values.targetIp)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Scan</div><div class="form-controls"><input class="input input--wide" data-role="label-scan" value="${escapeHtmlAttr(values.buttonLabels.scan)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Inv</div><div class="form-controls"><input class="input input--wide" data-role="label-inv" value="${escapeHtmlAttr(values.buttonLabels.inv)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Send</div><div class="form-controls"><input class="input input--wide" data-role="label-send" value="${escapeHtmlAttr(values.buttonLabels.send)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Ignore</div><div class="form-controls"><input class="input input--wide" data-role="label-ignore" value="${escapeHtmlAttr(values.buttonLabels.ignore)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Clear</div><div class="form-controls"><input class="input input--wide" data-role="label-clear" value="${escapeHtmlAttr(values.buttonLabels.clear)}" /></div></div>
      <div class="form-row"><div class="form-label">Шаг колеса, МГц</div><div class="form-controls">
        <select class="input input--wide" data-role="wheel-step">
          ${renderWheelOption(values.wheelStepMultiplier, "x1")}
          ${renderWheelOption(values.wheelStepMultiplier, "x2")}
          ${renderWheelOption(values.wheelStepMultiplier, "x5")}
          ${renderWheelOption(values.wheelStepMultiplier, "x10")}
        </select>
      </div></div>
    </div>
  `;
}

function renderTxForm(values: TxMenuValues, scenarioEnabled: boolean): string {
  return `
    <div class="form-grid form-grid--stacked">
      <div class="form-row"><div class="form-label">Имя окна</div><div class="form-controls"><input class="input input--wide" data-role="title" value="${escapeHtmlAttr(values.title)}" /></div></div>
      <div class="form-row"><div class="form-label">IP</div><div class="form-controls"><input class="input input--wide" data-role="target-ip" value="${escapeHtmlAttr(values.targetIp)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Off</div><div class="form-controls"><input class="input input--wide" data-role="label-off" value="${escapeHtmlAttr(values.buttonLabels.off)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Scenario</div><div class="form-controls"><input class="input input--wide" data-role="label-scenario" value="${escapeHtmlAttr(values.buttonLabels.scenario)}" /></div></div>
      <div class="form-row"><div class="form-label">Кнопка Clear</div><div class="form-controls"><input class="input input--wide" data-role="label-clear" value="${escapeHtmlAttr(values.buttonLabels.clear)}" /></div></div>
      <div class="form-row"><div class="form-label">Сценарий</div><div class="form-controls">
        <select class="input input--wide" data-role="scenario" ${scenarioEnabled ? "" : "disabled"}>
          <option value="1" ${values.scenario === 1 ? "selected" : ""}>Сценарий 1</option>
          <option value="2" ${values.scenario === 2 ? "selected" : ""}>Сценарий 2</option>
        </select>
      </div></div>
    </div>
  `;
}

function renderWheelOption(current: WheelStepMultiplier, value: WheelStepMultiplier): string {
  return `<option value="${value}" ${current === value ? "selected" : ""}>${getWheelStepLabel(value)}</option>`;
}

function getWheelStepLabel(value: WheelStepMultiplier): string {
  switch (value) {
    case "x2":
      return "x2 (2 МГц)";
    case "x5":
      return "x5 (5 МГц)";
    case "x10":
      return "x10 (10 МГц)";
    case "x1":
    default:
      return "x1 (1 МГц)";
  }
}

function readRxForm(root: HTMLElement): RxMenuValues {
  return {
    title: readInputValue(root, "title"),
    targetIp: readInputValue(root, "target-ip"),
    wheelStepMultiplier: readSelectValue(root, "wheel-step") as WheelStepMultiplier,
    buttonLabels: {
      scan: readInputValue(root, "label-scan"),
      inv: readInputValue(root, "label-inv"),
      send: readInputValue(root, "label-send"),
      ignore: readInputValue(root, "label-ignore"),
      clear: readInputValue(root, "label-clear"),
    },
  };
}

function readTxForm(root: HTMLElement, fallbackScenario: 1 | 2): TxMenuValues {
  const scenarioRaw = readSelectValue(root, "scenario");
  return {
    title: readInputValue(root, "title"),
    targetIp: readInputValue(root, "target-ip"),
    scenario: scenarioRaw === "2" ? 2 : scenarioRaw === "1" ? 1 : fallbackScenario,
    buttonLabels: {
      off: readInputValue(root, "label-off"),
      scenario: readInputValue(root, "label-scenario"),
      clear: readInputValue(root, "label-clear"),
    },
  };
}

function readInputValue(root: HTMLElement, role: string): string {
  return root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)?.value.trim() ?? "";
}

function readSelectValue(root: HTMLElement, role: string): string {
  return root.querySelector<HTMLSelectElement>(`[data-role="${role}"]`)?.value ?? "";
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
