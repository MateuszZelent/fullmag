import io
import json
from contextlib import contextmanager
from pathlib import Path
import tempfile
import urllib.error
import urllib.request
import unittest
from unittest.mock import patch

from local_runner import container_client


IMAGE = "sha256:" + "a" * 64
NEW_IMAGE = "sha256:" + "c" * 64
CONTAINER_ID = "b" * 64


def healthy_profiles(profiles=None, **fields):
    observed = container_client.ALLOWED_PROFILES if profiles is None else profiles
    return {"ok": True, "allowed_profiles": list(observed), **fields}


class FakeDocker:
    def __init__(self, storage, image=IMAGE):
        self.storage = Path(storage)
        self.secret = self.storage / "index" / "local-runner-container-secret.json"
        self.image = image
        self.available_images = {image}
        self.calls = []
        self.container_id = None
        self.inspection = None
        self.fail_create = False

    def _inspection(self, *, running=False, labels=None):
        return {
            "Id": self.container_id or CONTAINER_ID,
            "Name": "/" + container_client.CONTAINER_NAME,
            "Image": self.image,
            "Config": {
                "Hostname": container_client.CONTAINER_NAME,
                "Labels": labels or container_client._container_labels("alice"),
            },
            "State": {"Status": "running" if running else "created", "Running": running, "ExitCode": 0},
            "HostConfig": {
                "RestartPolicy": {"Name": "unless-stopped"},
                "PortBindings": {
                    f"{container_client.CONTAINER_PORT}/tcp": [
                        {"HostIp": "127.0.0.1", "HostPort": str(container_client.CONTAINER_PORT)}
                    ]
                },
            },
            "Mounts": [
                {"Type": "bind", "Source": str(self.storage), "Destination": "/storage", "RW": True},
                {
                    "Type": "bind",
                    "Source": str(self.secret),
                    "Destination": "/control/config.json",
                    "RW": False,
                },
                {
                    "Type": "bind",
                    "Source": "/var/run/docker.sock",
                    "Destination": "/var/run/docker.sock",
                    "RW": True,
                },
            ],
        }

    def __call__(self, arguments):
        arguments = list(arguments)
        self.calls.append(arguments)
        if arguments[:2] == ["image", "inspect"]:
            requested = arguments[2]
            if requested not in self.available_images:
                raise AssertionError("image was not available in fake Docker")
            return json.dumps([{"Id": requested}])
        if arguments[0] == "ps":
            return (self.container_id or "") + ("\n" if self.container_id else "")
        if arguments[0] == "create":
            if self.fail_create:
                raise container_client.ContainerClientError("fake create failure")
            self.container_id = CONTAINER_ID
            self.image = arguments[-1]
            self.inspection = self._inspection(running=False)
            return self.container_id
        if arguments[0] == "inspect":
            if self.inspection is None:
                self.inspection = self._inspection(running=False)
            return json.dumps([self.inspection])
        if arguments[0] == "start":
            self.inspection = self._inspection(running=True)
            return arguments[1]
        if arguments[0] == "stop":
            self.inspection = self._inspection(running=False)
            self.inspection["State"]["Status"] = "exited"
            return arguments[-1]
        if arguments[0] == "rm":
            self.container_id = None
            self.inspection = None
            return arguments[1]
        if arguments[0] in {"rm", "prune", "kill"}:
            raise AssertionError("container client must not remove, prune, or kill")
        raise AssertionError(f"unexpected Docker operation: {arguments}")


class FakeHTTPResponse:
    def __init__(self, value, *, content_length=None):
        self.body = json.dumps(value).encode("utf-8") if value is not None else b""
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit=-1):
        return self.body if limit < 0 else self.body[:limit]


class ContainerClientTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.storage = Path(temporary.name).resolve()
        self.layout = {"storage_root": str(self.storage)}

    def configure(self):
        return container_client.configure(self.layout, image_id=IMAGE, owner="alice")

    def test_configure_is_docker_free_and_keeps_token_out_of_public_metadata(self):
        with patch.object(container_client.coordinator, "docker", side_effect=AssertionError("no Docker")):
            public = self.configure()
        public_path = self.storage / "index" / "local-runner-container.json"
        secret_path = self.storage / "index" / "local-runner-container-secret.json"
        secret = json.loads(secret_path.read_text(encoding="utf-8"))
        self.assertEqual(container_client.CONFIG_SCHEMA, public["schema"])
        self.assertEqual("alice", public["operator"])
        self.assertEqual(str(self.storage), public["host_storage_root"])
        self.assertEqual("/storage", public["storage_root"])
        self.assertEqual(container_client.BUILD_CONFIG_PATH, public["build_config_path"])
        self.assertNotIn("token", public)
        self.assertNotIn(secret["token"], json.dumps(public))
        self.assertEqual(
            {key: value for key, value in public.items() if key != "profile_activation"},
            json.loads(public_path.read_text(encoding="utf-8")),
        )
        self.assertEqual("unverified", public["profile_activation"]["status"])
        self.assertEqual(public["allowed_profiles"], public["profile_activation"]["desired_allowed_profiles"])
        self.assertIsNone(public["profile_activation"]["observed_allowed_profiles"])
        self.assertEqual(container_client.SECRET_SCHEMA, secret["schema"])
        self.assertGreaterEqual(len(secret["token"]), 32)

    def test_configure_can_explicitly_enable_current_and_slepc_profiles_without_docker(self):
        initial = self.configure()
        self.assertEqual(list(container_client.ALLOWED_PROFILES), initial["allowed_profiles"])

        current = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True
        )
        self.assertEqual(list(container_client.CURRENT_CONTRACT_PROFILES), current["allowed_profiles"])
        secret_path = self.storage / "index" / "local-runner-container-secret.json"
        secret = json.loads(secret_path.read_text(encoding="utf-8"))
        self.assertEqual(current["allowed_profiles"], secret["allowed_profiles"])

        slepc = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_slepc_modal=True
        )
        self.assertEqual(list(container_client.SLEPC_MODAL_PROFILES), slepc["allowed_profiles"])
        self.assertIn("fem-cpu-slepc-runtime-v1", slepc["allowed_profiles"])

        # Enabling the older five-profile set must never silently downgrade an
        # already activated six-profile coordinator.
        preserved = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True
        )
        self.assertEqual(list(container_client.SLEPC_MODAL_PROFILES), preserved["allowed_profiles"])

    def test_runtime_v2_activation_preserves_profiles_identity_and_secret(self):
        initial = self.configure()
        secret_path = self.storage / "index" / "local-runner-container-secret.json"
        before = json.loads(secret_path.read_text())
        activated = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_slepc_runtime_v2=True)
        expected = initial["allowed_profiles"] + ["fem-cpu-slepc-runtime-v2"]
        self.assertEqual(activated["allowed_profiles"], expected)
        after = json.loads(secret_path.read_text())
        self.assertEqual(after["allowed_profiles"], expected)
        self.assertEqual(after["token"], before["token"])
        self.assertEqual(activated["image_id"], initial["image_id"])
        repeated = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_slepc_runtime_v2=True)
        self.assertEqual(repeated["allowed_profiles"], expected)
        self.assertNotIn("fem-cpu-slepc-runtime-v1", expected)
        upgraded = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True)
        self.assertEqual(set(upgraded["allowed_profiles"]),
                         set(container_client.CURRENT_CONTRACT_PROFILES) |
                         {"fem-cpu-slepc-runtime-v2"})

    def test_configure_rejects_mismatched_public_and_secret_profile_lists(self):
        self.configure()
        secret_path = self.storage / "index" / "local-runner-container-secret.json"
        secret = json.loads(secret_path.read_text(encoding="utf-8"))
        secret["allowed_profiles"] = list(container_client.CURRENT_CONTRACT_PROFILES)
        secret_path.write_text(json.dumps(secret), encoding="utf-8")
        with self.assertRaisesRegex(container_client.ContainerClientError, "profile lists differ"):
            container_client._load_config(self.layout, "alice")

    def test_configure_rejects_conflicting_profile_activation_flags(self):
        with self.assertRaisesRegex(container_client.ContainerClientError, "only one"):
            container_client.configure(
                self.layout,
                image_id=IMAGE,
                owner="alice",
                enable_current_contracts=True,
                enable_slepc_modal=True,
            )

    def test_configure_refuses_a_foreign_operator_without_overwriting(self):
        original = self.configure()
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id=IMAGE, owner="bob")
        current = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            {key: value for key, value in original.items() if key != "profile_activation"},
            current,
        )

    def test_configure_refuses_implicit_image_or_port_replacement(self):
        original = self.configure()
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id="sha256:" + "c" * 64, owner="alice")
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id=IMAGE, owner="alice", port=9876)
        current = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            {key: value for key, value in original.items() if key != "profile_activation"},
            current,
        )

    def test_start_creates_only_the_exact_coordinator_contract(self):
        self.configure()
        docker = FakeDocker(self.storage)
        with patch.object(container_client, "request", return_value=healthy_profiles()):
            result = container_client.start(self.layout, "alice", docker_call=docker)
        create = next(call for call in docker.calls if call[0] == "create")
        self.assertEqual("running", result["state"])
        self.assertTrue(result["running"])
        self.assertEqual(CONTAINER_ID, result["container_id"])
        self.assertEqual("active", result["profile_activation"]["status"])
        self.assertIn(["--name", container_client.CONTAINER_NAME], [create[index:index + 2] for index in range(len(create) - 1)])
        self.assertIn(["--restart", "unless-stopped"], [create[index:index + 2] for index in range(len(create) - 1)])
        self.assertIn(["--publish", f"127.0.0.1:{container_client.CONTAINER_PORT}:{container_client.CONTAINER_PORT}"], [create[index:index + 2] for index in range(len(create) - 1)])
        labels = [create[index + 1] for index, value in enumerate(create[:-1]) if value == "--label"]
        self.assertEqual(
            {f"{key}={value}" for key, value in container_client._container_labels("alice").items()},
            set(labels),
        )
        mounts = [create[index + 1] for index, value in enumerate(create[:-1]) if value == "--mount"]
        self.assertEqual(
            {
                f"type=bind,source={self.storage},target=/storage",
                f"type=bind,source={self.storage / 'index' / 'local-runner-container-secret.json'},target=/control/config.json,readonly",
                "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
            },
            set(mounts),
        )
        self.assertEqual(IMAGE, create[-1])
        self.assertIn(["--hostname", container_client.CONTAINER_NAME], [create[index:index + 2] for index in range(len(create) - 1)])
        self.assertFalse(any(value in {"-v", "--volume", "--env"} for value in create))
        self.assertNotIn("checkout", " ".join(create).casefold())
        self.assertNotIn("home", " ".join(create).casefold())

    def test_start_attests_foreign_named_container_before_any_start_or_remove(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(labels={"com.foreign.owner": "someone-else"})
        with self.assertRaises(container_client.ContainerClientError):
            container_client.start(self.layout, "alice", docker_call=docker)
        self.assertFalse(any(call[0] in {"start", "rm", "prune", "kill"} for call in docker.calls))

    def test_start_reuses_and_starts_an_attested_stopped_container(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=False)
        with patch.object(container_client, "request", return_value=healthy_profiles()):
            result = container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(CONTAINER_ID, result["container_id"])
        self.assertEqual("active", result["profile_activation"]["status"])
        self.assertIn(["start", CONTAINER_ID], docker.calls)
        self.assertFalse(any(call[0] in {"rm", "prune", "kill"} for call in docker.calls))

    def test_start_serializes_through_the_container_lifecycle_lock(self):
        self.configure()
        docker = FakeDocker(self.storage)
        entered = []

        @contextmanager
        def observed_lock(path, key, blocking=False):
            entered.append((Path(path), key, blocking))
            yield

        with patch.object(container_client, "file_lock", side_effect=observed_lock):
            with patch.object(container_client, "request", return_value=healthy_profiles()):
                container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(
            [(self.storage / "locks" / "local-runner-container.lock", "local runner container start", True)],
            entered,
        )

    def test_replace_requires_quiescent_health_before_stop(self):
        # Older coordinators discarded the service return value and called
        # an intentional, fully completed stop "failed" without an error.
        health = {'ok': False, 'worker_alive': False, 'worker_error': None,
                  'worker_state': 'failed', 'accepting_jobs': False,
                  'active_jobs': [], 'legacy_jobs': [], 'stop_requested': True,
                  'coordinator': {'state': 'stopped', 'stop_requested': True,
                                  'active_job_ids': [], 'last_error': None,
                                  'finished_at': '2026-09-11T18:36:12Z'}}
        container_client._assert_replacement_health(health)
        with self.assertRaisesRegex(container_client.ContainerClientError, 'must be drained'):
            container_client._assert_replacement_health({**health, 'ok': True,
                'coordinator': {'state': 'paused'}, 'retention_busy': False, 'retention_draining': False})
        container_client._assert_replacement_health({**health, 'retention_busy': False, 'retention_draining': True})
        for field, value in (('worker_alive', True), ('worker_error', 'failure'),
                             ('stop_requested', False), ('legacy_jobs', [{}]),
                             ('retention_busy', True), ('retention_busy', None)):
            with self.subTest(field=field):
                with self.assertRaises(container_client.ContainerClientError):
                    container_client._assert_replacement_health({**health, field: value})
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        docker.available_images.add(NEW_IMAGE)
        health = {"ok": True, "active_jobs": [{"job_id": "job-1"}], "coordinator": {"state": "stopped"}}
        with patch.object(container_client, "_open_url", return_value=FakeHTTPResponse(health)):
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        self.assertFalse(any(call[0] in {"stop", "rm"} for call in docker.calls))

    def test_explicit_abandonment_only_accepts_drained_unapplied_execution_preview(self):
        pid = 'plan-' + 'e' * 32
        raw = {'plan_id': pid, 'scope': 'execution', 'status': 'planning', 'applied': False}
        health = {'ok': True, 'worker_alive': False, 'worker_error': None, 'legacy_jobs': [],
                  'active_jobs': [], 'accepting_jobs': False, 'stop_requested': True,
                  'retention_busy': True, 'retention_draining': True,
                  'allowed_profiles': list(container_client.ALLOWED_PROFILES),
                  'coordinator': {'state': 'stopped', 'active_job_ids': [], 'last_error': None}}
        self.configure()
        directory = self.storage / 'index/retention-plans'
        directory.mkdir()
        record = directory / (pid + '.json')
        record.write_text(json.dumps(raw))
        policy = {'mode': 'preview'}
        def rpc(layout, owner, method, path, **kwargs):
            return health if path == '/health' else (policy if path.endswith('/policy') else raw)
        def docker_fixture():
            docker = FakeDocker(self.storage)
            docker.container_id = CONTAINER_ID
            docker.inspection = docker._inspection(running=True)
            docker.available_images.add(NEW_IMAGE)
            return docker
        with patch.object(container_client, 'request', side_effect=rpc):
            for field, value in (('status', 'running'), ('status', 'accepted'), ('scope', 'sources'), ('applied', True), ('applied', 0)):
                with self.subTest(field=field, value=value):
                    bad = {**raw, field: value};record.write_text(json.dumps(bad));docker = docker_fixture()
                    with self.assertRaises(container_client.ContainerClientError):
                        container_client.replace(self.layout, NEW_IMAGE, 'alice', call=docker, abandon_readonly_preview=pid)
                    self.assertFalse(any(call[0] in ('stop', 'rm') for call in docker.calls))
            record.write_text(json.dumps(raw))
            policy['mode'] = 'automatic'
            docker = docker_fixture()
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, 'alice', call=docker, abandon_readonly_preview=pid)
            self.assertFalse(any(call[0] in ('stop', 'rm') for call in docker.calls))
            policy['mode'] = 'preview'
            health['active_jobs'] = [{'job_id': 'active'}]
            docker = docker_fixture()
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, 'alice', call=docker, abandon_readonly_preview=pid)
            self.assertFalse(any(call[0] in ('stop', 'rm') for call in docker.calls))
            health['active_jobs'] = []
            gate = self.storage / 'locks/retention-admission'
            gate.mkdir()
            docker = docker_fixture()
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, 'alice', call=docker, abandon_readonly_preview=pid)
            self.assertFalse(any(call[0] in ('stop', 'rm') for call in docker.calls))
            gate.rmdir()
            operation = self.storage / 'index/retention-operations' / (pid + '.json')
            operation.parent.mkdir();operation.write_text('{}')
            docker = docker_fixture()
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, 'alice', call=docker, abandon_readonly_preview=pid)
            self.assertFalse(any(call[0] in ('stop', 'rm') for call in docker.calls))
            operation.unlink()
            docker = docker_fixture()
            def finish_during_stop(argv):
                value = docker(argv)
                if argv[0] == 'stop':
                    ready = {**raw, 'status': 'preview'}
                    ready.pop('applied')
                    record.write_text(json.dumps(ready))
                return value
            result = container_client.replace(self.layout, NEW_IMAGE, 'alice', call=finish_during_stop, abandon_readonly_preview=pid)
        self.assertEqual(NEW_IMAGE, result['image_id'])
        saved = json.loads(record.read_text())
        self.assertEqual('blocked', saved['status'])
        self.assertFalse(saved['applied'])
        self.assertTrue(saved['abandoned_readonly_preview'])

    def test_replace_rejects_idle_coordinator_even_when_queue_is_empty(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        docker.available_images.add(NEW_IMAGE)
        health = {"ok": True, "active_jobs": [], "coordinator": {"state": "idle"}}
        with patch.object(container_client, "_open_url", return_value=FakeHTTPResponse(health)):
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        self.assertFalse(any(call[0] in {"stop", "rm"} for call in docker.calls))

    def test_replace_verifies_new_image_before_any_container_mutation(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        with patch.object(container_client, "_open_url", side_effect=AssertionError("health must not run")):
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        self.assertFalse(any(call[0] in {"ps", "inspect", "stop", "rm", "start", "create"} for call in docker.calls))

    def test_replace_stops_removes_and_restarts_only_the_exact_attested_container(self):
        self.configure()
        token = json.loads(
            (self.storage / "index" / "local-runner-container-secret.json").read_text(encoding="utf-8")
        )["token"]
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        docker.available_images.add(NEW_IMAGE)
        health = healthy_profiles(
            active_jobs=[],
            coordinator={"state": "paused"},
        )
        with patch.object(container_client, "_open_url", return_value=FakeHTTPResponse(health)) as health_call:
            result = container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        self.assertEqual(NEW_IMAGE, result["image_id"])
        self.assertTrue(result["running"])
        self.assertEqual(["stop", "--time", "10", CONTAINER_ID], next(call for call in docker.calls if call[0] == "stop"))
        self.assertEqual(["rm", CONTAINER_ID], next(call for call in docker.calls if call[0] == "rm"))
        self.assertFalse(any("-f" in call or "-v" in call for call in docker.calls if call[0] == "rm"))
        public = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(NEW_IMAGE, public["image_id"])
        self.assertEqual(token, json.loads(
            (self.storage / "index" / "local-runner-container-secret.json").read_text(encoding="utf-8")
        )["token"])
        health_request = health_call.call_args.args[0]
        self.assertEqual("GET", health_request.method)
        self.assertEqual(public["endpoint"] + "/health", health_request.full_url)

    def test_replace_failure_after_remove_keeps_new_config_without_wrong_image_rollback(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        docker.available_images.add(NEW_IMAGE)
        docker.fail_create = True
        health = {"ok": True, "active_jobs": [], "coordinator": {"state": "stopped"}}
        with patch.object(container_client, "_open_url", return_value=FakeHTTPResponse(health)):
            with self.assertRaises(container_client.ContainerClientError):
                container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        public = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(NEW_IMAGE, public["image_id"])
        self.assertIsNone(docker.container_id)
        self.assertFalse(any(call[0] == "rm" and ("-f" in call or "-v" in call) for call in docker.calls))

    def test_status_absent_does_not_create_or_start(self):
        self.configure()
        docker = FakeDocker(self.storage)
        result = container_client.status(self.layout, "alice", docker_call=docker)
        self.assertEqual("absent", result["state"])
        self.assertIsNone(result["container_id"])
        self.assertEqual("unverified", result["profile_activation"]["status"])
        self.assertIsNone(result["profile_activation"]["observed_allowed_profiles"])
        self.assertFalse(any(call[0] in {"create", "start", "rm", "prune", "kill"} for call in docker.calls))

    def test_status_rejects_an_extra_mount(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection()
        docker.inspection["Mounts"].append(dict(docker.inspection["Mounts"][0], Destination="/checkout"))
        with patch.object(container_client, "request", side_effect=AssertionError("identity must precede health")) as request:
            with self.assertRaises(container_client.ContainerClientError):
                container_client.status(self.layout, "alice", docker_call=docker)
        request.assert_not_called()

    def test_status_attests_identity_then_reports_order_independent_observed_profiles(self):
        desired = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_slepc_modal=True
        )
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        health = healthy_profiles(
            list(reversed(desired["allowed_profiles"])),
            ok=False,
            worker_alive=False,
            worker_error="worker remains unavailable",
        )
        with patch.object(container_client, "request", return_value=health) as request:
            result = container_client.status(self.layout, "alice", docker_call=docker)
        self.assertEqual(1, request.call_count)
        self.assertEqual("GET", request.call_args.args[2])
        self.assertEqual("/health", request.call_args.args[3])
        self.assertEqual("active", result["profile_activation"]["status"])
        self.assertEqual(desired["allowed_profiles"], result["allowed_profiles"])
        self.assertEqual(desired["allowed_profiles"], result["profile_activation"]["desired_allowed_profiles"])
        self.assertEqual(set(desired["allowed_profiles"]), set(result["profile_activation"]["observed_allowed_profiles"]))
        self.assertEqual(health, result["health"])
        self.assertFalse(result["health"]["ok"])
        self.assertFalse(any(call[0] in {"start", "stop", "rm", "kill"} for call in docker.calls))

    def test_status_keeps_profile_activation_unverified_for_malformed_or_unavailable_health(self):
        self.configure()
        invalid_health = (
            None,
            [],
            {"ok": True},
            {"ok": True, "allowed_profiles": "fem-cpu-release"},
            healthy_profiles([]),
            healthy_profiles(list(container_client.ALLOWED_PROFILES) + ["unknown-profile"]),
            healthy_profiles(list(container_client.ALLOWED_PROFILES) + [container_client.ALLOWED_PROFILES[0]]),
        )
        for health in invalid_health:
            with self.subTest(health=health):
                docker = FakeDocker(self.storage)
                docker.container_id = CONTAINER_ID
                docker.inspection = docker._inspection(running=True)
                with patch.object(container_client, "request", return_value=health):
                    result = container_client.status(self.layout, "alice", docker_call=docker)
                self.assertEqual("unverified", result["profile_activation"]["status"])
                self.assertIsNone(result["profile_activation"]["observed_allowed_profiles"])

        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        with patch.object(
            container_client,
            "request",
            side_effect=container_client.ContainerClientError("health unavailable"),
        ):
            result = container_client.status(self.layout, "alice", docker_call=docker)
        self.assertEqual("unverified", result["profile_activation"]["status"])
        self.assertIsNone(result["profile_activation"]["observed_allowed_profiles"])
        self.assertIn("health unavailable", result["profile_activation"]["reason"])
        self.assertFalse(result["health"]["ok"])

    def test_status_reports_valid_but_different_running_profiles_as_mismatch(self):
        initial = self.configure()
        desired = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True
        )
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        with patch.object(
            container_client,
            "request",
            return_value=healthy_profiles(initial["allowed_profiles"]),
        ):
            result = container_client.status(self.layout, "alice", docker_call=docker)
        self.assertNotEqual(set(initial["allowed_profiles"]), set(desired["allowed_profiles"]))
        self.assertEqual("mismatch", result["profile_activation"]["status"])
        self.assertEqual(
            set(initial["allowed_profiles"]),
            set(result["profile_activation"]["observed_allowed_profiles"]),
        )
        self.assertIn("explicit container replacement", result["profile_activation"]["reason"])
        self.assertFalse(any(call[0] in {"start", "stop", "rm", "kill"} for call in docker.calls))

    def test_configure_does_not_activate_profiles_or_implicitly_replace_a_running_coordinator(self):
        with patch.object(container_client.coordinator, "docker", side_effect=AssertionError("configure must not contact Docker")):
            initial = self.configure()
            desired = container_client.configure(
                self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True
            )
        self.assertEqual("unverified", desired["profile_activation"]["status"])
        self.assertIsNone(desired["profile_activation"]["observed_allowed_profiles"])
        self.assertNotEqual(set(initial["allowed_profiles"]), set(desired["allowed_profiles"]))

        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        health = healthy_profiles(
            list(initial["allowed_profiles"]),
            active_jobs=[{"job_id": "queued-job", "state": "queued"}],
        )
        with patch.object(container_client, "request", return_value=health):
            with self.assertRaisesRegex(
                container_client.ContainerClientError,
                "profile activation mismatch.*pause and drain.*explicit container replacement",
            ):
                container_client.start(self.layout, "alice", docker_call=docker)
        self.assertFalse(
            any(call[0] in {"start", "stop", "rm", "create", "kill", "prune"} for call in docker.calls)
        )

    def test_start_of_stopped_container_does_not_claim_unobserved_desired_profiles(self):
        initial = self.configure()
        desired = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_slepc_runtime_v2=True
        )
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=False)
        with patch.object(container_client, "request", return_value=healthy_profiles(initial["allowed_profiles"])):
            with self.assertRaisesRegex(container_client.ContainerClientError, "profile activation mismatch"):
                container_client.start(self.layout, "alice", docker_call=docker)
        self.assertNotEqual(set(initial["allowed_profiles"]), set(desired["allowed_profiles"]))
        self.assertIn(["start", CONTAINER_ID], docker.calls)
        self.assertFalse(any(call[0] in {"stop", "rm", "create", "kill", "prune"} for call in docker.calls))

    def test_start_retries_bounded_health_until_profile_list_is_observed(self):
        self.configure()
        docker = FakeDocker(self.storage)
        with patch.object(container_client, "request", side_effect=[{"ok": True}, healthy_profiles()]) as request:
            with patch.object(container_client.time, "sleep", return_value=None):
                result = container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(2, request.call_count)
        self.assertEqual("active", result["profile_activation"]["status"])
        self.assertEqual(list(container_client.ALLOWED_PROFILES), result["profile_activation"]["desired_allowed_profiles"])

    def test_start_fails_unverified_after_bounded_health_retries_without_cleanup(self):
        self.configure()
        docker = FakeDocker(self.storage)
        with patch.object(container_client, "request", return_value={"ok": True}) as request:
            with patch.object(container_client.time, "sleep", return_value=None):
                with self.assertRaisesRegex(
                    container_client.ContainerClientError,
                    "remains unverified after 3 bounded authenticated health checks",
                ):
                    container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(container_client.STARTUP_HEALTH_ATTEMPTS, request.call_count)
        self.assertIn(["start", CONTAINER_ID], docker.calls)
        self.assertFalse(any(call[0] in {"stop", "rm", "kill", "prune"} for call in docker.calls))

    def test_explicit_replace_applies_new_profile_list_only_after_quiescent_replacement(self):
        initial = self.configure()
        desired = container_client.configure(
            self.layout, image_id=IMAGE, owner="alice", enable_current_contracts=True
        )
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection(running=True)
        docker.available_images.add(NEW_IMAGE)
        old_health = healthy_profiles(
            initial["allowed_profiles"],
            active_jobs=[],
            coordinator={"state": "paused"},
        )
        new_health = healthy_profiles(
            list(reversed(desired["allowed_profiles"])),
            active_jobs=[],
            coordinator={"state": "paused"},
        )
        responses = [FakeHTTPResponse(old_health), FakeHTTPResponse(new_health)]
        with patch.object(container_client, "_open_url", side_effect=responses):
            result = container_client.replace(self.layout, NEW_IMAGE, "alice", call=docker)
        self.assertEqual(NEW_IMAGE, result["image_id"])
        self.assertEqual("active", result["profile_activation"]["status"])
        self.assertEqual(set(desired["allowed_profiles"]), set(result["profile_activation"]["observed_allowed_profiles"]))
        self.assertIn(["stop", "--time", "10", CONTAINER_ID], docker.calls)
        self.assertIn(["rm", CONTAINER_ID], docker.calls)

    def test_authenticated_get_and_graceful_stop_use_the_secret_without_printing_it(self):
        public = self.configure()
        secret = json.loads(
            (self.storage / "index" / "local-runner-container-secret.json").read_text(encoding="utf-8")
        )
        responses = [FakeHTTPResponse({"ok": True}), FakeHTTPResponse({"stopped": True})]
        with patch.object(container_client, "_open_url", side_effect=responses) as urlopen:
            self.assertEqual({"ok": True}, container_client.request(self.layout, "alice", "GET", "/health"))
            self.assertEqual({"stopped": True}, container_client.stop(self.layout, "alice"))
        get_request = urlopen.call_args_list[0].args[0]
        stop_request = urlopen.call_args_list[1].args[0]
        self.assertEqual("GET", get_request.method)
        self.assertEqual("POST", stop_request.method)
        self.assertEqual(public["endpoint"] + "/health", get_request.full_url)
        self.assertEqual(public["endpoint"] + "/stop", stop_request.full_url)
        self.assertEqual("Bearer " + secret["token"], get_request.get_header("Authorization"))
        self.assertEqual("Bearer " + secret["token"], stop_request.get_header("Authorization"))
        self.assertEqual({}, json.loads(stop_request.data.decode("utf-8")))
        self.assertNotIn(secret["token"], repr(public))

    def test_local_http_opener_disables_proxies_and_never_follows_redirects(self):
        proxy_handlers = [
            handler for handler in container_client._LOCAL_OPENER.handlers if isinstance(handler, urllib.request.ProxyHandler)
        ]
        # An empty ProxyHandler is intentionally omitted by build_opener; its
        # presence in the default opener is what would re-enable environment
        # proxies.  The resulting opener therefore has no proxy handler.
        self.assertEqual([], proxy_handlers)
        self.assertTrue(
            any(isinstance(handler, container_client._NoRedirectHandler) for handler in container_client._LOCAL_OPENER.handlers)
        )
        self.configure()
        redirect = urllib.error.HTTPError(
            "http://127.0.0.1:8765/health",
            302,
            "redirect",
            {"Location": "http://outside.example.invalid/health"},
            io.BytesIO(),
        )
        with patch.object(container_client._LOCAL_OPENER, "open", side_effect=redirect) as opened:
            with self.assertRaises(container_client.ContainerClientError):
                container_client.request(self.layout, "alice", "GET", "/health")
        self.assertEqual(1, opened.call_count)

    def test_request_rejects_an_oversized_response_before_consuming_it(self):
        self.configure()
        response = FakeHTTPResponse(None, content_length=container_client.MAX_RESPONSE_BYTES + 1)
        with patch.object(container_client, "_open_url", return_value=response):
            with self.assertRaises(container_client.ContainerClientError):
                container_client.request(self.layout, "alice", "GET", "/health")

    def test_submit_post_has_a_bounded_longer_timeout_without_retry(self):
        self.configure()
        response = FakeHTTPResponse({"ok": True})
        with patch.object(container_client, "_open_url", return_value=response) as opened:
            container_client.request(self.layout, "alice", "GET", "/health")
            container_client.request(self.layout, "alice", "POST", "/jobs", {})
        self.assertEqual(
            [container_client.HTTP_TIMEOUT_SECONDS, container_client.HTTP_SUBMIT_TIMEOUT_SECONDS],
            [call.args[1] for call in opened.call_args_list],
        )
        with patch.object(container_client, "_open_url", side_effect=urllib.error.URLError("ambiguous")) as failed:
            with self.assertRaises(container_client.ContainerClientError):
                container_client.request(self.layout, "alice", "POST", "/jobs", {})
        self.assertEqual(1, failed.call_count)

    def test_request_rejects_non_get_post_and_path_traversal(self):
        self.configure()
        with self.assertRaises(container_client.ContainerClientError):
            container_client.request(self.layout, "alice", "PUT", "/health")
        with self.assertRaises(container_client.ContainerClientError):
            container_client.request(self.layout, "alice", "GET", "/jobs/../secret")


if __name__ == "__main__":
    unittest.main()
