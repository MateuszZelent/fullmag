"""Regression tests for the rendered Compose build-mount audit."""
import importlib.util
from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
AUDITOR_PATH = (
    REPOSITORY_ROOT
    / ".agents"
    / "skills"
    / "fullmag-docker-build"
    / "scripts"
    / "audit_build_mounts.py"
)
SPEC = importlib.util.spec_from_file_location("audit_build_mounts", AUDITOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load mount auditor at {AUDITOR_PATH}")
AUDITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDITOR)


CHECKOUT = "C:/selected/fullmag"
PROJECT = "fullmag-worktree-test"
HMR_ROOT = "/state/development/workspace/apps/control-room"
HMR_INPUTS = ("app", "src", "public", "scripts")


def volume(source, target):
    return {
        "type": "volume",
        "source": source,
        "target": target,
        "read_only": False,
    }


def bind(source, target, *, read_only=True):
    return {
        "type": "bind",
        "source": source,
        "target": target,
        "read_only": read_only,
    }


def compose_document(*, frontend_source_target="/run/fullmag/source", overlays=None):
    if overlays is None:
        overlays = [
            bind(
                f"{CHECKOUT}/apps/control-room/{name}",
                f"{HMR_ROOT}/{name}",
            )
            for name in HMR_INPUTS
        ]
    return {
        "name": PROJECT,
        "volumes": {
            "backend-cache-build": {},
            "backend-cache-package": {},
            "frontend-development": {},
        },
        "services": {
            "backend": {
                "read_only": True,
                "environment": {
                    "FULLMAG_PACKAGE_PROVENANCE": "/build/control/provenance.json",
                },
                "volumes": [
                    volume("backend-cache-build", "/build"),
                    volume("backend-cache-package", "/opt/fullmag/package"),
                    bind(f"{CHECKOUT}", "/opt/fullmag/source"),
                ],
            },
            "frontend": {
                "read_only": True,
                "environment": {},
                "volumes": [
                    volume("frontend-development", "/state/development"),
                    bind(CHECKOUT, frontend_source_target),
                    *overlays,
                ],
            },
        },
    }


class FrontendSourceOverlayTests(unittest.TestCase):
    def assert_audit_passes(self, document):
        result = AUDITOR.audit(document, PROJECT)
        self.assertEqual(result["status"], "PASS", result["problems"])

    def assert_audit_fails(self, document, expected_problem):
        result = AUDITOR.audit(document, PROJECT)
        self.assertEqual(result["status"], "FAIL", result)
        self.assertTrue(
            any(expected_problem in problem for problem in result["problems"]),
            result["problems"],
        )

    def test_exact_hmr_roots_map_to_selected_checkout_children(self):
        self.assert_audit_passes(compose_document())

    def test_frontend_legacy_source_target_is_supported(self):
        self.assert_audit_passes(
            compose_document(frontend_source_target="/opt/fullmag/source")
        )

    def test_frontend_source_at_both_current_and_legacy_targets_is_rejected(self):
        document = compose_document()
        document["services"]["frontend"]["volumes"].append(
            bind(CHECKOUT, "/opt/fullmag/source")
        )
        self.assert_audit_fails(document, "selected source must be exactly one readonly bind")

    def test_backend_source_remains_at_canonical_target(self):
        document = compose_document()
        document["services"]["backend"]["volumes"][2]["target"] = "/run/fullmag/source"
        self.assert_audit_fails(document, "backend: selected source must be exactly one readonly bind")

    def test_hmr_overlay_from_another_checkout_is_rejected(self):
        document = compose_document()
        app_overlay = document["services"]["frontend"]["volumes"][2]
        app_overlay["source"] = "C:/other/fullmag/apps/control-room/app"
        self.assert_audit_fails(document, "non-volume mount overlays a build directory")

    def test_writable_hmr_child_bind_is_rejected(self):
        document = compose_document()
        app_overlay = document["services"]["frontend"]["volumes"][2]
        app_overlay["read_only"] = False
        self.assert_audit_fails(document, "writable host bind")

    def test_next_cache_overlay_is_not_a_permitted_hmr_input(self):
        document = compose_document()
        document["services"]["frontend"]["volumes"].append(
            bind(
                f"{CHECKOUT}/apps/control-room/.next/cache",
                f"{HMR_ROOT}/.next/cache",
            )
        )
        self.assert_audit_fails(document, "non-volume mount overlays a build directory")


if __name__ == "__main__":
    unittest.main()
