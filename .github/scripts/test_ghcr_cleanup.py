"""Tests for the version selection in ghcr_cleanup.py: python3 -m unittest discover -s .github/scripts"""

import unittest
from datetime import datetime, timedelta, timezone

from ghcr_cleanup import MIN_AGE, plan

NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)
OLD = NOW - MIN_AGE - timedelta(hours=1)


def version(digest, *tags, created=OLD):
    return {
        "id": hash(digest) & 0xFFFFFF,
        "name": f"sha256:{digest}",
        "created_at": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "metadata": {"container": {"tags": list(tags)}},
    }


def referrer_tag(digest):
    return f"sha256-{digest}"


def names(versions):
    return sorted(v["name"] for v in versions)


class PlanTest(unittest.TestCase):
    def run_plan(self, versions, children=None):
        children = children or {}
        return plan(versions, lambda d: children.get(d, []), NOW)

    def test_tagged_index_keeps_its_platform_manifests(self):
        versions = [version("idx", "edge"), version("amd"), version("arm")]
        keep, delete = self.run_plan(versions, {"sha256:idx": ["sha256:amd", "sha256:arm"]})
        self.assertEqual(names(keep), ["sha256:amd", "sha256:arm", "sha256:idx"])
        self.assertEqual(delete, [])

    def test_replaced_edge_build_is_deleted(self):
        versions = [
            version("new", "edge"), version("new-amd"), version("new-arm"),
            version("old"), version("old-amd"), version("old-arm"),
        ]
        children = {
            "sha256:new": ["sha256:new-amd", "sha256:new-arm"],
            "sha256:old": ["sha256:old-amd", "sha256:old-arm"],
        }
        keep, delete = self.run_plan(versions, children)
        self.assertEqual(names(keep), ["sha256:new", "sha256:new-amd", "sha256:new-arm"])
        self.assertEqual(names(delete), ["sha256:old", "sha256:old-amd", "sha256:old-arm"])

    def test_registry_attestations_are_deleted_even_when_tagged(self):
        versions = [
            version("idx", "1.0.1", "latest"), version("amd"),
            version("ref", referrer_tag("ab" * 32)), version("att"),
        ]
        children = {"sha256:idx": ["sha256:amd"], "sha256:ref": ["sha256:att"]}
        keep, delete = self.run_plan(versions, children)
        self.assertEqual(names(keep), ["sha256:amd", "sha256:idx"])
        self.assertEqual(names(delete), ["sha256:att", "sha256:ref"])

    def test_recent_versions_are_left_alone(self):
        # A publish still pushing its platform manifests before the index takes the tag.
        recent = NOW - MIN_AGE + timedelta(minutes=1)
        versions = [version("amd", created=recent), version("stale")]
        keep, delete = self.run_plan(versions)
        self.assertEqual(keep, [])
        self.assertEqual(names(delete), ["sha256:stale"])

    def test_manifest_shared_with_an_untagged_index_is_kept(self):
        versions = [version("tagged", "1.0.0"), version("untagged"), version("shared"), version("only-old")]
        children = {
            "sha256:tagged": ["sha256:shared"],
            "sha256:untagged": ["sha256:shared", "sha256:only-old"],
        }
        keep, delete = self.run_plan(versions, children)
        self.assertEqual(names(keep), ["sha256:shared", "sha256:tagged"])
        self.assertEqual(names(delete), ["sha256:only-old", "sha256:untagged"])

    def test_missing_tag_metadata_fails_instead_of_counting_as_untagged(self):
        broken = version("idx", "edge")
        del broken["metadata"]
        with self.assertRaises(KeyError):
            self.run_plan([broken])

    def test_failed_manifest_read_fails_instead_of_dropping_children(self):
        def fail(_digest):
            raise OSError("registry unavailable")

        with self.assertRaises(OSError):
            plan([version("idx", "edge"), version("amd")], fail, NOW)


if __name__ == "__main__":
    unittest.main()
