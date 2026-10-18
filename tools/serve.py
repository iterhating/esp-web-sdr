"""Serve the site on localhost with caching disabled, so edits show on reload.

Web Serial and WebUSB need a secure context: localhost qualifies over HTTP.
usage: serve.py [PORT]   (default 8765, binds 127.0.0.1 only)
"""
import functools
import http.server
import pathlib
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = pathlib.Path(__file__).resolve().parent.parent
handler = functools.partial(NoCache, directory=str(root))
print(f"serving {root} at http://127.0.0.1:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
