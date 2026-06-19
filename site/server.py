#!/usr/bin/env python3
"""BeQuant local server.

Serves the static study site AND:
  * persists progress/assessments to site/state.json   (GET/POST /api/state)
  * compiles & runs code submissions for the coding quizzes (POST /api/run)
  * reports which runtimes are available                 (GET  /api/runtime)

    python3 server.py [port]      # default 8000

Bound to 127.0.0.1 only: /api/run executes code locally, so it must not be
reachable from other machines. This is a single-user local study tool.
"""
import http.server
import socketserver
import os
import sys
import json
import time
import shutil
import tempfile
import subprocess
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, "state.json")

CXX = shutil.which("clang++") or shutil.which("g++")
MAX_OUT = 64 * 1024  # cap captured output


def run_code(lang, source, stdin, timeout_ms):
    """Compile (C++) and/or run a self-contained program; return a result dict."""
    timeout = min(max((timeout_ms or 5000) / 1000.0, 1), 10)
    workdir = tempfile.mkdtemp(prefix="bq_run_")
    try:
        if lang == "cpp":
            if not CXX:
                return {"ok": False, "stage": "compiler",
                        "error": "No C++ compiler (clang++/g++) found on PATH."}
            src = os.path.join(workdir, "main.cpp")
            binp = os.path.join(workdir, "prog")
            with open(src, "w") as f:
                f.write(source)
            t0 = time.time()
            comp = subprocess.run([CXX, "-std=c++20", "-O2", "-pipe", "-w", "-o", binp, src],
                                  capture_output=True, text=True, timeout=30)
            comp_ms = int((time.time() - t0) * 1000)
            if comp.returncode != 0:
                return {"ok": False, "stage": "compile", "compiler": os.path.basename(CXX),
                        "stderr": comp.stderr[:MAX_OUT], "compileMs": comp_ms}
            run = subprocess.run([binp], input=stdin or "", capture_output=True, text=True, timeout=timeout)
            return {"ok": True, "stage": "run", "compiler": os.path.basename(CXX), "compileMs": comp_ms,
                    "stdout": run.stdout[:MAX_OUT], "stderr": run.stderr[:MAX_OUT], "exitCode": run.returncode}
        elif lang == "python":
            src = os.path.join(workdir, "main.py")
            with open(src, "w") as f:
                f.write(source)
            run = subprocess.run([sys.executable, src], input=stdin or "", capture_output=True, text=True, timeout=timeout)
            return {"ok": True, "stage": "run", "stdout": run.stdout[:MAX_OUT],
                    "stderr": run.stderr[:MAX_OUT], "exitCode": run.returncode}
        return {"ok": False, "stage": "lang", "error": "Unsupported language: " + str(lang)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stage": "timeout",
                "error": f"Timed out after {timeout:g}s — possible infinite loop or it's waiting on input."}
    except Exception as e:
        return {"ok": False, "stage": "error", "error": str(e)}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            try:
                with open(STATE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (FileNotFoundError, ValueError):
                data = {}
            return self._send_json(200, data)
        if path == "/api/runtime":
            return self._send_json(200, {
                "cpp": bool(CXX), "cppCompiler": os.path.basename(CXX) if CXX else None,
                "python": True,
            })
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            try:
                data = self._read_body()
            except ValueError as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
            tmp = STATE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, STATE)
            return self._send_json(200, {"ok": True})
        if path == "/api/run":
            try:
                body = self._read_body()
            except ValueError as e:
                return self._send_json(400, {"ok": False, "error": str(e)})
            return self._send_json(200, run_code(body.get("lang"), body.get("source", ""),
                                                  body.get("stdin", ""), body.get("timeoutMs")))
        self.send_error(404)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"BeQuant local  →  http://localhost:{PORT}")
        print(f"progress file  →  {STATE}")
        print(f"C++ compiler   →  {CXX or 'NOT FOUND (coding-run disabled for C++)'}")
        print("(Ctrl-C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")
