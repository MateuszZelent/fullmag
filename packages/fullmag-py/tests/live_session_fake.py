"""Stateful fake of a live Fullmag session for live-DSL tests.

It applies ``replace_scene``, ``merge_patch`` and ``patch_material`` to a stored
scene, enforces ``base_revision`` like the API (``revision_conflict``) and
completes runtime commands, so tests can compare the server's scene with the
scene the canonical converters build from the world.
"""
from __future__ import annotations

import copy
import itertools
from typing import Any, Optional

from live_api_fake import FakeFullmagApi, RecordedRequest, api_error

BASE = "/v2/sessions/current"


def apply_merge_patch(target: Any, patch: Any) -> Any:
    if not isinstance(patch, dict):
        return copy.deepcopy(patch)
    result = copy.deepcopy(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = apply_merge_patch(result.get(key), value)
    return result


class FakeLiveSession:
    def __init__(self, *, session_exists: bool = True, command_status: str = "completed", completion: str = "succeeded") -> None:
        self.api = FakeFullmagApi()
        self.scene: dict[str, Any] = {"version": "scene.v2", "revision": 3, "objects": []}
        self.session_exists = session_exists
        self.session_status = "running"
        self.create_bodies: list[dict[str, Any]] = []
        self.commands: dict[str, dict[str, Any]] = {}
        self.transactions: list[dict[str, Any]] = []
        self.command_status = command_status
        self.completion = completion
        self.lock_inputs = False
        self.magnetization_apply_commits = 0
        self.drop_magnetization_apply_responses = 0
        self.magnetization_receipts: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        self._ids = itertools.count(1)
        api = self.api
        api.route("GET", f"{BASE}", self._current)
        api.route("GET", f"{BASE}/status", {"session": {
            "session_id": "s1", "session_epoch": "s1@1", "request_scope_epoch": "fake:1",
        }})
        api.route("POST", "/v2/sessions", self._create)
        api.route("GET", f"{BASE}/model/scene", lambda _r: (200, self.scene, {}))
        api.route("POST", f"{BASE}/model/transactions", self._transaction)
        api.route("GET", f"{BASE}/model/script", lambda _r: (200, {"source": "import fullmag as fm\n", "bytes": 21, "canonical": True}, {}))
        api.route("POST", f"{BASE}/model/syncs", self._render_script)
        api.route("POST", f"{BASE}/simulation/commands", self._command)

    @property
    def url(self) -> str:
        return self.api.url

    def __enter__(self) -> "FakeLiveSession":
        self.api.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.api.stop()

    def _current(self, _request: RecordedRequest):
        if not self.session_exists:
            return api_error(404, "not_found", "no current session")
        return 200, {"session_id": "s1", "status": self.session_status}, {}

    def _create(self, request: RecordedRequest):
        self.create_bodies.append(request.json())
        self.session_exists = True
        self.session_status = "running"
        self.scene = {"version": "scene.v2", "revision": 1, "objects": []}
        return 201, {"session_id": "s2", "status": {}, "scene_document": {}, "revisions": {}}, {}

    def _render_script(self, request: RecordedRequest):
        expected = request.json().get("expected_scene_revision")
        if expected is not None and expected != self.scene["revision"]:
            return api_error(409, "scene_revision_mismatch", "scene changed while rendering")
        return 200, {"source": "import fullmag as fm\n", "scene_revision": self.scene["revision"]}, {}

    def _transaction(self, request: RecordedRequest):
        body = request.json()
        self.transactions.append(body)
        apply = body.get("magnetization_apply")
        if apply:
            operation_id = apply["operation_id"]
            if (request.headers.get("idempotency-key") != operation_id
                    or request.headers.get("x-fullmag-session-scope") !=
                    "session=s1&epoch=s1%401&request_scope_epoch=fake%3A1"):
                return api_error(400, "bad_request", "invalid magnetization apply identity")
            if operation_id in self.magnetization_receipts:
                previous, receipt = self.magnetization_receipts[operation_id]
                if body != previous:
                    return api_error(409, "magnetization_apply_intent_conflict", "body changed")
                if self.scene["revision"] != receipt["scene_revision"]:
                    return api_error(409, "magnetization_apply_scene_advanced", "scene advanced")
                return self._magnetization_apply_reply(receipt)
        base = body.get("base_revision")
        if base is not None and base != self.scene["revision"]:
            return api_error(409, "revision_conflict", f"scene revision mismatch: base={base}, current={self.scene['revision']}")
        if self.lock_inputs:
            return api_error(409, "accepted_execution_input_locked", "finish or stop the accepted run")
        revision = self.scene["revision"]
        kind = body["kind"]
        if kind == "replace_scene":
            self.scene = copy.deepcopy(body["scene"])
        elif kind == "merge_patch":
            self.scene = apply_merge_patch(self.scene, body["merge_patch"])
        elif kind == "patch_material":
            for material in self.scene.get("materials", []):
                if material["id"] == body["material_id"]:
                    material["properties"].update(body["patch"]["properties"])
        else:
            return api_error(400, "bad_request", f"fake does not implement {kind}")
        self.scene["revision"] = revision + 1
        receipt = {"transaction_kind": kind, "scene_revision": revision + 1, "committed_scene": self.scene}
        if apply:
            self.magnetization_apply_commits += 1
            receipt["transaction_kind"] = "apply_magnetization"
            receipt["magnetization_apply"] = {
                "operation_id": operation_id, "status": "initial_state_pending",
            }
            self.magnetization_receipts[operation_id] = (copy.deepcopy(body), copy.deepcopy(receipt))
            return self._magnetization_apply_reply(receipt)
        return 200, receipt, {}

    def _magnetization_apply_reply(self, receipt: dict[str, Any]):
        if self.drop_magnetization_apply_responses:
            self.drop_magnetization_apply_responses -= 1
            return None
        return 200, receipt, {}

    def _command(self, request: RecordedRequest):
        body = request.json()
        command_id = f"c{next(self._ids)}"
        detail = {
            "command_id": command_id,
            "seq": len(self.commands) + 1,
            "kind": body["kind"],
            "created_at_unix_ms": 0,
            "status": self.command_status,
            "completion_status": self.completion,
            "request": body,
        }
        self.commands[command_id] = detail
        self.api.route("GET", f"{BASE}/simulation/commands/{command_id}", lambda _r, d=detail: (200, d, {}))
        return 200, {"accepted": True, "command_id": command_id}, {}

    def command_bodies(self, kind: Optional[str] = None) -> list[dict[str, Any]]:
        bodies = [detail["request"] for detail in self.commands.values()]
        return [body for body in bodies if kind is None or body["kind"] == kind]
