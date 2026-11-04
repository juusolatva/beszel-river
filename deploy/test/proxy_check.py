"""Shared checks for the container proxy configs (nginx.py, caddy.py).

The proxy under test runs with host networking, with its upstream port changed from 8787 to a stub
that stands in for the container: it serves a page, an asset and an SSE stream, records the paths it
is asked for, and notices when the proxy closes a stream's upstream connection. With SOURCE=realtime
the container polls the hub only while it has viewers, so a proxy that kept upstream streams open
after the browser left would keep the hub polling every agent.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gzip
import http.client
import socket
import ssl
import threading
import time

# Sizes above Caddy's 512-byte minimum for compression; the CSP header shows the container's headers
# pass through unchanged.
PAGE = ("<!doctype html><title>river</title>" + "<p>river</p>" * 100).encode()
SCRIPT = ("console.log('river');" * 100).encode()
CSP = "default-src 'self'"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Upstream:
    """The stub container on 127.0.0.1:<port>."""

    def __init__(self):
        self.paths = []
        self.open_streams = 0
        self.lock = threading.Lock()
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                with upstream.lock:
                    upstream.paths.append(self.path)
                files = {"/": ("text/html; charset=utf-8", PAGE), "/assets/app.js": ("text/javascript; charset=utf-8", SCRIPT)}
                if self.path == "/stream":
                    self.stream()
                elif self.path in files:
                    content_type, body = files[self.path]
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Content-Security-Policy", CSP)
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            def stream(self):
                # Chunked like the bridge's own stream, one small event every 0.2 s.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                with upstream.lock:
                    upstream.open_streams += 1
                try:
                    for number in range(10):
                        event = f"event: frame\ndata: {number}\n\n".encode()
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(event), event))
                        self.wfile.flush()
                        time.sleep(0.2)
                    # Then quiet, as between the bridge's events: a proxy that only noticed the viewer
                    # leaving on its next write would keep this open. The proxy closing shows as EOF.
                    self.connection.settimeout(60)
                    self.connection.recv(1)
                except OSError:
                    pass  # the proxy closed the connection (or 60 s passed, which fails the check)
                finally:
                    with upstream.lock:
                        upstream.open_streams -= 1
                    self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def connect(port, tls, host="127.0.0.1"):
    if not tls:
        return http.client.HTTPConnection(host, port, timeout=5)
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # the tests' own throwaway certificates
    return http.client.HTTPSConnection(host, port, timeout=5, context=context)


def get(port, path, tls, host="127.0.0.1"):
    connection = connect(port, tls, host)
    try:
        connection.request("GET", path, headers={"Accept-Encoding": "gzip"})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def wait_ready(port, tls, host="127.0.0.1", seconds=30):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return get(port, "/", tls, host)
        except (OSError, http.client.HTTPException):
            if time.monotonic() > deadline:
                raise
            time.sleep(0.2)


def check(upstream, port, prefix, tls, hsts, redirect_status=None, host="127.0.0.1"):
    """The page, an asset, a 404 and the stream through the proxy at prefix ("" or "/river")."""
    upstream.paths.clear()
    status, headers, body = get(port, prefix + "/", tls, host)
    assert status == 200, status
    assert headers.get("content-encoding") == "gzip", headers
    assert gzip.decompress(body) == PAGE
    assert headers.get("content-security-policy") == CSP, headers
    assert ("strict-transport-security" in headers) == hsts, headers
    status, headers, body = get(port, prefix + "/assets/app.js", tls, host)
    assert status == 200 and headers.get("content-encoding") == "gzip", (status, headers)
    assert gzip.decompress(body) == SCRIPT
    assert get(port, prefix + "/missing", tls, host)[0] == 404
    if redirect_status:
        status, headers, _ = get(port, prefix, tls, host)
        assert status == redirect_status and headers["location"].endswith(prefix + "/"), (status, headers)

    connection = connect(port, tls, host)
    try:
        connection.request("GET", prefix + "/stream", headers={"Accept-Encoding": "gzip"})
        response = connection.getresponse()
        assert response.status == 200, response.status
        assert "content-encoding" not in {k.lower() for k, _ in response.getheaders()}, response.getheaders()
        # Ten events written 0.2 s apart arrive in about 2 s; a buffering proxy would hold them back.
        start = time.monotonic()
        events = 0
        while events < 10:
            line = response.readline()
            assert line, "stream ended"
            events += line.startswith(b"data: ")
        assert time.monotonic() - start < 4, time.monotonic() - start
        assert upstream.open_streams == 1, upstream.open_streams
    finally:
        connection.close()
    deadline = time.monotonic() + 5
    while upstream.open_streams:
        assert time.monotonic() < deadline, "the proxy kept the upstream stream open after the viewer left"
        time.sleep(0.1)
    # The prefix is stripped: the container only knows its own paths.
    assert upstream.paths == ["/", "/assets/app.js", "/missing", "/stream"], upstream.paths
