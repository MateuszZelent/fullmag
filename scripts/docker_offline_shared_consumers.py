"""Read-only qualification for shared package volumes during offline recovery.

This module only authenticates cache-profile and Docker evidence.  Its callback
classifies foreign package-volume consumers; it does not stop containers,
change namespaces, or authorize recovery by itself.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from docker_build_control import BuildControlError, docker_capture


_ATTEMPT = re.compile(r"^[0-9a-f]{32}$")
_SHARED_PREFIX = "fullmag-shared-"


def _fail(message: str) -> BuildControlError:
    return BuildControlError("Cannot qualify shared cache consumers: " + message)


def _strict_json(raw: bytes) -> dict[str, Any]:
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("non-finite JSON value")

    value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs,
                       parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("profile root is not an object")
    return value


def _inspect_document(name: str) -> dict[str, Any]:
    result = docker_capture("volume", "inspect", name)
    try:
        value = json.loads(result.stdout.decode("utf-8", "strict"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("shared volume inspect is not bounded JSON") from error
    if (not isinstance(value, list) or len(value) != 1
            or not isinstance(value[0], dict) or value[0].get("Name") != name):
        raise _fail("shared volume inspect identity is ambiguous")
    return value[0]


def _compose_shared_names(document: Mapping[str, Any], expected: Mapping[str, Any]) -> set[str]:
    volumes = document.get("volumes")
    if not isinstance(volumes, Mapping):
        raise _fail("retained Compose volume declarations are malformed")
    expected_names = {descriptor["name"] for descriptor in expected.values()}
    declared: set[str] = set()
    for value in volumes.values():
        if not isinstance(value, Mapping):
            continue
        name = value.get("name")
        if not isinstance(name, str) or not name.startswith(_SHARED_PREFIX):
            continue
        if name not in expected_names:
            # Unknown shared-looking names remain protected by the caller.
            continue
        if dict(value) != {"name": name, "external": True}:
            raise _fail("declared shared volume differs from its exact external descriptor")
        if name in declared:
            raise _fail("shared volume has duplicate Compose declarations")
        declared.add(name)
    return declared


def qualify(control, development, document, backend):
    """Return attested shared names and a validator for external inventory rows.

    Only the three exact project-scoped shared volume names can be exempted.
    Private control/cache/ledger checks remain the caller's responsibility.
    """
    import docker_backend_volume_cache as cache
    import docker_shared_build_storage as shared
    from docker_volume_offline_reconcile import _control_raw

    if not isinstance(development, Mapping) or not isinstance(document, Mapping):
        raise _fail("development or Compose record is malformed")
    attempt = development.get("attempt")
    if not isinstance(attempt, str) or _ATTEMPT.fullmatch(attempt) is None:
        raise _fail("development attempt is not an exact 32-character token")
    profile_relative = f"development/attempts/{attempt}/backend-cache.json"
    try:
        raw = _control_raw(control, profile_relative)
        profile = _strict_json(raw)
    except BuildControlError:
        raise
    except (UnicodeDecodeError, ValueError, TypeError, KeyError) as error:
        raise _fail("backend cache profile is malformed") from error

    if (profile.get("schema") != cache.SCHEMA or profile.get("state") != "ready"
            or profile.get("shared_packages") is not True
            or profile.get("control_project") != control.project
            or profile.get("volume_names") != development.get("backend_volumes")
            or not isinstance(profile.get("volume_documents"), Mapping)):
        raise _fail("ready shared-package profile is not bound to this development")

    try:
        retained = cache._validate_volume_documents(profile["volume_documents"], profile)
        fresh = cache.inspect_volume_pair(
            lambda *args: docker_capture(*args).stdout.decode("utf-8", "strict"), profile
        )
        if fresh != retained:
            raise _fail("backend cache volume identity or mountpoint changed")
        checked_profile = {**profile, "volume_documents": fresh}
        cache.validate_container(backend, checked_profile)

        descriptors = shared.volume_descriptors(str(profile["project_id"]))
        declared_names = _compose_shared_names(document, descriptors)
        expected = shared.shared_volume_names(str(profile["project_id"]))
        if expected[shared.PACKAGE_ROLE] != profile["volume_names"][cache.PACKAGE_VOLUME_ROLE]:
            raise _fail("shared package volume differs from the project descriptor")
        if expected[shared.PACKAGE_ROLE] not in declared_names:
            raise _fail("retained Compose does not declare its exact shared package volume")

        shared_hashes: dict[str, str] = {}
        for role in shared.VOLUME_ROLES:
            name = expected[role]
            if name not in declared_names:
                continue
            if role == shared.PACKAGE_ROLE:
                fresh_document = fresh[cache.PACKAGE_VOLUME_ROLE]
                validated = shared.validate_volume_document(
                    fresh_document, str(profile["project_id"]), role
                )
            else:
                fresh_document = _inspect_document(name)
                validated = shared.validate_volume_document(
                    fresh_document, str(profile["project_id"]), role
                )
            shared_hashes[name] = hashlib.sha256(
                json.dumps(validated, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False).encode("utf-8")
            ).hexdigest()
    except BuildControlError:
        raise
    except (cache.BackendVolumeCacheError, shared.SharedBuildStorageError,
            KeyError, TypeError, ValueError, UnicodeDecodeError) as error:
        raise _fail(str(error)) from error

    package_name = expected[shared.PACKAGE_ROLE]
    package_mountpoint = fresh[cache.PACKAGE_VOLUME_ROLE]["Mountpoint"]

    def validate_consumer(row: Mapping[str, Any]) -> None:
        if not isinstance(row, Mapping):
            raise _fail("container inventory row is malformed")
        mounts = row.get("Mounts")
        if not isinstance(mounts, list):
            raise _fail("container mount inventory is malformed")
        package_mounts = []
        for mount in mounts:
            if not isinstance(mount, Mapping):
                raise _fail("container mount entry is malformed")
            name = mount.get("Name", mount.get("name"))
            mount_type = mount.get("Type", mount.get("type"))
            source = mount.get("Source", mount.get("source"))
            if name == package_name:
                if mount_type != "volume":
                    raise _fail("shared package mount is not a named volume")
                package_mounts.append(mount)
                continue
            try:
                if mount_type == "bind":
                    source_path = cache._linux_bind_source(source)
                elif mount_type == "volume":
                    source_path = cache._safe_daemon_path(source, "foreign volume mount source")
                else:
                    continue
            except cache.BackendVolumeCacheError as error:
                raise _fail(str(error)) from error
            if (source_path is not None
                    and cache._daemon_paths_overlap(source_path, package_mountpoint)):
                raise _fail("foreign bind or volume aliases the shared package mountpoint")

        if not package_mounts:
            return
        config = row.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if not isinstance(config, Mapping) or not isinstance(labels, Mapping):
            raise _fail("shared package consumer has no exact container labels")
        project = labels.get("com.docker.compose.project")
        if (labels.get("com.docker.compose.service") != "backend"
                or not isinstance(project, str) or not project
                or project == profile["control_project"]):
            raise _fail("shared package volume is mounted by a non-foreign backend")
        try:
            cache._assert_shared_package_mounts(
                row, config, labels, mounts, checked_profile, package_mountpoint
            )
        except cache.BackendVolumeCacheError as error:
            raise _fail(str(error)) from error

    evidence = {
        "profile_relative": profile_relative,
        "profile_sha256": hashlib.sha256(raw).hexdigest(),
        "shared_volume_sha256": shared_hashes,
    }
    return evidence, set(shared_hashes), validate_consumer
