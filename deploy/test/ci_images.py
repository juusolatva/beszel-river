"""Image references from compose.ci.yml, the one place the CI images are pinned."""

import json
from pathlib import Path
import subprocess
import sys

COMPOSE_FILE = Path(__file__).resolve().with_name("compose.ci.yml")


def image(service):
    config = subprocess.check_output(
        ["docker", "compose", "-f", str(COMPOSE_FILE), "--profile", "never", "config", "--format", "json"], text=True)
    return json.loads(config)["services"][service]["image"]


if __name__ == "__main__":
    # For shell steps: python3 deploy/test/ci_images.py nginx
    print(image(sys.argv[1]))
