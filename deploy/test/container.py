"""Run the river image the ways deploy/compose.yml runs it: without a hub, then healthy against a real
Beszel hub on its Docker network (compose.beszel-network.yml, reached through the shipped Caddyfile in
a proxy container with compose.proxy-network.yml) and on the host's loopback (compose.host-network.yml).

    python3 deploy/test/container.py <image>

The hub and Caddy images come from compose.ci.yml. Each Compose run uses a temporary deployment
directory with copies of the shipped Compose files, a .env and mix.json, plus one override that runs
<image> instead of the published image, so nothing in the checkout is written. Needs Docker with
Compose 2.24 or later and free host ports 18090, 18095 and 18788 for the host-network run.
"""

import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from ci_images import COMPOSE_FILE as CI_COMPOSE, image as ci_image

DEPLOY = Path(__file__).resolve().parents[1]
MIX_EXAMPLE = DEPLOY.parent / "bridge" / "mix.example.json"
RIVER = sys.argv[1]
HUB = ci_image("beszel")
SUFFIX = uuid.uuid4().hex[:8]
SALT = "ci-container-test-salt"
ADMIN = ("admin@example.com", "ci-admin-password")
# Compose interpolates $ in unquoted and double-quoted .env values; .env.example says to single-quote
# secrets. A password that changed on the way would fail the login, and with it the health check.
USER = ("river@example.com", "ci-pa$$word-$HOME-${USER}")
# Compose must see only the test's files and settings, not the caller's.
COMPOSE_ENV = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}


def run(*args, cwd=None, check=True):
    result = subprocess.run(args, cwd=cwd, env=COMPOSE_ENV, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed ({result.returncode}):\n{result.stdout}{result.stderr}")
    return result.stdout.strip()


def request(port, path, method="GET"):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read().decode()
    finally:
        connection.close()


def wait_for(what, check, seconds=60):
    deadline = time.monotonic() + seconds
    while True:
        try:
            result = check()
            if result:
                return result
        except OSError:
            pass
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.5)


