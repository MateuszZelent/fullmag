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
        self.assertEqual(public, json.loads(public_path.read_text(encoding="utf-8")))
        self.assertEqual(container_client.SECRET_SCHEMA, secret["schema"])
        self.assertGreaterEqual(len(secret["token"]), 32)

    def test_configure_refuses_a_foreign_operator_without_overwriting(self):
        original = self.configure()
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id=IMAGE, owner="bob")
        current = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(original, current)

    def test_configure_refuses_implicit_image_or_port_replacement(self):
        original = self.configure()
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id="sha256:" + "c" * 64, owner="alice")
        with self.assertRaises(container_client.ContainerClientError):
            container_client.configure(self.layout, image_id=IMAGE, owner="alice", port=9876)
        current = json.loads(
            (self.storage / "index" / "local-runner-container.json").read_text(encoding="utf-8")
        )
        self.assertEqual(original, current)

    def test_start_creates_only_the_exact_coordinator_contract(self):
        self.configure()
        docker = FakeDocker(self.storage)
        result = container_client.start(self.layout, "alice", docker_call=docker)
        create = next(call for call in docker.calls if call[0] == "create")
        self.assertEqual("running", result["state"])
        self.assertTrue(result["running"])
        self.assertEqual(CONTAINER_ID, result["container_id"])
        self.assertIn(["--name", container_client.CONTAINER_NAME], [create[index:index + 2] for index in range(len(create) - 1)])
        self.assertIn(["--restart", "unless-stopped"], [create[index:index + 2] for index in range(len(create) - 1)])
        self.assertIn(["--publish", "127.0.0.1:8765:8765"], [create[index:index + 2] for index in range(len(create) - 1)])
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
        result = container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(CONTAINER_ID, result["container_id"])
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
            container_client.start(self.layout, "alice", docker_call=docker)
        self.assertEqual(
            [(self.storage / "locks" / "local-runner-container.lock", "local runner container start", True)],
            entered,
        )

    def test_replace_requires_quiescent_health_before_stop(self):
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
        health = {"ok": True, "active_jobs": [], "coordinator": {"state": "paused"}}
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
        self.assertFalse(any(call[0] in {"create", "start", "rm", "prune", "kill"} for call in docker.calls))

    def test_status_rejects_an_extra_mount(self):
        self.configure()
        docker = FakeDocker(self.storage)
        docker.container_id = CONTAINER_ID
        docker.inspection = docker._inspection()
        docker.inspection["Mounts"].append(dict(docker.inspection["Mounts"][0], Destination="/checkout"))
        with self.assertRaises(container_client.ContainerClientError):
            container_client.status(self.layout, "alice", docker_call=docker)

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
