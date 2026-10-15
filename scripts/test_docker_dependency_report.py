#!/usr/bin/env python3
"""Focused interpreted checks for scripts/docker_dependency_report.py."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import docker_dependency_report as report  # noqa: E402


DOCKERFILE = r"""ARG FULLMAG_CUDA_BASE_IMAGE="nvidia/cuda:12.4.1-devel-ubuntu20.04"
ARG FULLMAG_CUDA_BASE_IMAGE_DIGEST=""
FROM ${FULLMAG_CUDA_BASE_IMAGE} AS deps
ENV CMAKE_VERSION=3.30.5
ENV RUST_TOOLCHAIN=nightly
ENV MFEM_REF=v4.10
ENV MFEM_SOURCE_COMMIT=d964264cdb9a13e94a201b6c236c7721e0c8765f
ENV LIBCEED_REF=v0.12.0
ENV LIBCEED_SOURCE_COMMIT=4018a20a98d451fac24765d3ddb936861647ce8d
ENV HYPRE_REF=v3.1.0
ENV HYPRE_SOURCE_COMMIT=9dc9e18aed6a945a95f966e57daacfb1c269f6ec
ENV PETSC_REF=v3.24.6
ENV PETSC_SOURCE_COMMIT=1467453aedb62826efc970ceafc4bd6dab8229ab
ENV SLEPC_REF=v3.24.3
ENV SLEPC_SOURCE_COMMIT=4c754d7d3ae067837670828a304512798334fb3a
ENV UMPIRE_REF=v2024.07.0
ENV UMPIRE_SOURCE_COMMIT=abd729f40064175e999a83d11d6b073dac4c01d2
ARG NODE_VERSION=24.18.0
ARG NODE_SHA256_AMD64=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ARG NODE_SHA256_ARM64=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
ARG PYTHON_VERSION=3.10.21
ARG PYTHON_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
ENV NODE_VERSION=${NODE_VERSION}
ENV PYTHON_VERSION=${PYTHON_VERSION}
ENV PNPM_VERSION=10.8.1
ENV FULLMAG_CUDA_ARCHITECTURES=80-real;89-real
ENV FULLMAG_HYPRE_GPU_ARCHITECTURES="60 70"
ENV FULLMAG_HYPRE_MEMORY_VARIANT=baseline
RUN curl https://sh.rustup.rs | bash -s -- -y --default-toolchain nightly
"""


class DockerDependencyReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.dockerfile = self.root / "Dockerfile"
        self.dockerfile.write_text(DOCKERFILE, encoding="utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_report_reuses_declared_manifest_shape_without_version_copy(self) -> None:
        value = report.build_report(self.dockerfile)
        self.assertEqual(value["schema"], report.REPORT_SCHEMA)
        self.assertEqual(value["manifest_schema"], report.MANIFEST_SCHEMA)
        declared = value["declared"]
        self.assertEqual(declared["base_image"]["reference"], "nvidia/cuda:12.4.1-devel-ubuntu20.04")
        self.assertEqual(declared["cuda"]["version"], "12.4.1")
        self.assertEqual(declared["dependencies"]["mfem"]["commit"], "d964264cdb9a13e94a201b6c236c7721e0c8765f")
        self.assertEqual(declared["dependencies"]["libceed"]["commit"], "4018a20a98d451fac24765d3ddb936861647ce8d")
        self.assertEqual(declared["tools"]["node"], "24.18.0")
        self.assertEqual(declared["tools"]["python"], "3.10.21")
        self.assertEqual(declared["tools"]["pnpm"], "10.8.1")
        self.assertEqual(value["pinning"]["tools"]["rust"], "channel-only")
        self.assertEqual(value["source"]["sha256"], hashlib.sha256(self.dockerfile.read_bytes()).hexdigest())

    def test_conflicting_declaration_fails_closed(self) -> None:
        conflicting = self.root / "conflicting.Dockerfile"
        conflicting.write_text(DOCKERFILE + "\nENV CMAKE_VERSION=9.9.9\n", encoding="utf-8")
        with self.assertRaises(report.ReportError):
            report.build_report(conflicting)

    def test_canonical_installed_manifest_is_preserved_as_operator_evidence(self) -> None:
        manifest = self.root / "installed.json"
        expected = {
            "schema": report.MANIFEST_SCHEMA,
            "declared": {},
            "actual": {"source_commits": {
                "mfem": "d964264cdb9a13e94a201b6c236c7721e0c8765f",
                "libceed": "4018a20a98d451fac24765d3ddb936861647ce8d",
                "hypre": "9dc9e18aed6a945a95f966e57daacfb1c269f6ec",
                "petsc": "1467453aedb62826efc970ceafc4bd6dab8229ab",
                "slepc": "4c754d7d3ae067837670828a304512798334fb3a",
            }},
            "latest": {"status": "not-queried"},
        }
        manifest.write_text(json.dumps(expected), encoding="utf-8")
        value = report.build_report(self.dockerfile, manifest)
        self.assertEqual(value["installed_manifest"], expected)
        self.assertEqual(value["installed_comparison"]["mfem"]["status"], "match")
        self.assertEqual(value["installed_comparison"]["petsc"]["status"], "match")
        self.assertEqual(value["manifest_schema"], report.MANIFEST_SCHEMA)

    def test_incomplete_installed_manifest_is_rejected(self) -> None:
        manifest = self.root / "incomplete.json"
        manifest.write_text(json.dumps({
            "schema": report.MANIFEST_SCHEMA,
            "actual": {"source_commits": {"mfem": "d964264cdb9a13e94a201b6c236c7721e0c8765f"}},
        }), encoding="utf-8")
        with self.assertRaises(report.ReportError):
            report.build_report(self.dockerfile, manifest)

    def test_update_check_uses_stable_values_and_keeps_prereleases_out(self) -> None:
        value = report.build_report(self.dockerfile)

        def fake_json(url: str, timeout: float):
            if "nodejs.org" in url:
                return [{"version": "v99.0.0-rc.1"}, {"version": "v24.18.0"}]
            if "python/cpython/tags" in url:
                return [{"name": "v99.0.0-rc1"}, {"name": "v3.14.0"}]
            if "repository/tags" in url:
                return [{"name": "v99.0.0-rc1"}, {"name": "v3.24.8"}]
            if "gitlab.com" in url:
                return []
            if "pnpm/pnpm" in url:
                return {"tag_name": "v10.9.0", "prerelease": False}
            if "LLNL/Umpire" in url:
                return {"tag_name": "v2024.09.0", "prerelease": False}
            return {"tag_name": "v5.0.0", "prerelease": False}

        rust_channel = (
            '[pkg.cargo]\nversion = "0.1.99"\n'
            '[pkg.rust]\nversion = "1.90.0 (f9edccde0 2025-09-22)"\n'
            'git_commit_hash = "f9edccde0e8f3c2a4b5c6d7e8f90123456789abcd"\n'
            'date = "2025-09-22"\n'
        )
        with mock.patch.object(report, "_fetch_json", side_effect=fake_json):
            with mock.patch.object(report, "_fetch_text", return_value=rust_channel):
                latest = report.check_updates(value, timeout=0.01)
        self.assertEqual(latest["results"]["node"]["latest_stable"], "v24.18.0")
        self.assertEqual(latest["results"]["python"]["latest_stable"], "v3.14.0")
        self.assertEqual(latest["results"]["mfem"]["declared"], "v4.10")
        self.assertEqual(latest["results"]["mfem"]["comparison"], "newer-stable-available")
        self.assertEqual(latest["results"]["petsc"]["latest_stable"], "v3.24.8")
        self.assertEqual(latest["results"]["petsc"]["fallback_source"]["kind"], "gitlab_tags")
        self.assertEqual(latest["results"]["slepc"]["latest_stable"], "v3.24.8")
        self.assertEqual(latest["results"]["pnpm"]["latest_stable"], "v10.9.0")
        self.assertEqual(latest["results"]["umpire"]["latest_stable"], "v2024.09.0")
        self.assertEqual(latest["results"]["rust"]["latest_stable"], "1.90.0")
        self.assertEqual(latest["results"]["rust"]["comparison"], "channel-not-comparable")
        self.assertEqual(latest["results"]["cuda"]["status"], "not-queried")

    def test_upstream_reader_bounds_payload_and_timeout(self) -> None:
        class OversizedResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def read(self, limit):
                self.limit = limit
                return b"x" * limit

        response = OversizedResponse()
        with mock.patch.object(report.urllib.request, "urlopen", return_value=response) as opener:
            with self.assertRaises(report.ReportError):
                report._request("https://example.invalid", 0.25, "application/json")
        self.assertEqual(response.limit, report.MAX_RESPONSE_BYTES + 1)
        self.assertEqual(opener.call_args.kwargs["timeout"], 0.25)
        with self.assertRaises(report.ReportError):
            report._request("https://example.invalid", report.MAX_TIMEOUT_SECONDS + 1, "application/json")

    def test_cli_emits_json_without_network_or_side_effects(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = report.main(["--dockerfile", str(self.dockerfile), "--compact"])
        self.assertEqual(exit_code, 0)
        value = json.loads(output.getvalue())
        self.assertEqual(value["schema"], report.REPORT_SCHEMA)


if __name__ == "__main__":
    unittest.main()