def snapshot(port):
    """The first event on /stream, which must be a snapshot."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("GET", "/stream")
        response = connection.getresponse()
        assert response.status == 200, response.status
        assert response.getheader("Content-Type") == "text/event-stream; charset=utf-8"
        for _ in range(20):
            line = response.readline().decode()
            if line.startswith("event:"):
                assert line == "event: snapshot\n", line
                data = response.readline().decode()
                assert data.startswith("data: "), data
                return json.loads(data[6:])
        raise AssertionError("no event on /stream")
    finally:
        connection.close()


def check_page(port):
    """The page, an asset and the stream on the public port; /healthz is not there."""
    status, headers, body = request(port, "/")
    assert status == 200, status
    assert headers["content-type"] == "text/html; charset=utf-8", headers
    assert headers["content-security-policy"].startswith("default-src 'self'"), headers
    assert headers["cache-control"] == "no-cache", headers
    asset = re.search(r'src="\./(assets/[^"]+\.js)"', body)
    assert asset, body
    status, headers, _ = request(port, "/" + asset[1])
    assert status == 200, status
    assert "immutable" in headers["cache-control"], headers
    assert headers["x-content-type-options"] == "nosniff", headers
    assert request(port, "/healthz")[0] == 404
    frame = snapshot(port)
    assert frame["v"] == 1, frame


def smoke():
    """No hub: the page and an empty snapshot are served, and the health listener says 503."""
    name = f"river-smoke-{SUFFIX}"
    try:
        run("docker", "run", "-d", "--name", name, "-p", "127.0.0.1::8787",
            "-e", "BESZEL_URL=http://127.0.0.1:9", "-e", "BESZEL_EMAIL=ci@example.com", "-e", "BESZEL_PASSWORD=ci",
            "-e", f"STREAM_SALT={SALT}",
            # Explicitly the public recipe: this isolated test has no real hub or private metrics.
            "-e", "MIX_FILE=mix.example.json", RIVER)
        port = int(run("docker", "port", name, "8787/tcp").splitlines()[0].rsplit(":", 1)[1])
        wait_for("the page", lambda: request(port, "/")[0] == 200)
        check_page(port)
        assert snapshot(port)["streams"] == []
        # busybox wget exits non-zero on 503 and prints the status line with -S.
        health = subprocess.run(["docker", "exec", name, "wget", "-S", "-O", "-", "http://127.0.0.1:8788/healthz"],
                                text=True, capture_output=True)
        assert health.returncode != 0 and "HTTP/1.1 503" in health.stderr, health.stderr
        print("ok: without a hub")
    except BaseException:
        print(run("docker", "logs", name, check=False), file=sys.stderr)
        raise
    finally:
        run("docker", "rm", "-f", name, check=False)


def setup_hub(container, url):
    """A superuser through the hub's CLI, then the river's read-only user through its API."""
    connection_port = int(url.rsplit(":", 1)[1])

    def api(path, body, token=None):
        connection = http.client.HTTPConnection("127.0.0.1", connection_port, timeout=10)
        try:
            headers = {"Content-Type": "application/json", **({"Authorization": token} if token else {})}
            connection.request("POST", path, json.dumps(body), headers)
            response = connection.getresponse()
            data = response.read().decode()
            assert response.status == 200, f"{path}: {response.status} {data}"
            return json.loads(data)
        finally:
            connection.close()

    # The hub answers only after applying its migrations; a CLI write before that can find the database
    # locked (SQLITE_BUSY).
    wait_for("the hub", lambda: request(connection_port, "/api/health")[0] == 200)
    run("docker", "exec", container, "/beszel", "superuser", "upsert", *ADMIN)
    token = api("/api/collections/_superusers/auth-with-password",
                {"identity": ADMIN[0], "password": ADMIN[1]})["token"]
    api("/api/collections/users/records",
        {"email": USER[0], "password": USER[1], "passwordConfirm": USER[1], "role": "readonly", "verified": True}, token)


def deployment(directory, overrides, settings):
    """A deployment directory as README describes it, running the image under test."""
    root = Path(directory)
    for name in ["compose.yml", *overrides]:
        shutil.copy(DEPLOY / name, root / name)
    (root / "compose.test.yml").write_text(
        f"services:\n  river:\n    build: !reset null\n    image: {RIVER}\n    pull_policy: never\n")
    mix = root / "mix.json"
    shutil.copy(MIX_EXAMPLE, mix)
    mix.chmod(0o644)  # the container's node user (uid 1000) must read it
    env = {
        "BESZEL_EMAIL": f"'{USER[0]}'",
        "BESZEL_PASSWORD": f"'{USER[1]}'",
        "STREAM_SALT": f"'{SALT}'",
        "COMPOSE_FILE": ":".join(["compose.yml", *overrides, "compose.test.yml"]),
        "COMPOSE_PROJECT_NAME": f"river-test-{SUFFIX}",
        **settings,
    }
    (root / ".env").write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    (root / ".env").chmod(0o600)
    return root


def compose_healthy(root, port):
    """docker compose up in the deployment directory, then the page and stream once healthy."""
    try:
        run("docker", "compose", "up", "-d", "--wait", "--wait-timeout", "90", cwd=root)
        assert run("docker", "inspect", "-f", "{{.State.Health.Status}}",
                   run("docker", "compose", "ps", "-q", "river", cwd=root)) == "healthy"
        check_page(port)
    except BaseException:
        print(run("docker", "compose", "logs", cwd=root, check=False), file=sys.stderr)
        raise
    finally:
        run("docker", "compose", "down", cwd=root, check=False)


def proxy(directory, network):
    """The shipped Caddyfile in a container on the proxy network, over plain HTTP on a free loopback port."""
    caddyfile = Path(directory) / "Caddyfile"
    text = (DEPLOY / "caddy" / "Caddyfile").read_text()
    assert "river.example.com {" in text and "127.0.0.1:8787" in text
    caddyfile.write_text(text.replace("river.example.com {", ":80 {").replace("127.0.0.1:8787", "river:8787"))
    caddyfile.chmod(0o644)
    name = f"river-ci-proxy-{SUFFIX}"
    run("docker", "run", "-d", "--name", name, "--network", network, "-p", "127.0.0.1::80",
        "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro", ci_image("caddy"))
    return name, int(run("docker", "port", name, "80/tcp").splitlines()[0].rsplit(":", 1)[1])


def hub_network():
    """The hub on its Docker network, and the river reached only through a proxy on another one."""
    project = f"river-ci-{SUFFIX}"
    hub = ["docker", "compose", "-f", str(CI_COMPOSE), "-p", project]
    network = f"river-ci-proxy-{SUFFIX}"
    caddy = None
    try:
        run(*hub, "up", "-d", "beszel")
        container = run(*hub, "ps", "-q", "beszel")
        setup_hub(container, run(*hub, "port", "beszel", "8090"))
        run("docker", "network", "create", network)
        with tempfile.TemporaryDirectory(prefix="river-deploy-") as directory:
            root = deployment(directory, ["compose.beszel-network.yml", "compose.proxy-network.yml"], {
                "BESZEL_URL": "http://beszel:8090",
                "BESZEL_NETWORK": f"{project}_default",
                "PROXY_NETWORK": network,
            })
            caddy, port = proxy(directory, network)
            compose_healthy(root, port)
        print("ok: hub on its Docker network, page through a proxy on another one")
    finally:
        if caddy:
            run("docker", "rm", "-f", caddy, check=False)
        run(*hub, "down", "-v", check=False)
        run("docker", "network", "rm", network, check=False)


def hub_host_network():
    name = f"river-ci-hub-host-{SUFFIX}"
    try:
        # A hub that listens only on the host's loopback, which a bridged container cannot reach.
        run("docker", "run", "-d", "--name", name, "--network", "host", HUB, "serve", "--http=127.0.0.1:18090")
        setup_hub(name, "127.0.0.1:18090")
        with tempfile.TemporaryDirectory(prefix="river-deploy-") as directory:
            root = deployment(directory, ["compose.host-network.yml"], {
                "BESZEL_URL": "http://127.0.0.1:18090",
                # Both ports move, which also proves the health check follows HEALTH_PORT.
                "RIVER_PORT": "18095",
                "RIVER_HEALTH_PORT": "18788",
            })
            compose_healthy(root, 18095)
        print("ok: hub on the host's loopback")
    finally:
        run("docker", "rm", "-f", name, check=False)


smoke()
hub_network()
hub_host_network()
