from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

import frequency_domain_generation as generation


# Expected bytes matching the Rust serializer contract; this is not a Rust run receipt.
RUST_SERIALIZER_COMPATIBLE_V2_MARKER = """{
  "generation_id": "sha256:cc306e3a05680ba1855960fb03b9104397067da5bf29eb2794f62201e297a2e6",
  "content": {
    "schema_version": "frequency_domain_artifact_generation.v2",
    "producer": {
      "run_id": "run-é",
      "stage_id": "stage:α",
      "stage_kind": "frequency_response"
    },
    "members": {
      "response/μ.json": {
        "byte_length": 2,
        "sha256": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
      }
    }
  }
}""".encode("utf-8")


def rust_body(
    schema: str,
    members: dict[str, object],
    producer: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": schema,
        "producer": producer,
        "members": {key: members[key] for key in sorted(members)},
    }


def marker_bytes(body: dict[str, object]) -> tuple[str, bytes]:
    compact = json.dumps(
        body,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    generation_id = "sha256:" + hashlib.sha256(compact).hexdigest()
    marker = {"generation_id": generation_id, "content": body}
    pretty = json.dumps(marker, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    return generation_id, pretty


def install_generation(
    root: Path,
    schema: str,
    payloads: dict[str, bytes],
    producer: dict[str, str] | None = None,
    *,
    write_payloads: bool = True,
) -> tuple[str, bytes]:
    member_map = {
        name: {
            "byte_length": len(payload),
            "sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
        }
        for name, payload in payloads.items()
    }
    body = rust_body(schema, member_map, producer)
    generation_id, raw_marker = marker_bytes(body)
    if write_payloads:
        if schema == generation.SCHEMA_V2:
            member_root = root / generation.GENERATION_DIRECTORY / generation_id[7:]
        else:
            member_root = root
        for relative, payload in payloads.items():
            path = member_root.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
    marker = generation.IMMUTABLE_COMMIT_PATH if schema == generation.SCHEMA_V2 else generation.COMMIT_PATH
    marker_path = root.joinpath(*marker.split("/"))
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_bytes(raw_marker)
    return generation_id, raw_marker


class FrequencyDomainGenerationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "artifacts"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_reads_rust_serializer_compatible_utf8_v2_fixture(self) -> None:
        marker_path = self.root / generation.IMMUTABLE_COMMIT_PATH
        marker_path.parent.mkdir(parents=True)
        marker_path.write_bytes(RUST_SERIALIZER_COMPATIBLE_V2_MARKER)
        member = (
            self.root / generation.GENERATION_DIRECTORY
            / "cc306e3a05680ba1855960fb03b9104397067da5bf29eb2794f62201e297a2e6"
            / "response" / "μ.json"
        )
        member.parent.mkdir(parents=True)
        member.write_bytes(b"{}")

        captured = generation.capture(self.root)

        self.assertIsNotNone(captured)
        assert captured is not None
        self.assertTrue(captured.is_immutable())
        self.assertEqual(captured.producer.run_id, "run-é")
        self.assertEqual(captured.read_json_member("response/μ.json"), {})
        self.assertEqual(captured.iter_members("response"), ("response/μ.json",))

    def test_missing_markers_return_none_without_inventing_a_generation(self) -> None:
        self.assertIsNone(generation.capture(self.root))

    def test_v1_is_byte_verified_but_explicitly_mutable(self) -> None:
        install_generation(
            self.root,
            generation.SCHEMA_V1,
            {"eigen/spectrum.json": b"{}"},
        )
        captured = generation.capture(self.root)
        self.assertIsNotNone(captured)
        assert captured is not None
        self.assertFalse(captured.is_immutable())
        self.assertEqual(captured.read_member("eigen/spectrum.json"), b"{}")

        (self.root / "eigen/spectrum.json").write_bytes(b"[]")
        with self.assertRaises(generation.GenerationError):
            captured.read_member("eigen/spectrum.json")

    def test_present_corrupt_v2_never_falls_back_to_valid_v1(self) -> None:
        install_generation(self.root, generation.SCHEMA_V1, {"eigen/a.json": b"{}"})
        v2_path = self.root / generation.IMMUTABLE_COMMIT_PATH
        v2_path.parent.mkdir(parents=True, exist_ok=True)
        v2_path.write_bytes(b"{}")

        with self.assertRaises(generation.GenerationError):
            generation.capture(self.root)

    def test_duplicate_marker_keys_are_rejected(self) -> None:
        v2_path = self.root / generation.IMMUTABLE_COMMIT_PATH
        v2_path.parent.mkdir(parents=True)
        v2_path.write_text(
            '{"generation_id":"sha256:' + "0" * 64
            + '","generation_id":"sha256:' + "0" * 64 + '"}',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(generation.GenerationError, "duplicate"):
            generation.capture(self.root)

    def test_invalid_lengths_producers_paths_and_digests_are_rejected(self) -> None:
        valid_digest = "sha256:" + "a" * 64
        base_member = {"byte_length": 1, "sha256": valid_digest}
        cases = (
            (
                {"eigen/a": {"byte_length": True, "sha256": valid_digest}},
                None,
            ),
            (
                {"eigen/a": {"byte_length": -1, "sha256": valid_digest}},
                None,
            ),
            (
                {"eigen/a": {"byte_length": 1.0, "sha256": valid_digest}},
                None,
            ),
            (
                {"../escape": base_member},
                None,
            ),
            (
                {"frequency_domain/generations/id/member": base_member},
                None,
            ),
            (
                {"eigen/a": {"byte_length": 1, "sha256": "sha256:" + "A" * 64}},
                None,
            ),
            (
                {"eigen/a": base_member},
                {"run_id": " ", "stage_id": "stage", "stage_kind": "kind"},
            ),
        )
        for members, producer in cases:
            with self.subTest(members=members, producer=producer):
                body = rust_body(generation.SCHEMA_V2, members, producer)
                _, raw_marker = marker_bytes(body)
                marker_path = self.root / generation.IMMUTABLE_COMMIT_PATH
                marker_path.parent.mkdir(parents=True, exist_ok=True)
                marker_path.write_bytes(raw_marker)
                with self.assertRaises(generation.GenerationError):
                    generation.capture(self.root)
                marker_path.unlink()

    def test_json_reads_are_bounded_and_reject_duplicate_keys(self) -> None:
        payload = b'{"same":1,"same":2}'
        install_generation(
            self.root,
            generation.SCHEMA_V2,
            {"eigen/duplicate.json": payload},
        )
        captured = generation.capture(self.root)
        assert captured is not None
        with self.assertRaisesRegex(generation.GenerationError, "byte budget"):
            captured.read_json_member("eigen/duplicate.json", maximum_bytes=4)
        with self.assertRaisesRegex(generation.GenerationError, "duplicate"):
            captured.read_json_member("eigen/duplicate.json")

    def test_nonmember_missing_member_and_traversal_fail_closed(self) -> None:
        install_generation(
            self.root,
            generation.SCHEMA_V2,
            {"eigen/present.json": b"{}"},
        )
        captured = generation.capture(self.root)
        assert captured is not None
        with self.assertRaises(generation.GenerationError):
            captured.read_member("eigen/unlisted.json")
        with self.assertRaises(generation.GenerationError):
            captured.read_member("../outside")
        member = captured.member_root / "eigen" / "present.json"
        member.unlink()
        with self.assertRaises(generation.GenerationError):
            captured.read_member("eigen/present.json")

    def test_same_length_corruption_fails_streaming_and_read_paths(self) -> None:
        install_generation(
            self.root,
            generation.SCHEMA_V2,
            {"response/chunk.bin": b"original"},
        )
        captured = generation.capture(self.root)
        assert captured is not None
        member = captured.member_root / "response" / "chunk.bin"
        member.write_bytes(b"tampered")
        with self.assertRaises(generation.GenerationError):
            captured.verify_member("response/chunk.bin")
        with self.assertRaises(generation.GenerationError):
            captured.read_member("response/chunk.bin")

    def test_member_descriptor_closes_when_fstat_fails(self) -> None:
        install_generation(self.root, generation.SCHEMA_V1, {"eigen/file.bin": b"payload"})
        captured = generation.capture(self.root)
        assert captured is not None
        with (
            patch.object(generation.os, "open", return_value=101),
            patch.object(generation.os, "fstat", side_effect=OSError("fstat failed")),
            patch.object(generation.os, "close") as close,
        ):
            with self.assertRaises(generation.GenerationError):
                captured.verify_member("eigen/file.bin")
        close.assert_called_once_with(101)

    def test_member_descriptor_closes_when_fdopen_fails(self) -> None:
        install_generation(self.root, generation.SCHEMA_V1, {"eigen/file.bin": b"payload"})
        captured = generation.capture(self.root)
        assert captured is not None
        member = captured._physical_member_path("eigen/file.bin")
        opened = member.stat()
        with (
            patch.object(generation.os, "open", return_value=102),
            patch.object(generation.os, "fstat", return_value=opened),
            patch.object(generation.os, "fdopen", side_effect=OSError("fdopen failed")),
            patch.object(generation.os, "close") as close,
        ):
            with self.assertRaises(generation.GenerationError):
                captured.verify_member("eigen/file.bin")
        close.assert_called_once_with(102)

    def test_marker_descriptor_closes_when_fstat_fails(self) -> None:
        install_generation(self.root, generation.SCHEMA_V1, {"eigen/file.bin": b"payload"})
        marker = self.root / generation.COMMIT_PATH
        with (
            patch.object(generation.os, "open", return_value=103),
            patch.object(generation.os, "fstat", side_effect=OSError("fstat failed")),
            patch.object(generation.os, "close") as close,
        ):
            with self.assertRaises(generation.GenerationError):
                generation._read_marker(self.root, generation.COMMIT_PATH)
        close.assert_called_once_with(103)

    def test_marker_descriptor_closes_when_fdopen_fails(self) -> None:
        install_generation(self.root, generation.SCHEMA_V1, {"eigen/file.bin": b"payload"})
        marker = self.root / generation.COMMIT_PATH
        opened = marker.stat()
        with (
            patch.object(generation.os, "open", return_value=104),
            patch.object(generation.os, "fstat", return_value=opened),
            patch.object(generation.os, "fdopen", side_effect=OSError("fdopen failed")),
            patch.object(generation.os, "close") as close,
        ):
            with self.assertRaises(generation.GenerationError):
                generation._read_marker(self.root, generation.COMMIT_PATH)
        close.assert_called_once_with(104)

    def test_root_and_member_symlinks_or_reparse_points_are_rejected(self) -> None:
        reparse_metadata = Mock(
            st_mode=stat.S_IFDIR | 0o755,
            st_file_attributes=0x400,
        )
        with self.assertRaises(generation.GenerationError):
            generation._reject_link_or_reparse(reparse_metadata, "test path")

        actual = Path(self.temp.name) / "actual"
        actual.mkdir()
        install_generation(actual, generation.SCHEMA_V1, {"eigen/link.bin": b"payload"})
        link_root = Path(self.temp.name) / "root-link"
        try:
            os.symlink(actual, link_root, target_is_directory=True)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaises(generation.GenerationError):
                generation.capture(link_root)

        target = Path(self.temp.name) / "external.bin"
        target.write_bytes(b"payload")
        member_link = actual / "eigen" / "link.bin"
        member_link.unlink()
        try:
            os.symlink(target, member_link)
        except (OSError, NotImplementedError):
            pass
        else:
            captured = generation.capture(actual)
            assert captured is not None
            with self.assertRaises(generation.GenerationError):
                captured.read_member("eigen/link.bin")

        parent_root = Path(self.temp.name) / "parent-link-root"
        parent_root.mkdir()
        install_generation(
            parent_root,
            generation.SCHEMA_V1,
            {"eigen/nested/member.bin": b"payload"},
            write_payloads=False,
        )
        external_directory = Path(self.temp.name) / "external-directory"
        external_directory.mkdir()
        (external_directory / "member.bin").write_bytes(b"payload")
        (parent_root / "eigen").mkdir()
        try:
            os.symlink(
                external_directory,
                parent_root / "eigen" / "nested",
                target_is_directory=True,
            )
        except (OSError, NotImplementedError):
            pass
        else:
            captured = generation.capture(parent_root)
            assert captured is not None
            with self.assertRaises(generation.GenerationError):
                captured.read_member("eigen/nested/member.bin")
    def test_v2_a_b_history_remains_unchanged_and_old_capture_is_stale(self) -> None:
        generation_a, _ = install_generation(
            self.root,
            generation.SCHEMA_V2,
            {"eigen/spectrum.json": b"A"},
        )
        captured_a = generation.capture(self.root)
        assert captured_a is not None
        path_a = (
            self.root / generation.GENERATION_DIRECTORY / generation_a[7:]
            / "eigen" / "spectrum.json"
        )
        bytes_a = path_a.read_bytes()

        install_generation(
            self.root,
            generation.SCHEMA_V2,
            {"eigen/spectrum.json": b"B"},
        )

        self.assertEqual(path_a.read_bytes(), bytes_a)
        with self.assertRaisesRegex(generation.GenerationError, "changed"):
            captured_a.read_member("eigen/spectrum.json")
        captured_b = generation.capture(self.root)
        assert captured_b is not None
        self.assertEqual(captured_b.read_member("eigen/spectrum.json"), b"B")

    def test_oversized_marker_is_rejected_before_json_parse(self) -> None:
        marker_path = self.root / generation.IMMUTABLE_COMMIT_PATH
        marker_path.parent.mkdir(parents=True)
        with marker_path.open("wb") as stream:
            stream.truncate(generation.MAX_COMMIT_BYTES + 1)
        with self.assertRaisesRegex(generation.GenerationError, "bound"):
            generation.capture(self.root)


if __name__ == "__main__":
    unittest.main()
