"""Exercise the shipped nginx configs: address keys and stream limits with isolated, synthetic clients,
then the container configs in front of a stub container (proxy_check.py).

    python3 deploy/test/nginx.py
"""

import http.client
import ipaddress
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from ci_images import image
import proxy_check


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


configs = Path(__file__).resolve().parents[1] / "nginx"
name = f"river-nginx-test-{uuid.uuid4().hex[:12]}"
with tempfile.TemporaryDirectory(prefix="river-nginx-") as directory:
    root = Path(directory)

    def stream_location(config):
        text = (configs / config).read_text()
        start = text.index("    location = /stream {")
        return text[start:text.index("\n    }", start) + 6]

    # Real-IP header trust exists only in this isolated test server, never in the shipped configs.
    trust = "set_real_ip_from 0.0.0.0/0; real_ip_header X-Test-Client;\n"
    # Hold upstream bodies open so nginx must count concurrent downstream stream requests. The bridge
    # (8787) and the container (8095) are both stubs inside the nginx container.
    held = 'location /stream { limit_rate_after 512; limit_rate 1; return 200 "' + "x" * 1024 + '"; }'
    (root / "default.conf").write_text(
        "include /etc/nginx/snippets/river-limits.conf;\n"
        "server { listen 8080; " + trust
        + 'location = /key { default_type application/octet-stream; return 200 "$river_client_key"; }\n'
        + stream_location("river.conf") + "\ninclude /etc/nginx/snippets/river-path.conf;\n}\n"
        + "server { listen 8081; " + trust
        + stream_location("river-container.conf") + "\ninclude /etc/nginx/snippets/river-container-path.conf;\n}\n"
        + f"server {{ listen 8787; {held} }}\nserver {{ listen 8095; {held} }}\n"
    )
    try:
        docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081",
               "-v", f"{root / 'default.conf'}:/etc/nginx/conf.d/default.conf:ro",
               "-v", f"{configs}:/etc/nginx/snippets:ro", image("nginx"))
        ports = {p: int(docker("port", name, f"{p}/tcp").rsplit(":", 1)[1]) for p in (8080, 8081)}

        def request(path, address, server=8080):
            connection = http.client.HTTPConnection("127.0.0.1", ports[server], timeout=5)
            try:
                connection.request("GET", path, headers={"X-Test-Client": address})
                return connection, connection.getresponse()
            except Exception:
                connection.close()
                raise

        for attempt in range(50):
            try:
                connection, response = request("/key", "127.0.0.1")
                response.read()
                connection.close()
                break
            except (ConnectionError, OSError):
                if attempt == 49:
                    raise
                time.sleep(0.1)

        addresses = [
            "192.0.2.1", "192.0.2.2", "::1", "2001:db8::1", "2001:0db8:0:0:ffff::2",
            "2001:db8:0:1::1", "2001:db8:a:d::1", "2001:db8:a:d:a:d:ff00:1",
            "ff00:0:a:d::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        ]
        for address in addresses:
            connection, response = request("/key", address)
            packed = ipaddress.ip_address(address).packed
            expected = packed[:8] if len(packed) == 16 else packed
            assert response.status == 200 and response.read() == expected, address
            connection.close()
        print("Binary keys: IPv4, compressed IPv6, NUL/CR/LF/high bytes and /64 separation passed")

        # river.conf and river-path.conf on 8080, the container configs on 8081; the last run is IPv4.
        cases = [(8080, "/stream"), (8080, "/river/stream"), (8081, "/stream"), (8081, "/river/stream"), (8080, "/stream")]
        for index, (server, path) in enumerate(cases):
            ipv4 = index == len(cases) - 1
            held = []
            try:
                for suffix in range(1, 9):
                    address = "192.0.2.100" if ipv4 else f"2001:db8:a:{index}::{suffix}"
                    connection, response = request(path, address, server)
                    held.append((connection, response))
                    assert response.status == 200, (server, path, suffix, response.status)
                address = "192.0.2.100" if ipv4 else f"2001:db8:a:{index}::ffff"
                connection, response = request(path, address, server)
                assert response.status == 429, (server, path, response.status)
                response.read()
                connection.close()
                # A different /64 and IPv4 address have their own allowance.
                for address in [f"2001:db8:b:{index}::1", f"192.0.2.{index + 1}"]:
                    connection, response = request(path, address, server)
                    held.append((connection, response))
                    assert response.status == 200, (server, path, address, response.status)
                kind = "IPv4" if ipv4 else "rotated IPv6"
                config = "container" if server == 8081 else "bridge"
                print(f"{path} ({config}): eight {kind} clients accepted, ninth rejected, other prefixes accepted")
            finally:
                for connection, response in held:
                    response.close()
                    connection.close()
    except Exception:
        print(docker("logs", name))
        raise
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL)


