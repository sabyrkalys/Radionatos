# RadiantOS slice — vNext.3.10.3 (standalone file-open delivery hotfix)

Этот snapshot переводит поставку в standalone delivery mode (автономный режим поставки):
- больше не нужен отдельный локальный web server для обычного просмотра/тестирования поставки;
- deliverable открывается прямым запуском `RadiantOS_Standalone.html`;
- fallback helper server сохранён только как диагностический путь.

## Root cause

Предыдущая поставка собирала `dist/index.html` через Vite SPA entry с `type="module"`.
На target browser-path `file://.../dist/index.html` это требовало локальную HTTP-раздачу, иначе инициализация runtime была нестабильной / blocked browser security policy.

В этой итерации delivery build переведён на:
- single-bundle IIFE JS (`dist/radiantos-app.js`);
- classic `<script src="...">` вместо module entry;
- standalone launcher `RadiantOS_Standalone.html`.

## Рекомендуемый запуск для заказчика

### Windows

Двойной клик по:

```text
Start-RadiantOS.cmd
```

или напрямую по:

```text
RadiantOS_Standalone.html
```

### Linux/macOS

```bash
./RUN_DIST_LOCAL.sh
```

или открыть вручную файл:

```text
RadiantOS_Standalone.html
```

## Build / verification

```bash
npm install
npm run typecheck
npm run build
```

После `npm run build` в пакете формируются:
- `dist/radiantos-app.js`
- `dist/styles.css`
- `dist/index.html`
- `RadiantOS_Standalone.html`

## Fallback / diagnostic path

Если в конкретной корпоративной среде browser policy жёстко ограничивает `file://` runtime, запасной helper path сохранён:

```bash
python tools/serve_dist.py
```

или:

```bash
npm run serve-dist
```

## Contract notes

- runtime transport остаётся только `ws://<ip>/ws`;
- никакой backend / proxy / HTTP API не добавлен;
- изменён только delivery topology (топология поставки), а не бизнес-логика приложения.
# Radionatos
