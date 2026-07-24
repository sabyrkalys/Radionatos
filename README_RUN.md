# RadiantOS slice vNext.3.10.3 — RUN / BUILD

## Быстрый запуск (рекомендуемый)

### Windows

1. Распаковать архив.
2. Дважды кликнуть `Start-RadiantOS.cmd`.
3. Откроется `RadiantOS_Standalone.html` без локального web server.

### Linux / macOS

```bash
./RUN_DIST_LOCAL.sh
```

## Альтернативный прямой запуск

Открыть файл:

```text
RadiantOS_Standalone.html
```

## Build / verification

```bash
npm install
npm run typecheck
npm run build
```

## Diagnostic fallback

Если policy конкретного браузера/среды запрещает нужный `file://` runtime:

```bash
python tools/serve_dist.py
```

или:

```bash
npm run serve-dist
```

Тогда открыть:

```text
http://127.0.0.1:8080/
```
