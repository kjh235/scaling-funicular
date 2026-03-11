"""
Holiday Resolver — HTTP server (stdlib only, no third-party deps)

Serves the HTML UI and exposes a JSON API that runs the Python resolver.

Usage:
    python server.py [port]          # default port 8000
    python server.py 9000

Endpoints:
    GET  /                           → index.html
    GET  /sample-config.json         → sample config
    POST /api/resolve                → resolve holidays
    POST /api/check-date             → check a specific date
    POST /api/policies               → resolve policies

POST body for /api/resolve:
    {
      "config": { ...full config object... },
      "year": 2026,
      "jurisdiction_id": "us",        // optional
      "classification": "public_holiday"  // optional
    }

POST body for /api/check-date:
    {
      "config": { ... },
      "date": "2026-07-03",
      "jurisdiction_id": "us"         // optional
    }

POST body for /api/policies:
    {
      "config": { ... },
      "year": 2026
    }
"""

import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from holiday_resolver import HolidayResolver, PolicyResolver

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('holiday-resolver')

# Directory containing this file — used to locate static assets
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

STATIC_FILES: dict[str, str] = {
    '/':                   'index.html',
    '/index.html':         'index.html',
    '/sample-config.json': 'sample-config.json',
}

MIME: dict[str, str] = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
}


# ── Request handler ───────────────────────────────────────────────────────────

class HolidayHandler(BaseHTTPRequestHandler):

    # ── routing ───────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path in STATIC_FILES:
            self._serve_file(STATIC_FILES[path])
        else:
            self._send_error(404, f"Not found: {path}")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        body = self._read_body()

        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError as exc:
            return self._send_error(400, f"Invalid JSON: {exc}")

        routes = {
            '/api/resolve':    self._handle_resolve,
            '/api/check-date': self._handle_check_date,
            '/api/policies':   self._handle_policies,
        }

        handler = routes.get(path)
        if handler:
            try:
                handler(data)
            except Exception as exc:
                log.exception("Handler error")
                self._send_error(500, str(exc))
        else:
            self._send_error(404, f"Not found: {path}")

    def do_OPTIONS(self) -> None:
        """Support CORS pre-flight (useful when testing with a separate dev server)."""
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ── API handlers ──────────────────────────────────────────────────────

    def _handle_resolve(self, data: dict) -> None:
        config         = data.get('config') or {}
        year           = int(data.get('year', 2026))
        jurisdiction   = data.get('jurisdiction_id') or None
        classification = data.get('classification') or None

        resolver = HolidayResolver(config)
        events   = resolver.resolve(year, year, jurisdiction)

        if classification:
            events = [e for e in events if e.get('classification') == classification]

        self._send_json({
            'year':  year,
            'count': len(events),
            'events': events,
        })

    def _handle_check_date(self, data: dict) -> None:
        config       = data.get('config') or {}
        date_str     = data.get('date', '')
        jurisdiction = data.get('jurisdiction_id') or None

        if not date_str:
            return self._send_error(400, "Missing 'date' field (YYYY-MM-DD).")

        resolver = HolidayResolver(config)
        result   = resolver.check_date(date_str, jurisdiction)
        self._send_json(result)

    def _handle_policies(self, data: dict) -> None:
        config = data.get('config') or {}
        year   = int(data.get('year', 2026))

        resolver = PolicyResolver(config)
        self._send_json({
            'year':     year,
            'policies': resolver.resolve(year),
        })

    # ── response helpers ──────────────────────────────────────────────────

    def _read_body(self) -> str:
        length = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(length).decode('utf-8') if length else ''

    def _serve_file(self, filename: str) -> None:
        filepath = os.path.join(BASE_DIR, filename)
        _, ext   = os.path.splitext(filename)
        mime     = MIME.get(ext, 'application/octet-stream')

        try:
            with open(filepath, 'rb') as fh:
                content = fh.read()
        except FileNotFoundError:
            self._send_error(404, f"File not found: {filename}")
            return

        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(content)

    def _send_json(self, payload: object) -> None:
        body = json.dumps(payload, default=str).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, code: int, message: str) -> None:
        body = json.dumps({'error': message}).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _cors_headers() -> None:
        # Handled on the instance — work-around: no-op since we call
        # self.send_header directly in callers. This is a reminder stub.
        pass

    # Silence default request logging and replace with ours
    def log_message(self, fmt: str, *args: object) -> None:
        log.info("%-8s %s", args[0] if args else '', args[1] if len(args) > 1 else '')


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(('', port), HolidayHandler)
    log.info("Holiday Resolver  →  http://localhost:%d", port)
    log.info("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down.")


if __name__ == '__main__':
    main()
