/**
 * MODULE: app/adapters/ws_transport.ts
 *
 * Назначение:
 *   Единственный транспорт взаимодействия с устройствами vNext.3:
 *   прямые WebSocket подключения `ws://<ip>/ws`, приём WS text frames и отправка JSON-объектов.
 *
 * SSOT Reference:
 *   - ТЗ_vNext.3_Final_SSOT §2.1–2.4 (WS-only, ws://<ip>/ws, JSON-only)
 *   - ТЗ_vNext.3_Final_SSOT §2.2 (Discovery gate: WS open + ≥1 валидный JSON-object)
 *   - SPRINT_PLAN_vNext.3.2 Sprint 1 AC1-3..AC1-5 (frame rule + fail-soft)
 *   - ARCHITECTURE_BASELINE_vNext.3.2.md §2.1 + §4.2
 *
 * Инварианты уровня модуля:
 *   - ТОЛЬКО WS: никаких HTTP/DATA/polling.
 *   - 1 WS text frame интерпретируется как 1 JSON value.
 *   - Валидным входом считается только JSON-ОБЪЕКТ (не массив/строка/число/null), и только CANON.
 *   - Ошибки парсинга/соединения не должны приводить к падению приложения (fail-soft).
 *   - На один IP не более одного активного WS соединения (connecting/open).
 *
 * Запрещено:
 *   - Вводить альтернативные транспорты или fallback на HTTP.
 *   - Склеивать несколько JSON-объектов из одного frame или делить frame на части.
 *   - Отправлять не-объекты (array/null) как команды.
 */

import { isPlainObject, parseWsTextFrame } from "../contracts/canon.js";

export type WsHandlers = {
  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
  onValidObject?: (obj: Record<string, any>) => void;
  onInvalidFrame?: (info: { reason: string }) => void;
};

export type WsConnectionHandle = {
  ip: string;
  url: string;
  sendObject: (obj: Record<string, any>) => boolean;
  close: () => void;
  getReadyState: () => number;
};

type CloseWaiter = {
  ip: string;
  promise: Promise<void>;
  resolve: () => void;
  timeoutId: number | null;
};

const DEFAULT_CLOSE_SETTLE_TIMEOUT_MS = 800;

/**
 * Назначение:
 *   Фабрика транспорта с внутренним реестром активных WS соединений.
 *
 * Preconditions:
 *   - Выполняется в браузере с доступным WebSocket API.
 *
 * Postconditions:
 *   - Возвращает API для connect/send/close в рамках инвариантов vNext.3.
 *
 * Инварианты:
 *   - Внутри хранится не более одного активного сокета на IP.
 *   - Drain helpers ждут фактического settle `onclose` либо bounded timeout.
 */
export function createWsTransport(): {
  connect: (ip: string, handlers: WsHandlers) => WsConnectionHandle;
  send: (ip: string, obj: Record<string, any>) => boolean;
  close: (ip: string) => void;
  closeAndWait: (ip: string, timeoutMs: number) => Promise<void>;
  closeAll: () => void;
  closeAllAndWait: (timeoutMs: number) => Promise<void>;
  isOpen: (ip: string) => boolean;
} {
  const sockets = new Map<string, WebSocket>();
  const closeWaiters = new Map<WebSocket, CloseWaiter>();
  const closingByIp = new Map<string, Promise<void>>();

  function connect(ip: string, handlers: WsHandlers): WsConnectionHandle {
    const existing = sockets.get(ip);
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
      return makeHandle(ip, existing);
    }

    const url = `ws://${ip}/ws`;
    const ws = new WebSocket(url);
    sockets.set(ip, ws);

    ws.onopen = () => {
      handlers.onOpen?.();
    };

    ws.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : null;
      if (text === null) {
        handlers.onInvalidFrame?.({ reason: "not_text_frame" });
        return;
      }

      const parsed = parseWsTextFrame(text);
      if (parsed.kind === "valid") {
        handlers.onValidObject?.(parsed.obj);
        return;
      }

      handlers.onInvalidFrame?.({ reason: parsed.reason });
    };

    ws.onerror = (ev) => {
      handlers.onError?.(ev);
    };

    ws.onclose = (ev) => {
      if (sockets.get(ip) === ws) {
        sockets.delete(ip);
      }
      settleCloseWait(ws);
      handlers.onClose?.(ev);
    };

    return makeHandle(ip, ws);
  }

  function makeHandle(ip: string, ws: WebSocket): WsConnectionHandle {
    const url = `ws://${ip}/ws`;
    return {
      ip,
      url,
      sendObject: (obj) => send(ip, obj),
      close: () => close(ip),
      getReadyState: () => ws.readyState,
    };
  }

  function send(ip: string, obj: Record<string, any>): boolean {
    const ws = sockets.get(ip);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (!isPlainObject(obj)) return false;

    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function close(ip: string): void {
    void requestClose(ip, DEFAULT_CLOSE_SETTLE_TIMEOUT_MS);
  }

  function closeAndWait(ip: string, timeoutMs: number): Promise<void> {
    return requestClose(ip, timeoutMs);
  }

  function closeAll(): void {
    const ips = Array.from(new Set([...sockets.keys(), ...closingByIp.keys()]));
    for (const ip of ips) {
      close(ip);
    }
  }

  async function closeAllAndWait(timeoutMs: number): Promise<void> {
    const ips = Array.from(new Set([...sockets.keys(), ...closingByIp.keys()]));
    await Promise.all(ips.map((ip) => requestClose(ip, timeoutMs)));
  }

  function isOpen(ip: string): boolean {
    const ws = sockets.get(ip);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function requestClose(ip: string, timeoutMs: number): Promise<void> {
    const active = sockets.get(ip);
    if (!active) {
      return closingByIp.get(ip) ?? Promise.resolve();
    }

    if (sockets.get(ip) === active) {
      sockets.delete(ip);
    }

    if (active.readyState === WebSocket.CLOSED) {
      settleCloseWait(active);
      return Promise.resolve();
    }

    const waiter = ensureCloseWait(active, ip, timeoutMs);

    try {
      if (active.readyState !== WebSocket.CLOSING && active.readyState !== WebSocket.CLOSED) {
        active.close();
      }
    } catch {
      settleCloseWait(active);
    }

    if (active.readyState === WebSocket.CLOSED) {
      settleCloseWait(active);
    }

    return waiter.promise;
  }

  function ensureCloseWait(ws: WebSocket, ip: string, timeoutMs: number): CloseWaiter {
    const existing = closeWaiters.get(ws);
    if (existing) return existing;

    let resolveWait: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    const boundedTimeoutMs = Math.max(0, timeoutMs);
    const timeoutId = window.setTimeout(() => {
      settleCloseWait(ws);
    }, boundedTimeoutMs);

    const waiter: CloseWaiter = {
      ip,
      promise,
      resolve: resolveWait,
      timeoutId,
    };

    closeWaiters.set(ws, waiter);
    closingByIp.set(ip, promise);
    return waiter;
  }

  function settleCloseWait(ws: WebSocket): void {
    const waiter = closeWaiters.get(ws);
    if (!waiter) return;

    closeWaiters.delete(ws);
    if (waiter.timeoutId !== null) {
      window.clearTimeout(waiter.timeoutId);
    }
    if (closingByIp.get(waiter.ip) === waiter.promise) {
      closingByIp.delete(waiter.ip);
    }
    waiter.resolve();
  }

  return { connect, send, close, closeAndWait, closeAll, closeAllAndWait, isOpen };
}