# The container configs with host networking, so nginx reaches the stub container on the host's loopback.
upstream = proxy_check.Upstream()
http_port, https_port, path_port = (proxy_check.free_port() for _ in range(3))
name = f"river-nginx-proxy-test-{uuid.uuid4().hex[:12]}"
with tempfile.TemporaryDirectory(prefix="river-nginx-") as directory:
    root = Path(directory)
    (root / "test").mkdir()
    (root / "conf.d").mkdir()
    # The shipped files with only their ports changed; the [::] listens need IPv6 in the network namespace.
    for config in ["river-container.conf", "river-container-path.conf"]:
        text = (configs / config).read_text()
        assert "127.0.0.1:8095" in text, config
        text = text.replace("127.0.0.1:8095", f"127.0.0.1:{upstream.port}")
        text = text.replace("listen 80;", f"listen 127.0.0.1:{http_port};")
        text = text.replace("listen 443 ssl;", f"listen 127.0.0.1:{https_port} ssl;")
        text = "\n".join(line for line in text.splitlines() if "listen [::]" not in line)
        (root / "test" / config).write_text(text)
    assert f"listen 127.0.0.1:{https_port} ssl;" in (root / "test" / "river-container.conf").read_text()
    (root / "conf.d" / "default.conf").write_text(
        "include /etc/nginx/test/river-container.conf;\n"
        f"server {{ listen 127.0.0.1:{path_port}; include /etc/nginx/test/river-container-path.conf; }}\n")
    live = root / "le" / "live" / "river.example.com"
    live.mkdir(parents=True)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=river.example.com", "-keyout", str(live / "privkey.pem"),
                    "-out", str(live / "fullchain.pem")], check=True, capture_output=True)
    for file in root.rglob("*"):
        file.chmod(0o755 if file.is_dir() else 0o644)  # nginx workers run as the nginx user
    try:
        docker("run", "-d", "--name", name, "--network", "host",
               "-v", f"{root / 'conf.d'}:/etc/nginx/conf.d:ro", "-v", f"{root / 'test'}:/etc/nginx/test:ro",
               "-v", f"{root / 'le'}:/etc/letsencrypt:ro", "-v", f"{configs}:/etc/nginx/snippets:ro", image("nginx"))
        proxy_check.wait_ready(https_port, tls=True)
        proxy_check.check(upstream, https_port, "", tls=True, hsts=True)
        status, headers, _ = proxy_check.get(http_port, "/", tls=False)
        assert status == 301 and headers["location"].startswith("https://"), (status, headers)
        print("river-container.conf: compression, HSTS, HTTPS redirect, unbuffered events, upstream closed on leave")
        proxy_check.check(upstream, path_port, "/river", tls=False, hsts=False, redirect_status=301)
        print("river-container-path.conf: compression, /river redirect, prefix stripped, unbuffered events, "
              "upstream closed on leave")
    except Exception:
        print(docker("logs", name))
        raise
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL)
        upstream.close()
