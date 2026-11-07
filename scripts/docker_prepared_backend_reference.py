"""Authenticate the backend reference of an abrupt retry after exact removal."""
from __future__ import annotations

import copy

from docker_build_control import BuildControlError


class PreparedBackendReference:
    """Bind fresh isolation observations to one durable, removed container pair."""

    def __init__(self, control, authorization, compose, transition, containers, engine_sha):
        from docker_volume_container_recovery import _is_abrupt

        if (not _is_abrupt(authorization)
                or control.identity.get("checkout_kind") != "worktree"
                or control.project != authorization["compose_project"]):
            raise BuildControlError("Prepared backend reference requires its exact abrupt worktree recovery")
        self.control = control
        self._authorization = copy.deepcopy(authorization)
        self._compose = copy.deepcopy(compose)
        self._containers = copy.deepcopy(containers)
        self._engine_sha = engine_sha
        self._old_ids = tuple(authorization[service + "_container_id"]
                              for service in ("backend", "frontend"))
        self._pins = self._transition_pins(transition)
        self.revalidate()

    def _transition_pins(self, transition):
        from docker_volume_container_recovery import _stable_container_observation

        if (transition is None or transition.get("absence") is None or transition.get("present") != {}
                or any(_stable_container_observation(transition[service]) != self._containers[service]
                       for service in ("backend", "frontend"))):
            raise BuildControlError("Prepared backend reference requires the absent, original stopped pair")
        return {
            "request_id": self._authorization["request_id"],
            "old_container_ids": list(self._old_ids),
            "compose_config_sha256": self._authorization["compose_config_sha256"],
            "docker_engine_id_sha256": self._engine_sha,
            **{key: transition[key] for key in (
                "prepared_sha", "absence_sha", "request_sha", "manifest_sha", "network_state",
            )},
        }

    def revalidate(self):
        from docker_volume_container_recovery import (
            _canonical, _control_json, _docker_engine_sha, _load_recovery_transition, _sha256,
        )

        attempt = self._authorization["development_attempt"]
        compose, _ = _control_json(self.control, f"development/attempts/{attempt}/compose.json")
        if (compose != self._compose
                or _sha256(_canonical(compose)) != self._authorization["compose_config_sha256"]
                or _docker_engine_sha() != self._engine_sha):
            raise BuildControlError("Prepared backend reference Compose or engine changed")
        current = _load_recovery_transition(
            self.control, self._authorization, self.control.project, compose,
        )
        if self._transition_pins(current) != self._pins:
            raise BuildControlError("Prepared backend reference transition changed")
        self._assert_pair_absent()

    def _assert_pair_absent(self):
        # Use the existing exact full-ID inspect refusal plus empty Docker ps
        # proof. A timeout or ambiguous error must never stand in for removal.
        from docker_volume_cancelled_recovery import _absence_observation

        for identifier in self._old_ids:
            _absence_observation(identifier)

    def inspect_backend(self, identifier):
        if identifier != self._old_ids[0]:
            raise BuildControlError("Prepared backend reference does not bind this ID")
        self._assert_pair_absent()
        return copy.deepcopy(self._containers["backend"])

    def evidence(self):
        return copy.deepcopy(self._pins)
