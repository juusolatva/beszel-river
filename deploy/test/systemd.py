"""Run Node's JIT and HTTP server under the service's sandbox (needs passwordless sudo)."""

import configparser
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


unit = Path(__file__).resolve().parents[1] / "beszel-river-bridge.service"
config = configparser.ConfigParser(interpolation=None)
config.optionxform = str
config.read(unit)
node = shutil.which("node")
assert node, "Node must be installed"

# Verify a copy with this machine's executable; the deployment path may not exist on a CI runner.
with tempfile.TemporaryDirectory(prefix="river-systemd-") as directory:
    candidate = Path(directory) / unit.name
    candidate.write_text(unit.read_text().replace("ExecStart=/usr/bin/node dist/main.js", f"ExecStart={node} --version"))
    subprocess.run(["systemd-analyze", "verify", "--man=no", str(candidate)], check=True)
if "--verify-only" in sys.argv:
    sys.exit(0)

properties = []
for key, value in config["Service"].items():
    if key in {"Type", "User", "Group", "WorkingDirectory", "ExecStart", "Environment", "Restart", "RestartSec"}:
        continue
    properties.extend(["--property", f"{key}={value}"])

probe = """
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
assert.equal(new Function('x', 'return x + 1')(41), 42);
for (const field of ['CapBnd', 'CapEff']) {
  assert.match(readFileSync('/proc/self/status', 'utf8'), new RegExp(field + ':\\\\s+0+\\\\n'));
}
const file = '/tmp/river-umask-' + process.pid;
writeFileSync(file, 'synthetic fixture');
assert.equal(statSync(file).mode & 0o777, 0o600);
unlinkSync(file);
const server = createServer((_, response) => response.end('ok'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  assert.equal(await response.text(), 'ok');
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log('systemd sandbox: Node JIT, HTTP, empty capabilities and private file permissions passed');
"""
subprocess.run([
    "sudo", "-n", "systemd-run", "--wait", "--pipe", "--collect",
    "--unit", f"river-sandbox-test-{uuid.uuid4().hex[:12]}",
    "--property", "User=nobody", "--property", "RuntimeMaxSec=30s",
    *properties, node, "--input-type=module", "-e", probe,
], check=True)
