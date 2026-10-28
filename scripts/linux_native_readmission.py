"""Fail-closed planning and revalidation for explicit Linux store readmission.

This module only reads an existing store. It does not publish certificates,
markers, runtime state, or qualification results.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Mapping
import uuid

import fullmag_storage as storage
from docker_dev_host import local_volume
import linux_native_host as host


PLAN_SCHEMA = "fullmag.linux-native-readmission-plan.v1"
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_OWNER_TOKEN = re.compile(r"[0-9a-f]{32}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?\Z")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")
_MAX_EVIDENCE_BYTES = 1024 * 1024
_EVIDENCE_PATHS = {
    "certificate": host.CERTIFICATE_NAME,
    "owner_marker": host.OWNER_NAME,
    "sentinel": ".linux-native-sentinel",
    "restart": ".linux-native-restart",
    "probe": ".linux-native-probe.json",
}


def _strict_int(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(label + " must be an integer without boolean coercion")
    return value


def _sha256(value, label):
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(label + " must be a lowercase SHA-256 digest")
    return value


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Linux readmission evidence contains a duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value):
    raise ValueError("Linux readmission evidence contains a non-JSON numeric value")


def _reject_json_floats(value):
    if isinstance(value, float):
        raise ValueError("Linux readmission evidence numbers must use integer representation")
    if isinstance(value, dict):
        for nested in value.values():
            _reject_json_floats(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_json_floats(nested)


def _decode_json(raw, label):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object,
                           parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(label + " is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError(label + " must be a JSON object")
    _reject_json_floats(value)
    return value


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _json_value_bytes(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("Linux readmission JSON value is not serializable") from error


def _same_json_value(left, right):
    return _json_value_bytes(left) == _json_value_bytes(right)


def _archive(raw):
    if len(raw) > _MAX_EVIDENCE_BYTES:
        raise ValueError("Linux readmission evidence exceeds its size bound")
    return {"sha256": _digest(raw), "base64": base64.b64encode(raw).decode("ascii")}


def _unarchive(item, label):
    if not isinstance(item, Mapping):
        raise ValueError(label + " archive is missing")
    expected = _sha256(item.get("sha256"), label + " archive SHA-256")
    encoded = item.get("base64")
    if not isinstance(encoded, str):
        raise ValueError(label + " archive bytes are missing")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError(label + " archive is not valid base64") from error
    if len(raw) > _MAX_EVIDENCE_BYTES or _digest(raw) != expected:
        raise ValueError(label + " archived bytes do not match their SHA-256")
    return raw


def _canonical_state(state):
    try:
        return Path(storage.absolute(state, "Linux readmission state"))
    except (OSError, RuntimeError) as error:
        raise ValueError("Linux readmission state must be an existing absolute no-follow path") from error


def _state_metadata(state):
    descriptor = host._open_nofollow(state, os.O_RDONLY | os.O_DIRECTORY)
    try:
        metadata = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("Linux readmission state must be a directory")
    return metadata


def _read_documents(state):
    result = {}
    for name, relative in _EVIDENCE_PATHS.items():
        path = state / relative
        result[name] = host.read_owned_regular(path, _MAX_EVIDENCE_BYTES)
    return result


def _volume_identity(state, expected_device):
    volume = local_volume(state)
    if not isinstance(volume, Mapping):
        raise ValueError("Linux local volume identity is unavailable")
    required = {"host_root", "host_filesystem", "host_device", "host_platform", "host_root_no_reparse"}
    if not required.issubset(volume):
        raise ValueError("Linux local volume identity is incomplete")
    device = _strict_int(volume.get("host_device"), "Current local host_device")
    if device != expected_device:
        raise ValueError("Current local volume device differs from the pinned new host_device")
    if (volume.get("host_root") != str(state)
            or volume.get("host_platform") != "linux"
            or volume.get("host_filesystem") not in {"ext4", "xfs", "btrfs"}
            or volume.get("host_root_no_reparse") is not True):
        raise ValueError("Current local Linux volume identity is not admissible")
    metadata = _state_metadata(state)
    if metadata.st_dev != device:
        raise ValueError("Fresh state directory device differs from local volume identity")
    return dict(volume), metadata


def _certificate_identity(certificate, *, state, volume, engine_id, old_device, inode):
    required = {
        "schema", "storage_profile", "role", "owner_scope", "host_root", "host_filesystem",
        "host_device", "host_platform", "host_root_no_reparse", "host_inode", "owner_token",
        "engine_id", "image_id", "source_commit", "binary_hashes", "artifact_receipt_sha256",
        "restart_expected_sha256", "restart_verified",
    }
    if not required.issubset(certificate):
        raise ValueError("Retained Linux certificate is missing identity or provenance fields")
    if (certificate.get("schema") != host.HOST_SCHEMA
            or certificate.get("storage_profile") != host.PROFILE
            or certificate.get("role") != "session"
            or certificate.get("owner_scope") != "docker-linux"):
        raise ValueError("Retained Linux certificate scope differs")
    if (certificate.get("engine_id") != engine_id
            or not isinstance(engine_id, str) or not engine_id):
        raise ValueError("Retained Linux certificate engine identity differs")
    if (certificate.get("host_root") != str(state)
            or certificate.get("host_filesystem") != volume["host_filesystem"]
            or certificate.get("host_platform") != "linux"
            or certificate.get("host_root_no_reparse") is not True):
        raise ValueError("Retained Linux certificate host identity differs")
    if (_strict_int(certificate.get("host_device"), "Certificate host_device") != old_device
            or _strict_int(certificate.get("host_inode"), "Certificate host_inode", minimum=1) != inode):
        raise ValueError("Retained Linux certificate device or inode differs")
    if (not isinstance(certificate.get("owner_token"), str)
            or _OWNER_TOKEN.fullmatch(certificate["owner_token"]) is None):
        raise ValueError("Retained Linux certificate owner token is invalid")
    if (not isinstance(certificate.get("image_id"), str)
            or _IMAGE_ID.fullmatch(certificate["image_id"]) is None):
        raise ValueError("Retained Linux certificate image identity is invalid")
    if (not isinstance(certificate.get("source_commit"), str)
            or _COMMIT.fullmatch(certificate["source_commit"]) is None
            or not isinstance(certificate.get("binary_hashes"), dict)
            or not isinstance(certificate.get("artifact_receipt_sha256"), str)
            or _SHA256.fullmatch(certificate["artifact_receipt_sha256"]) is None):
        raise ValueError("Retained Linux certificate provenance is invalid")
    _sha256(certificate.get("restart_expected_sha256"), "Certificate restart_expected_sha256")
    if certificate.get("restart_verified") is not True:
        raise ValueError("Retained Linux certificate restart readback is not verified")


def _check_restart_evidence(certificate, documents, old_device, inode):
    token = certificate["owner_token"]
    payload = (token + ":" + certificate["image_id"]).encode("ascii")
    expected = certificate["restart_expected_sha256"]
    if _digest(payload) != expected:
        raise ValueError("Retained Linux restart_expected_sha256 differs from owner/image payload")
    if documents["sentinel"] != payload:
        raise ValueError("Retained Linux sentinel bytes differ from restart_expected_sha256")
    if documents["restart"] != payload:
        raise ValueError("Retained Linux restart readback differs from restart_expected_sha256")

    probe = _decode_json(documents["probe"], "Retained Linux storage probe")
    if (probe.get("schema") != "fullmag.linux-native-probe.v1"
            or probe.get("storage_profile") != host.PROFILE
            or probe.get("owner_token") != token
            or probe.get("image_id") != certificate["image_id"]
            or probe.get("host_attestation_sha256") != _digest(documents["certificate"])):
        raise ValueError("Retained Linux probe provenance differs from the historical certificate")
    if (_strict_int(probe.get("root_device"), "Probe root_device") != old_device
            or _strict_int(probe.get("root_inode"), "Probe root_inode", minimum=1) != inode):
        raise ValueError("Retained Linux probe device or inode differs from historical storage")
    _strict_int(probe.get("mount_namespace_inode"), "Probe mount_namespace_inode", minimum=1)
    checks = probe.get("checks")
    if (not isinstance(checks, dict) or set(checks) != host.CHECKS
            or any(value is not True for value in checks.values())):
        raise ValueError("Retained Linux probe does not contain its recorded successful checks")
    return probe


def _certificate_bytes(value):
    """Use the exact host-side evidence encoding used by publish_evidence."""
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _planned_new_bytes(plan):
    old_certificate = plan.get("old_certificate")
    new_certificate = plan.get("new_certificate")
    if not isinstance(old_certificate, Mapping) or not isinstance(new_certificate, Mapping):
        raise ValueError("Linux readmission plan certificates are missing")
    old_device = _strict_int(plan.get("old_host_device"), "Pinned old_host_device")
    new_device = _strict_int(plan.get("new_host_device"), "Pinned new_host_device")
    expected_new = dict(old_certificate)
    expected_new["host_device"] = new_device
    if old_device == new_device:
        raise ValueError("Readmission plan requires an actual host_device change")
    if _strict_int(new_certificate.get("host_device"), "Planned new host_device") != new_device:
        raise ValueError("Readmission plan new host_device differs from its pin")
    if not _same_json_value(dict(new_certificate), expected_new):
        raise ValueError("Readmission plan changes fields beyond host_device")
    raw = _certificate_bytes(expected_new)
    evidence = plan.get("planned_new_evidence")
    if not isinstance(evidence, Mapping) or set(evidence) != {"certificate", "owner_marker"}:
        raise ValueError("Linux readmission planned publication bytes are missing")
    if _unarchive(evidence.get("certificate"), "planned new certificate") != raw:
        raise ValueError("Planned new certificate bytes differ from deterministic serialization")
    if _unarchive(evidence.get("owner_marker"), "planned new owner marker") != raw:
        raise ValueError("Planned new owner marker bytes differ from deterministic serialization")
    return raw


def _plan_digest(plan):
    unsigned = {key: value for key, value in plan.items() if key != "plan_sha256"}
    try:
        raw = json.dumps(unsigned, sort_keys=True, ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("Linux readmission plan is not serializable JSON") from error
    return _digest(raw)


def _validate_plan_inputs(plan):
    if not isinstance(plan, Mapping) or plan.get("schema") != PLAN_SCHEMA:
        raise ValueError("Linux readmission plan schema is invalid")
    if plan.get("plan_sha256") != _plan_digest(plan):
        raise ValueError("Linux readmission plan changed after preparation")
    state = _canonical_state(plan.get("state_root"))
    engine_id = plan.get("engine_id")
    if not isinstance(engine_id, str) or not engine_id:
        raise ValueError("Linux readmission plan engine pin is invalid")
    old_device = _strict_int(plan.get("old_host_device"), "Pinned old_host_device")
    new_device = _strict_int(plan.get("new_host_device"), "Pinned new_host_device")
    inode = _strict_int(plan.get("expected_inode"), "Pinned expected_inode", minimum=1)
    if old_device == new_device:
        raise ValueError("Linux readmission requires an actual host_device change")
    certificate_sha = _sha256(plan.get("expected_certificate_sha256"), "Pinned certificate SHA-256")
    owner_sha = _sha256(plan.get("expected_owner_sha256"), "Pinned owner SHA-256")
    filesystem_uuid = plan.get("filesystem_uuid_observation")
    if (not isinstance(filesystem_uuid, str) or _UUID.fullmatch(filesystem_uuid) is None):
        raise ValueError("Pinned new filesystem UUID observation has invalid UUID format")
    try:
        uuid.UUID(filesystem_uuid)
    except (ValueError, AttributeError) as error:
        raise ValueError("Pinned new filesystem UUID observation has invalid UUID format") from error
    return state, engine_id, old_device, new_device, inode, certificate_sha, owner_sha, filesystem_uuid


def _archived_documents(plan):
    archive = plan.get("archived_evidence")
    if not isinstance(archive, Mapping) or set(archive) != set(_EVIDENCE_PATHS):
        raise ValueError("Linux readmission plan archive is incomplete")
    return {name: _unarchive(archive.get(name), name) for name in _EVIDENCE_PATHS}


def _validate_archived_layout(plan, documents):
    archive = _archived_documents(plan)
    for name, raw in documents.items():
        if archive[name] != raw:
            raise ValueError("Current " + name + " evidence differs from archived bytes")


def _identity_pins(certificate, old_device, new_device, inode, engine_id, filesystem_uuid):
    return {
        "certificate_fields_except_host_device": {
            key: value for key, value in certificate.items() if key != "host_device"
        },
        "old_host_device": old_device,
        "new_host_device": new_device,
        "expected_inode": inode,
        "engine_id": engine_id,
        "filesystem_uuid_observation": filesystem_uuid,
    }


def _validate_readback(plan, state, engine_id, old_device, new_device, inode,
                       certificate_sha, owner_sha, filesystem_uuid):
    volume, metadata = _volume_identity(state, new_device)
    if metadata.st_ino != inode:
        raise ValueError("Fresh Linux state directory inode differs from the readmission pin")
    documents = _read_documents(state)
    _validate_archived_layout(plan, documents)
    if _digest(documents["certificate"]) != certificate_sha:
        raise ValueError("Current certificate bytes differ from their pinned SHA-256")
    if _digest(documents["owner_marker"]) != owner_sha:
        raise ValueError("Current owner marker bytes differ from their pinned SHA-256")

    certificate = _decode_json(documents["certificate"], "Retained Linux certificate")
    owner = _decode_json(documents["owner_marker"], "Retained Linux owner marker")
    if not _same_json_value(owner, certificate):
        raise ValueError("Retained Linux certificate and owner marker JSON values differ")
    _certificate_identity(certificate, state=state, volume=volume, engine_id=engine_id,
                          old_device=old_device, inode=inode)
    if not _same_json_value(plan.get("old_certificate"), certificate):
        raise ValueError("Readmission plan old certificate differs from current evidence")
    if not _same_json_value(plan.get("identity_pins"), _identity_pins(
            certificate, old_device, new_device, inode, engine_id, filesystem_uuid)):
        raise ValueError("Readmission plan identity/provenance pins differ from retained certificate")
    _planned_new_bytes(plan)
    _check_restart_evidence(certificate, documents, old_device, inode)
    final_volume, final_metadata = _volume_identity(state, new_device)
    if (final_volume != volume or final_metadata.st_dev != metadata.st_dev
            or final_metadata.st_ino != metadata.st_ino):
        raise ValueError("Linux state identity changed during readmission validation")
    if _read_documents(state) != documents:
        raise ValueError("Linux readmission evidence changed during readmission validation")
    return {
        "plan_sha256": plan["plan_sha256"],
        "certificate_sha256": _digest(documents["certificate"]),
        "owner_sha256": _digest(documents["owner_marker"]),
        "sentinel_sha256": _digest(documents["sentinel"]),
        "restart_sha256": _digest(documents["restart"]),
        "probe_sha256": _digest(documents["probe"]),
        "state_inode": metadata.st_ino,
        "host_device": metadata.st_dev,
        "filesystem_uuid_observation": filesystem_uuid,
        "certificate": certificate,
        "owner_marker": owner,
    }


def classify_pair(plan):
    """Classify only the four byte-exact old/new certificate-owner pairs.

    The old certificate and owner marker may have different historical JSON
    formatting, so each has its own archived bytes. The planned new files share
    the deterministic host evidence encoding. Any other bytes are an unknown
    transaction state and must be left for an explicit recovery decision.
    """
    state, _engine, _old_device, new_device, inode, _cert_sha, _owner_sha, _filesystem_uuid = (
        _validate_plan_inputs(plan))
    volume, metadata = _volume_identity(state, new_device)
    if metadata.st_ino != inode:
        raise ValueError("Fresh Linux state directory inode differs from the readmission pin")
    archived = _archived_documents(plan)
    old_certificate = archived["certificate"]
    old_owner = archived["owner_marker"]
    if (_digest(old_certificate) != plan["expected_certificate_sha256"]
            or _digest(old_owner) != plan["expected_owner_sha256"]):
        raise ValueError("Archived certificate/owner bytes differ from the original hash pins")
    old_value = _decode_json(old_certificate, "Archived Linux certificate")
    owner_value = _decode_json(old_owner, "Archived Linux owner marker")
    if (not _same_json_value(old_value, owner_value)
            or not _same_json_value(plan.get("old_certificate"), old_value)):
        raise ValueError("Archived certificate/owner JSON values differ from the readmission plan")
    _certificate_identity(old_value, state=state, volume=volume, engine_id=_engine,
                          old_device=_old_device, inode=inode)
    if not _same_json_value(plan.get("identity_pins"), _identity_pins(
            old_value, _old_device, new_device, inode, _engine, _filesystem_uuid)):
        raise ValueError("Readmission plan identity/provenance pins differ from its archived certificate")
    _check_restart_evidence(old_value, archived, _old_device, inode)
    new_bytes = _planned_new_bytes(plan)
    current_documents = _read_documents(state)
    for name in ("sentinel", "restart", "probe"):
        if current_documents[name] != archived[name]:
            raise ValueError("Current " + name + " evidence differs from its archived bytes")

    def side(raw, old_raw, label):
        if raw == old_raw:
            return "old"
        if raw == new_bytes:
            return "new"
        raise ValueError("Current " + label + " bytes are neither the exact old nor planned new value")

    classification = side(current_documents["certificate"], old_certificate, "certificate") + "/" + side(
        current_documents["owner_marker"], old_owner, "owner marker")
    volume_after, metadata_after = _volume_identity(state, new_device)
    if (volume_after != volume or metadata_after.st_dev != metadata.st_dev
            or metadata_after.st_ino != metadata.st_ino):
        raise ValueError("Linux state identity changed while classifying the certificate-owner pair")
    if _read_documents(state) != current_documents:
        raise ValueError("Linux readmission evidence changed while classifying the certificate-owner pair")
    return classification


def prepare_readmission(state, *, engine_id, expected_certificate_sha256,
                        expected_owner_sha256, old_host_device, new_host_device,
                        expected_inode, filesystem_uuid):
    """Prepare a serializable, read-only readmission plan for one existing store."""
    state = _canonical_state(state)
    old_device = _strict_int(old_host_device, "old_host_device")
    new_device = _strict_int(new_host_device, "new_host_device")
    inode = _strict_int(expected_inode, "expected_inode", minimum=1)
    if old_device == new_device:
        raise ValueError("Linux readmission requires an actual host_device change")
    certificate_sha = _sha256(expected_certificate_sha256, "Expected certificate SHA-256")
    owner_sha = _sha256(expected_owner_sha256, "Expected owner SHA-256")
    if not isinstance(engine_id, str) or not engine_id:
        raise ValueError("Expected Docker engine identity must be a nonempty string")
    if not isinstance(filesystem_uuid, str) or _UUID.fullmatch(filesystem_uuid) is None:
        raise ValueError("New filesystem UUID observation has invalid UUID format")
    try:
        uuid.UUID(filesystem_uuid)
    except (ValueError, AttributeError) as error:
        raise ValueError("New filesystem UUID observation has invalid UUID format") from error

    volume, metadata = _volume_identity(state, new_device)
    if metadata.st_ino != inode:
        raise ValueError("Fresh Linux state directory inode differs from expected_inode")
    documents = _read_documents(state)
    if _digest(documents["certificate"]) != certificate_sha:
        raise ValueError("Retained certificate bytes differ from expected SHA-256")
    if _digest(documents["owner_marker"]) != owner_sha:
        raise ValueError("Retained owner marker bytes differ from expected SHA-256")
    certificate = _decode_json(documents["certificate"], "Retained Linux certificate")
    owner = _decode_json(documents["owner_marker"], "Retained Linux owner marker")
    if not _same_json_value(owner, certificate):
        raise ValueError("Retained Linux certificate and owner marker JSON values differ")
    _certificate_identity(certificate, state=state, volume=volume, engine_id=engine_id,
                          old_device=old_device, inode=inode)
    _check_restart_evidence(certificate, documents, old_device, inode)

    new_certificate = dict(certificate)
    new_certificate["host_device"] = new_device
    if not _same_json_value(
            {key: value for key, value in new_certificate.items() if key != "host_device"},
            {key: value for key, value in certificate.items() if key != "host_device"}):
        raise ValueError("Readmission plan would alter certificate identity or provenance")
    plan = {
        "schema": PLAN_SCHEMA,
        "state_root": str(state),
        "engine_id": engine_id,
        "expected_certificate_sha256": certificate_sha,
        "expected_owner_sha256": owner_sha,
        "old_host_device": old_device,
        "new_host_device": new_device,
        "expected_inode": inode,
        "filesystem_uuid_observation": filesystem_uuid,
        "old_certificate": certificate,
        "new_certificate": new_certificate,
        "identity_pins": _identity_pins(
            certificate, old_device, new_device, inode, engine_id, filesystem_uuid),
        "archived_evidence": {name: _archive(raw) for name, raw in documents.items()},
        "planned_new_evidence": {
            "certificate": _archive(_certificate_bytes(new_certificate)),
            "owner_marker": _archive(_certificate_bytes(new_certificate)),
        },
        "probe_is_historical_evidence": True,
        "probe_stale_after_readmission": True,
    }
    plan["plan_sha256"] = _plan_digest(plan)
    # Apply the same complete validation path used later by the controller.
    _validate_readback(plan, state, engine_id, old_device, new_device, inode,
                       certificate_sha, owner_sha, filesystem_uuid)
    return plan


def revalidate_readmission(plan):
    """Re-read every pinned byte and local identity without making mutations."""
    state, engine_id, old_device, new_device, inode, certificate_sha, owner_sha, filesystem_uuid = (
        _validate_plan_inputs(plan))
    return _validate_readback(plan, state, engine_id, old_device, new_device, inode,
                              certificate_sha, owner_sha, filesystem_uuid)
