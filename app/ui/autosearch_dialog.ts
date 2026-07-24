/**
 * MODULE: app/ui/autosearch_dialog.ts
 *
 * Назначение:
 *   UI-диалог "Автопоиск" Sprint 4:
 *   - редактируемые RX/TX ranges,
 *   - флаг `Новая конфигурация`,
 *   - рабочие export/import JSON,
 *   - запуск scan callback без собственной бизнес-логики discovery.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §4.2, §4.3, §4.5, §4.9
 *   - SPRINT_PLAN_vNext.3.2 D1-2, D4-1, D4-2 / AC4-3, AC4-4, AC4-11
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §4.8
 *
 * Инварианты уровня модуля:
 *   - Диалог только собирает ввод и делегирует scan/export/import наружу.
 *   - Import не мутирует config сам по себе: он только передаёт выбранный файл callback-слою.
 *   - Дефолтные/текущие ranges берутся из config store при открытии.
 *
 * Запрещено:
 *   - Встраивать сюда discovery/business-logic, WS вызовы или hidden migrations.
 */

import { isValidIpString, type AppConfig } from "../contracts/config.js";

export type AutosearchDialogApi = {
  open: () => void;
  close: () => void;
  setBusy: (busy: boolean) => void;
  getValues: () => { ranges: AppConfig["ipRanges"]; newConfig: boolean };
};

/**
 * Назначение:
 *   Смонтировать автопоисковый диалог и вернуть imperative API открытия/закрытия.
 *
 * Preconditions:
 *   - `mountPoint` существует в DOM.
 *   - Коллбеки scan/export/import предоставлены higher-level runtime.
 *
 * Postconditions:
 *   - Разметка диалога создана, кнопки привязаны, import/export работают.
 *
 * Инварианты:
 *   - IP ranges валидируются строго перед вызовом `onScan`.
 *   - Invalid import warning показывается наружу через callback-result.
 *
 * State transitions:
 *   - DOM hidden=true/false для backdrop/modal.
 *   - hidden file input используется только на import action.
 *
 * Execution Trace:
 *   1. Создать DOM диалога и скрытый file input.
 *   2. Связать open() с подстановкой текущих ranges из config.
 *   3. Связать кнопки scan/export/import с callback-слоем.
 */
