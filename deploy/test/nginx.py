"""Exercise the shipped nginx keys and stream limits with isolated, synthetic clients."""

import http.client
import ipaddress
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


configs = Path(__file__).resolve().parents[1] / "nginx"
name = f"river-nginx-test-{uuid.uuid4().hex[:12]}"
with tempfile.TemporaryDirectory(prefix="river-nginx-") as directory:
    root = Path(directory)
    own = (configs / "river.conf").read_text()
    start = own.index("    location = /stream {")
    location = own[start:own.index("\n    }", start) + 6]
    # Real-IP header trust exists only in this isolated test server, never in the shipped configs.
    (root / "default.conf").write_text(
        "include /etc/nginx/snippets/river-limits.conf;\n"
        "server { listen 8080; set_real_ip_from 0.0.0.0/0; real_ip_header X-Test-Client;\n"
        'location = /key { default_type application/octet-stream; return 200 "$river_client_key"; }\n'
        + location + "\ninclude /etc/nginx/snippets/river-path.conf;\n}\n"
        # Hold upstream bodies open so nginx must count concurrent downstream stream requests.
        + 'server { listen 8787; location /stream { limit_rate_after 512; limit_rate 1; return 200 "'
        + "x" * 1024 + '"; } }\n'
    )
    try:
        docker("run", "-d", "--name", name, "-p", "127.0.0.1::8080",
               "-v", f"{root / 'default.conf'}:/etc/nginx/conf.d/default.conf:ro",
               "-v", f"{configs}:/etc/nginx/snippets:ro", "nginx:stable-alpine")
        port = int(docker("port", name, "8080/tcp").rsplit(":", 1)[1])

        def request(path, address):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
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

        for index, path in enumerate(["/stream", "/river/stream", "/stream"]):
            held = []
            try:
                for suffix in range(1, 9):
                    address = "192.0.2.100" if index == 2 else f"2001:db8:a:{index}::{suffix}"
                    connection, response = request(path, address)
                    held.append((connection, response))
                    assert response.status == 200, (path, suffix, response.status)
                address = "192.0.2.100" if index == 2 else f"2001:db8:a:{index}::ffff"
                connection, response = request(path, address)
                assert response.status == 429, (path, response.status)
                response.read()
                connection.close()
                # A different /64 and IPv4 address have their own allowance.
                for address in [f"2001:db8:b:{index}::1", f"192.0.2.{index + 1}"]:
                    connection, response = request(path, address)
                    held.append((connection, response))
                    assert response.status == 200, (path, address, response.status)
                kind = "IPv4" if index == 2 else "rotated IPv6"
                print(f"{path}: eight {kind} clients accepted, ninth rejected, other prefixes accepted")
            finally:
                for connection, response in held:
                    response.close()
                    connection.close()
    except Exception:
        print(docker("logs", name))
        raise
    finally:
        subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL)
