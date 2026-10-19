#!/usr/bin/env python3
"""Focused Linux Docker endpoint and runtime-identity regressions; no daemon calls."""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import unittest
from unittest import mock

import docker_platform as platform


@unittest.skipUnless(sys.platform.startswith("linux"), "native Unix socket host tests require Linux")
class LinuxDockerPlatformTests(unittest.TestCase):
    def setUp(self):
        platform._reset_for_tests()
        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-docker-platform-")
        self.addCleanup(self.temporary.cleanup)
        self.socket_path = os.path.join(self.temporary.name, "engine.sock")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(self.listener.close)
        self.listener.bind(self.socket_path)
        self.endpoint = "unix://" + self.socket_path

    def tearDown(self):
        platform._reset_for_tests()

    @staticmethod
    def _context_json(endpoint):
        return json.dumps([{"Endpoints": {"docker": {"Host": endpoint}}}])

    def test_explicit_docker_host_pins_unix_endpoint_and_clears_child_overrides(self):
        environment = {
            "DOCKER_HOST": self.endpoint,
            "DOCKER_CONTEXT": "",
            "DOCKER_TLS_VERIFY": "1",
            "DOCKER_CERT_PATH": "/untrusted/certs",
        }
        target = platform.docker_target(environment)

        self.assertEqual(target["selection"], "DOCKER_HOST")
        self.assertIsNone(target["context_name"])
        self.assertEqual(target["endpoint"], self.endpoint)
        self.assertEqual(target["cli_options"], ("--host", self.endpoint))
        self.assertEqual(platform.docker_cli_prefix(environment), ["docker", "--host", self.endpoint])
        child = platform.docker_process_environment(environment)
        self.assertNotIn("DOCKER_HOST", child)
        self.assertNotIn("DOCKER_CONTEXT", child)
        self.assertEqual(child["DOCKER_TLS_VERIFY"], "1")

    def test_explicit_context_wins_over_host_override_and_metadata_lookup_strips_overrides(self):
        environment = {"DOCKER_CONTEXT": "local-dev", "DOCKER_HOST": "tcp://remote.invalid:2376"}
        with mock.patch.object(platform, "_run_text",
                               return_value=self._context_json(self.endpoint)) as run_text:
            target = platform.docker_target(environment)

        self.assertEqual(target["selection"], "DOCKER_CONTEXT")
        self.assertEqual(target["context_name"], "local-dev")
        self.assertEqual(target["cli_options"], ("--host", self.endpoint))
        command, lookup_environment = run_text.call_args.args
        self.assertEqual(command, ["docker", "context", "inspect", "local-dev"])
        self.assertNotIn("DOCKER_CONTEXT", lookup_environment)
        self.assertNotIn("DOCKER_HOST", lookup_environment)

    def test_active_context_is_resolved_and_endpoint_is_pinned(self):
        with mock.patch.object(platform, "_run_text", side_effect=[
            "wsl-local", self._context_json(self.endpoint)
        ]) as run_text:
            target = platform.docker_target({})

        self.assertEqual(target["selection"], "active-context")
        self.assertEqual(target["context_name"], "wsl-local")
        self.assertEqual(target["cli_options"], ("--host", self.endpoint))
        self.assertEqual(run_text.call_args_list[0].args[0], ["docker", "context", "show"])
        self.assertEqual(run_text.call_args_list[1].args[0], ["docker", "context", "inspect", "wsl-local"])

    def test_endpoint_selection_cannot_change_after_pinning(self):
        platform.docker_target({"DOCKER_HOST": self.endpoint})
        with self.assertRaisesRegex(platform.DockerPlatformError, "changed during"):
            platform.docker_target({"DOCKER_CONTEXT": "another-context"})

    def test_remote_and_ambiguous_unix_endpoints_are_refused(self):
        for endpoint in (
            "tcp://127.0.0.1:2375",
            "ssh://docker.example.invalid",
            "unix://localhost/tmp/engine.sock",
            "unix:///tmp/../run/docker.sock",
            "unix:///tmp/%2e%2e/run/docker.sock",
            "unix:///tmp/engine.sock?mode=rw",
            "unix:///tmp/engine.sock#fragment",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(platform.DockerPlatformError):
                platform._validate_local_unix_endpoint(endpoint)

    def test_existing_non_socket_unix_path_is_refused(self):
        path = os.path.join(self.temporary.name, "not-a-socket")
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("regular file")
        with self.assertRaisesRegex(platform.DockerPlatformError, "not a local socket"):
            platform._validate_local_unix_endpoint("unix://" + path)

    @unittest.skipIf(getattr(os, "geteuid", lambda: 1)() == 0, "runtime identity admission intentionally rejects root")
    def test_runtime_environment_matches_current_uid_gid_and_sets_linux_profile(self):
        uid, gid = os.getuid(), os.getgid()
        with mock.patch.dict(os.environ, {
            "FULLMAG_RUNTIME_UID": str(uid),
            "FULLMAG_RUNTIME_GID": str(gid),
        }, clear=False):
            runtime = platform.runtime_identity_record()
            environment = platform.runtime_environment({
                "FULLMAG_RUNTIME_UID": "1",
                "FULLMAG_RUNTIME_GID": "2",
                "FULLMAG_HOST_CERTIFICATE_DIR": "/untrusted/certificate-source",
            })

        self.assertEqual(runtime, {"profile": "linux-native-v1", "uid": uid, "gid": gid})
        self.assertEqual(environment["FULLMAG_RUNTIME_UID"], str(uid))
        self.assertEqual(environment["FULLMAG_RUNTIME_GID"], str(gid))
        self.assertEqual(environment["FULLMAG_HOST_PROFILE"], "linux-native-v1")
        self.assertEqual(environment["FULLMAG_HOST_CERTIFICATE_TARGET"], "/run/fullmag/host-admission")
        self.assertNotIn("FULLMAG_HOST_CERTIFICATE_DIR", environment)

    @unittest.skipIf(getattr(os, "geteuid", lambda: 1)() == 0, "runtime identity admission intentionally rejects root")
    def test_runtime_identity_rejects_ambient_user_switch(self):
        with mock.patch.dict(os.environ, {
            "FULLMAG_RUNTIME_UID": str(os.getuid() + 1),
            "FULLMAG_RUNTIME_GID": str(os.getgid()),
        }, clear=False):
            with self.assertRaisesRegex(ValueError, "must equal the current"):
                platform.runtime_identity()


if __name__ == "__main__":
    unittest.main(verbosity=2)