export function mountAutosearchDialog(deps: {
  mountPoint: HTMLElement;
  getCurrentRanges: () => AppConfig["ipRanges"];
  onScan: (ranges: AppConfig["ipRanges"], newConfig: boolean) => Promise<void> | void;
  onExportConfig: () => void;
  onImportConfig: (file: File) => Promise<{ ok: true } | { ok: false; warning: string }>;
}): AutosearchDialogApi {
  const { mountPoint, getCurrentRanges, onScan, onExportConfig, onImportConfig } = deps;

  mountPoint.innerHTML = `
    <div class="modal-backdrop" data-role="backdrop" hidden></div>
    <div class="modal" data-role="modal" hidden>
      <div class="modal__header">
        <div class="modal__title">Автопоиск</div>
        <button class="btn btn--ghost" data-role="close">Закрыть</button>
      </div>

      <div class="modal__body">
        <div class="form-grid">
          <div class="form-row">
            <div class="form-label">RX диапазон</div>
            <div class="form-controls">
              <input class="input" data-role="rx-start" inputmode="numeric" />
              <span class="form-sep">—</span>
              <input class="input" data-role="rx-end" inputmode="numeric" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">TX диапазон</div>
            <div class="form-controls">
              <input class="input" data-role="tx-start" inputmode="numeric" />
              <span class="form-sep">—</span>
              <input class="input" data-role="tx-end" inputmode="numeric" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">Новая конфигурация</div>
            <div class="form-controls">
              <label class="checkbox">
                <input type="checkbox" data-role="new-config" />
                <span>Удалить текущие окна перед поиском</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="modal__footer">
        <button class="btn" data-role="scan">Поиск</button>
        <button class="btn btn--secondary" data-role="export">Экспорт конфигурации</button>
        <button class="btn btn--secondary" data-role="import">Импорт конфигурации</button>
      </div>
    </div>
  `;

  const backdrop = mountPoint.querySelector<HTMLElement>('[data-role="backdrop"]');
  const modal = mountPoint.querySelector<HTMLElement>('[data-role="modal"]');
  const rxStart = mountPoint.querySelector<HTMLInputElement>('[data-role="rx-start"]');
  const rxEnd = mountPoint.querySelector<HTMLInputElement>('[data-role="rx-end"]');
  const txStart = mountPoint.querySelector<HTMLInputElement>('[data-role="tx-start"]');
  const txEnd = mountPoint.querySelector<HTMLInputElement>('[data-role="tx-end"]');
  const newConfigEl = mountPoint.querySelector<HTMLInputElement>('[data-role="new-config"]');
  const btnClose = mountPoint.querySelector<HTMLButtonElement>('[data-role="close"]');
  const btnScan = mountPoint.querySelector<HTMLButtonElement>('[data-role="scan"]');
  const btnExport = mountPoint.querySelector<HTMLButtonElement>('[data-role="export"]');
  const btnImport = mountPoint.querySelector<HTMLButtonElement>('[data-role="import"]');

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;
  mountPoint.appendChild(fileInput);

  let busy = false;

  function setBusy(nextBusy: boolean): void {
    busy = nextBusy;

    if (rxStart) rxStart.disabled = nextBusy;
    if (rxEnd) rxEnd.disabled = nextBusy;
    if (txStart) txStart.disabled = nextBusy;
    if (txEnd) txEnd.disabled = nextBusy;
    if (newConfigEl) newConfigEl.disabled = nextBusy;
    if (btnClose) btnClose.disabled = nextBusy;
    if (btnExport) btnExport.disabled = nextBusy;
    if (btnImport) btnImport.disabled = nextBusy;
    if (btnScan) {
      btnScan.disabled = nextBusy;
      btnScan.textContent = nextBusy ? "Поиск..." : "Поиск";
    }
  }

  function syncInputsFromConfig(): void {
    const ranges = getCurrentRanges();
    if (rxStart) rxStart.value = ranges.rx.start;
    if (rxEnd) rxEnd.value = ranges.rx.end;
    if (txStart) txStart.value = ranges.tx.start;
    if (txEnd) txEnd.value = ranges.tx.end;
    if (newConfigEl) newConfigEl.checked = false;
  }

  function open(): void {
    syncInputsFromConfig();
    if (backdrop) backdrop.hidden = false;
    if (modal) modal.hidden = false;
  }

  function close(): void {
    if (backdrop) backdrop.hidden = true;
    if (modal) modal.hidden = true;
    fileInput.value = "";
  }

  function getValues(): { ranges: AppConfig["ipRanges"]; newConfig: boolean } {
    return {
      ranges: {
        rx: { start: rxStart?.value.trim() ?? "", end: rxEnd?.value.trim() ?? "" },
        tx: { start: txStart?.value.trim() ?? "", end: txEnd?.value.trim() ?? "" },
      },
      newConfig: !!newConfigEl?.checked,
    };
  }

  backdrop?.addEventListener("click", close);
  btnClose?.addEventListener("click", close);
  btnExport?.addEventListener("click", () => onExportConfig());
  btnImport?.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    if (busy) return;

    const file = fileInput.files?.[0] ?? null;
    if (!file) return;

    setBusy(true);
    try {
      const result = await onImportConfig(file);
      if (!result.ok) {
        const warning = (result as { ok: false; warning: string }).warning;
        window.alert(warning);
        fileInput.value = "";
        return;
      }
      close();
    } finally {
      setBusy(false);
    }
  });

  btnScan?.addEventListener("click", async () => {
    if (busy) return;

    const { ranges, newConfig } = getValues();
    const valid =
      isValidIpString(ranges.rx.start) &&
      isValidIpString(ranges.rx.end) &&
      isValidIpString(ranges.tx.start) &&
      isValidIpString(ranges.tx.end);

    if (!valid) {
      window.alert("Ошибка: один или несколько IP-адресов введены неверно.");
      return;
    }

    setBusy(true);
    close();
    try {
      await onScan(ranges, newConfig);
    } finally {
      setBusy(false);
    }
  });

  setBusy(false);

  return {
    open,
    close,
    setBusy,
    getValues,
  };
}
