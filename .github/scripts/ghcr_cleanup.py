#!/usr/bin/env python3
"""Deletes container package versions that no image tag needs (the "Clean up images" workflow).

Kept: every version with a real tag (edge, X.Y.Z, X.Y, X, latest) and the per-platform manifests its
image index lists. Deleted, once older than MIN_AGE: everything else, which is
- replaced edge builds: the index that lost the tag and its platform manifests;
- attestations pushed to the registry before the publish job stopped doing that, with the
  sha256-<digest> tags that link them to an image. GitHub's attestation store keeps a copy, which
  `gh attestation verify` reads by default.

Environment: GITHUB_TOKEN (packages: write, or a token with read:packages for a dry run), OWNER,
PACKAGE, DRY_RUN ("true" lists what would go without deleting).

Anything unexpected (a failed request, a version without tag metadata, an index without manifests)
raises instead of being read as "no tags" or "no children": either would delete a live manifest.
"""

import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

API = "https://api.github.com"
REGISTRY = "https://ghcr.io"
# Older than any publish run, so a build still pushing its platform manifests is left alone.
MIN_AGE = timedelta(days=1)
# The tag schema GHCR uses for attestations, as it has no OCI referrers API.
REFERRER_TAG = re.compile(r"^sha256-[0-9a-f]{64}$")
MANIFEST_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)


def request(url, token, method="GET", accept="application/vnd.github+json", auth="Bearer") -> Any:
    req = urllib.request.Request(url, method=method)
    req.add_header("Accept", accept)
    req.add_header("Authorization", f"{auth} {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(req, timeout=30) as res:
        body = res.read()
        return json.loads(body) if body else None


def list_versions(owner, package, token):
    versions, page = [], 1
    while True:
        batch = request(
            f"{API}/users/{owner}/packages/container/{package}/versions?per_page=100&page={page}", token
        )
        if not batch:
            return versions
        versions += batch
        page += 1


def registry_token(owner, package, token):
    basic = base64.b64encode(f"{owner}:{token}".encode()).decode()
    scope = urllib.parse.quote(f"repository:{owner}/{package}:pull")
    return request(f"{REGISTRY}/token?scope={scope}&service=ghcr.io", basic, auth="Basic")["token"]


def children(owner, package, token, digest):
    """Digests an image index lists; none for a single manifest."""
    manifest = request(
        f"{REGISTRY}/v2/{owner}/{package}/manifests/{digest}", token, accept=", ".join(MANIFEST_TYPES)
    )
    return [m["digest"] for m in manifest.get("manifests", [])]


def plan(versions, children_of, now):
    """Splits versions into (keep, delete) lists. children_of(digest) lists an index's manifests."""
    keep = set()
    for v in versions:
        tags = v["metadata"]["container"]["tags"]
        if any(not REFERRER_TAG.match(t) for t in tags):
            keep.add(v["name"])
            keep.update(children_of(v["name"]))
    delete = [
        v
        for v in versions
        if v["name"] not in keep
        and now - datetime.fromisoformat(v["created_at"].replace("Z", "+00:00")) >= MIN_AGE
    ]
    return [v for v in versions if v["name"] in keep], delete


def main():
    token, owner, package = os.environ["GITHUB_TOKEN"], os.environ["OWNER"], os.environ["PACKAGE"]
    dry_run = os.environ.get("DRY_RUN", "true") != "false"
    versions = list_versions(owner, package, token)
    reg = registry_token(owner, package, token)
    keep, delete = plan(versions, lambda d: children(owner, package, reg, d), datetime.now(timezone.utc))
    print(f"{len(versions)} versions: keeping {len(keep)}, deleting {len(delete)}" + (" (dry run)" if dry_run else ""))
    for v in delete:
        tags = ",".join(v["metadata"]["container"]["tags"]) or "untagged"
        print(f"  {v['id']}  {v['created_at']}  {v['name']}  {tags}")
        if not dry_run:
            request(f"{API}/users/{owner}/packages/container/{package}/versions/{v['id']}", token, method="DELETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
