#!/usr/bin/env python3
from __future__ import annotations

import http.server
import socketserver
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8080
ROOT = Path(__file__).resolve().parents[1] / "dist"

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

if __name__ == "__main__":
    if not (ROOT / "index.html").exists():
        raise SystemExit(f"dist/index.html not found in {ROOT}")

    with socketserver.TCPServer((HOST, PORT), Handler) as httpd:
        print(f"RadiantOS preview server: http://{HOST}:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("
Stopped.")
