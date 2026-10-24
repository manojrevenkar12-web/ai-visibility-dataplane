"""Development stand-in for a ClickHouse server: the subset of the HTTP interface the data plane
uses (queries in the body, inserts with ?query=, ?param_x= parameters, ?database=,
?insert_deduplication_token=), served by chDB, the embedded ClickHouse engine.

Used where a ClickHouse server cannot be started (no Docker). CI runs against the real
clickhouse-server image; the SQL is the same engine either way.

    python3 scripts/chdb_http.py --port 8123 --path .data/chdb
"""

from __future__ import annotations

import argparse
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from chdb import session as chs

LOCK = threading.Lock()
SESSION: chs.Session | None = None
PARAM = re.compile(r"\{(\w+):([^}]+)\}")


def _literal(value: str, typ: str) -> str:
    if re.match(r"^(U?Int\d+|Float\d+|Decimal.*)$", typ.strip()):
        float(value)  # reject anything that is not a number
        return value
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # quiet
        pass

    def _reply(self, code: int, body: str) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/ping":
            self._reply(200, "Ok.\n")
            return
        self._handle("")

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        self._handle(self.rfile.read(n).decode())

    def _handle(self, body: str) -> None:
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        sql = q.get("query")
        token = q.get("insert_deduplication_token")
        if sql:  # insert: statement in the URL, data in the body
            if token:
                sql = sql.replace(" FORMAT ", f" SETTINGS insert_deduplication_token='{token}' FORMAT ", 1)
            sql = sql + "\n" + body
        else:
            sql = body
        params = {k[6:]: v for k, v in q.items() if k.startswith("param_")}
        sql = PARAM.sub(lambda m: _literal(params[m.group(1)], m.group(2)), sql)
        fmt = "TabSeparated"
        m = re.search(r"\bFORMAT\s+(\w+)\s*$", sql.strip())
        if m and not sql.lstrip().upper().startswith("INSERT"):
            fmt = m.group(1)
            sql = sql.strip()[: m.start()]
        try:
            with LOCK:
                assert SESSION is not None
                if q.get("database"):
                    SESSION.query(f"USE {q['database']}")
                res = SESSION.query(sql, fmt)
            out = res.bytes().decode() if res is not None and hasattr(res, "bytes") else str(res or "")
            self._reply(200, out)
        except Exception as e:  # ClickHouse answers errors with a 4xx/5xx and the message
            self._reply(500, f"Code: 1000. DB::Exception: {e}")


def main() -> None:
    global SESSION
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--path", default=".data/chdb")
    a = ap.parse_args()
    SESSION = chs.Session(a.path)
    ThreadingHTTPServer.request_queue_size = 256  # accept bursts; queries still run one at a time
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
