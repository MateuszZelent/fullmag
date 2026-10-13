"""Mutation regressions for exact-byte linearization identity replay."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fem_linearization_identity_replay import (  # noqa: E402
    IDENTITY_FIELDS, IdentityReplayError, replay_identity_preimage,
)

SOURCE_SNAPSHOT = "b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5"


def encode(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")


def fixture(sample_index: int = 2, *, overrides: dict | None = None) -> tuple[dict, dict]:
    identity = {key: "fixture" for key in IDENTITY_FIELDS}
    identity.update(schema_version="linearization_identity.v2", sample_index=sample_index,
                    node_count=1, content_sha256="",
                    producer_build_identity={"source_snapshot_sha256": "a" * 64,
                                             "nested": {"enabled": True, "value": 1}},
                    consumer_build_identity={"source_snapshot_sha256": "a" * 64},
                    producer_source_snapshot_sha256=SOURCE_SNAPSHOT,
                    consumer_source_snapshot_sha256=SOURCE_SNAPSHOT,
                    source_stage_id="relaxation-zażółć")
    identity["producer_build_identity"]["source_snapshot_sha256"] = SOURCE_SNAPSHOT
    identity["consumer_build_identity"]["source_snapshot_sha256"] = SOURCE_SNAPSHOT
    if overrides:
        identity.update(overrides)
    # Intentionally pretty, reversed-order UTF-8 bytes: hashing must retain
    # these exact bytes rather than recreate compact sorted Python JSON.
    preimage = json.dumps(dict(reversed(list(identity.items()))), ensure_ascii=False,
                          indent=3).encode("utf-8")
    framed = b"linearization_identity.v2\0" + struct.pack("<Q", len(preimage)) + preimage
    identity["content_sha256"] = "sha256:" + hashlib.sha256(framed).hexdigest()
    sidecar = {
        "schema_version": "linearization_identity_preimage.v1",
        "identity_schema": "linearization_identity.v2",
        "identity_preimage_json": preimage.decode("utf-8"),
        "identity_preimage_sha256": "sha256:" + hashlib.sha256(preimage).hexdigest(),
        "identity_content_sha256": identity["content_sha256"],
    }
    return identity, sidecar


class IdentityReplayTests(unittest.TestCase):
    def test_exact_utf8_preimage_retained(self):
        identity, sidecar = fixture()
        self.assertEqual(replay_identity_preimage(encode(identity), encode(sidecar)),
                         identity["content_sha256"])

    def test_every_identity_field_is_bound(self):
        identity, sidecar = fixture()
        for key in IDENTITY_FIELDS:
            with self.subTest(field=key):
                changed = copy.deepcopy(identity)
                changed[key] = (changed[key] + 1 if type(changed[key]) is int else
                                {"replacement": "value"} if type(changed[key]) is dict else
                                changed[key] + "-changed")
                with self.assertRaises(IdentityReplayError):
                    replay_identity_preimage(encode(changed), encode(sidecar))

    def test_bool_and_float_do_not_bind_to_integer(self):
        identity, sidecar = fixture()
        for key in ("sample_index", "node_count"):
            for value in (True, 1.0, -1, "1", 1 << 64):
                with self.subTest(key=key, value=value):
                    changed = copy.deepcopy(identity)
                    changed[key] = value
                    with self.assertRaises(IdentityReplayError):
                        replay_identity_preimage(encode(changed), encode(sidecar))

    def test_nested_json_types_are_bound(self):
        identity, sidecar = fixture()
        for key, value in (("enabled", 1), ("value", True), ("value", 1.0)):
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(identity)
                changed["producer_build_identity"]["nested"][key] = value
                with self.assertRaisesRegex(IdentityReplayError, "type mismatch"):
                    replay_identity_preimage(encode(changed), encode(sidecar))

    def test_preimage_reserialization_is_rejected(self):
        identity, sidecar = fixture()
        sidecar["identity_preimage_json"] = json.dumps(
            json.loads(sidecar["identity_preimage_json"]), sort_keys=True)
        exact = sidecar["identity_preimage_json"].encode("utf-8")
        sidecar["identity_preimage_sha256"] = "sha256:" + hashlib.sha256(exact).hexdigest()
        with self.assertRaisesRegex(IdentityReplayError, "framed digest mismatch"):
            replay_identity_preimage(encode(identity), encode(sidecar))

    def test_raw_digest_and_identity_link_are_checked(self):
        identity, sidecar = fixture()
        for key in ("identity_preimage_sha256", "identity_content_sha256"):
            with self.subTest(key=key):
                changed = dict(sidecar, **{key: "sha256:" + "0" * 64})
                with self.assertRaises(IdentityReplayError):
                    replay_identity_preimage(encode(identity), encode(changed))

    def test_build_source_snapshots_use_raw_lowercase_hex(self):
        identity, sidecar = fixture()
        for field, mutate in (
            ("producer_source_snapshot_sha256", lambda value: "sha256:" + value),
            ("consumer_source_snapshot_sha256", lambda value: value.upper()),
        ):
            with self.subTest(field=field):
                changed = copy.deepcopy(identity)
                changed[field] = mutate(changed[field])
                with self.assertRaisesRegex(IdentityReplayError, "source_snapshot_sha256"):
                    replay_identity_preimage(encode(changed), encode(sidecar))

        for field in ("producer_source_snapshot_sha256", "consumer_source_snapshot_sha256"):
            with self.subTest(field=field, mutation="missing"):
                changed = copy.deepcopy(identity)
                changed.pop(field)
                with self.assertRaises(IdentityReplayError):
                    replay_identity_preimage(encode(changed), encode(sidecar))

        for build in ("producer_build_identity", "consumer_build_identity"):
            with self.subTest(build=build):
                changed = copy.deepcopy(identity)
                changed[build]["source_snapshot_sha256"] = (
                    "sha256:" + changed[build]["source_snapshot_sha256"]
                )
                with self.assertRaisesRegex(IdentityReplayError, "source_snapshot_sha256"):
                    replay_identity_preimage(encode(changed), encode(sidecar))

    def test_native_contract_source_guard_requires_raw_64_hex(self):
        contract_path = (
            Path(__file__).resolve().parents[1]
            / "crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs"
        )
        source = contract_path.read_text(encoding="utf-8")
        start = source.index("fn is_strict_source_snapshot_sha256")
        guard = source[start:source.index("\n}\n", start) + 3]
        self.assertIn("value.len() == 64", guard)
        self.assertIn("(b'a'..=b'f').contains(&byte)", guard)
        self.assertNotIn('value.starts_with("sha256:")', guard)

    def test_duplicate_keys_in_all_three_objects_are_rejected(self):
        identity, sidecar = fixture()
        for which in ("identity", "sidecar", "preimage"):
            with self.subTest(which=which):
                a, b = encode(identity), encode(sidecar)
                if which == "identity":
                    a = b'{"schema_version":"wrong",' + a[1:]
                elif which == "sidecar":
                    b = b'{"identity_schema":"wrong",' + b[1:]
                else:
                    changed = dict(sidecar)
                    changed["identity_preimage_json"] = '{"sample_index":2,' + changed["identity_preimage_json"][1:]
                    exact = changed["identity_preimage_json"].encode("utf-8")
                    changed["identity_preimage_sha256"] = "sha256:" + hashlib.sha256(exact).hexdigest()
                    b = encode(changed)
                with self.assertRaisesRegex(IdentityReplayError, "duplicate key"):
                    replay_identity_preimage(a, b)

    def test_unknown_and_missing_fields_are_rejected(self):
        identity, sidecar = fixture()
        for which in ("identity", "sidecar"):
            for mutation in ("missing", "unknown"):
                with self.subTest(which=which, mutation=mutation):
                    a, b = copy.deepcopy(identity), dict(sidecar)
                    target = a if which == "identity" else b
                    if mutation == "missing":
                        target.pop("schema_version")
                    else:
                        target["unknown"] = "extra"
                    with self.assertRaises(IdentityReplayError):
                        replay_identity_preimage(encode(a), encode(b))

    def test_nonfinite_json_and_invalid_utf8_are_rejected(self):
        identity, sidecar = fixture()
        for malformed in (b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}',
                          b'{"x":"\\ud800"}', b'{"\\ud800":1}',
                          b'\xff', b'[]', b'{} trailing'):
            with self.subTest(malformed=malformed):
                with self.assertRaises(IdentityReplayError):
                    replay_identity_preimage(malformed, encode(sidecar))
        changed = copy.deepcopy(identity)
        changed["producer_build_identity"]["nested"]["value"] = float("inf")
        with self.assertRaises(IdentityReplayError):
            replay_identity_preimage(json.dumps(changed).encode(), encode(sidecar))

    def test_excessive_nesting_is_controlled_rejection(self):
        _, sidecar = fixture()
        for depth in (140, 2000):
            with self.subTest(depth=depth):
                raw = b'{"nested":' + b'[' * depth + b'0' + b']' * depth + b'}'
                with self.assertRaises(IdentityReplayError):
                    replay_identity_preimage(raw, encode(sidecar))


if __name__ == "__main__":
    unittest.main()
