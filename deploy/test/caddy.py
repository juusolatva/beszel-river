"""Run the shipped Caddyfiles in front of a stub container (proxy_check.py): compression, HSTS, the
/river redirect and prefix stripping, unbuffered events, and the upstream closing when the viewer leaves.

    python3 deploy/test/caddy.py

Caddy runs with host networking on free loopback ports, with Caddy's internal CA instead of ACME. Its
copies of the configs differ from the shipped ones only in the site address and the upstream port.
"""

from pathlib import Path
import subprocess
import tempfile
import uuid

from ci_images import image
import proxy_check

CONFIGS = Path(__file__).resolve().parents[1] / "caddy"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True, capture_output=True).stdout.strip()


upstream = proxy_check.Upstream()
http_port, https_port = proxy_check.free_port(), proxy_check.free_port()
name = f"river-caddy-test-{uuid.uuid4().hex[:12]}"
with tempfile.TemporaryDirectory(prefix="river-caddy-") as directory:
    root = Path(directory)
    for file in ["Caddyfile", "Caddyfile.path"]:
        text = (CONFIGS / file).read_text()
        assert "127.0.0.1:8787" in text, file
        (root / file).write_text(text.replace("127.0.0.1:8787", f"127.0.0.1:{upstream.port}"))
    own = (root / "Caddyfile").read_text()
    assert "river.example.com {" in own
    # The shipped site under the name localhost, and a plain-HTTP site importing the path snippet.
    path_site = proxy_check.free_port()
    (root / "Caddyfile").write_text(
        f"{{\n\tadmin off\n\tlocal_certs\n\tskip_install_trust\n\thttp_port {http_port}\n\thttps_port {https_port}\n}}\n\n"
        + own.replace("river.example.com {", "localhost {")
        + f"\nhttp://127.0.0.1:{path_site} {{\n\timport /etc/caddy/Caddyfile.path\n}}\n")
    try:
        docker("run", "-d", "--name", name, "--network", "host", "-v", f"{root}:/etc/caddy:ro", image("caddy"))
        proxy_check.wait_ready(https_port, tls=True, host="localhost")
        proxy_check.check(upstream, https_port, "", tls=True, hsts=True, host="localhost")
        # Automatic HTTPS redirects plain HTTP.
        status, headers, _ = proxy_check.get(http_port, "/", tls=False, host="localhost")
        assert status == 308 and headers["location"].startswith("https://localhost"), (status, headers)
        print("Caddyfile: compression, HSTS, HTTPS redirect, unbuffered events, upstream closed on leave")
        proxy_check.check(upstream, path_site, "/river", tls=False, hsts=False, redirect_status=308)
        print("Caddyfile.path: compression, /river redirect, prefix stripped, unbuffered events, upstream closed")
    except Exception:
        print(docker("logs", name, check=False))
        raise
    finally:
        docker("rm", "-f", name, check=False)
        upstream.close()
