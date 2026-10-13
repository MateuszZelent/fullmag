"""Interpreted C-source/layout guards, not native execution or physics proof."""

from __future__ import annotations

import ctypes
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
HEADER_PATH = ROOT / "native/include/fullmag_fem.h"
C_API_PATH = ROOT / "backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp"
HEADER = HEADER_PATH.read_text(encoding="utf-8")
C_API = C_API_PATH.read_text(encoding="utf-8")
RUST_ABI = (ROOT / "crates/fullmag-fem-sys/src/lib.rs").read_text(encoding="utf-8")
RUST_ADAPTER = (ROOT / "crates/fullmag-runner/src/native_fem/accepted_external_lead.rs").read_text(encoding="utf-8")


def declaration(text: str, name: str) -> str:
    match = re.search(r"typedef struct\s*\{([^{}]*)\}\s*" + re.escape(name) + r";", text)
    if match is None:
        raise AssertionError(f"missing structure {name}")
    return match.group(1)


def layout(name: str) -> type[ctypes.Structure]:
    types = {"uint32_t": ctypes.c_uint32, "uint64_t": ctypes.c_uint64}
    fields = []
    for line in declaration(HEADER, name).splitlines():
        line = line.strip()
        if not line:
            continue
        match = re.fullmatch(r"(uint32_t|uint64_t) (\w+);", line)
        if match:
            fields.append((match[2], types[match[1]]))
            continue
        match = re.fullmatch(r"uint8_t \*(\w+);", line)
        if match:
            fields.append((match[1], ctypes.POINTER(ctypes.c_uint8)))
            continue
        match = re.fullmatch(r"char (\w+)\[([\w]+)\];", line)
        if match:
            count = 96 if match[2] == "FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_TEXT_CAPACITY" else int(match[2])
            fields.append((match[1], ctypes.c_char * count))
            continue
        raise AssertionError(f"unsupported layout field: {line}")
    return type(name, (ctypes.Structure,), {"_fields_": fields})


def body(text: str, function: str) -> str:
    start = text.index(function + "(")
    begin = text.index("{", start)
    depth = 1
    for end in range(begin + 1, len(text)):
        depth += (text[end] == "{") - (text[end] == "}")
        if depth == 0:
            return text[begin + 1 : end]
    raise AssertionError(f"unclosed function {function}")


def rust_layout(name: str) -> type[ctypes.Structure]:
    match = re.search(r"pub struct " + re.escape(name) + r"\s*\{([^{}]*)\}", RUST_ABI)
    if match is None:
        raise AssertionError(f"missing Rust structure {name}")
    fields = []
    for line in match[1].splitlines():
        line = line.strip()
        if not line:
            continue
        field = re.fullmatch(r"pub (\w+): (u32|u64|\*mut u8|\[c_char; (?:\d+|FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_TEXT_CAPACITY)\]),", line)
        if field is None:
            raise AssertionError(f"unsupported Rust layout field: {line}")
        kind = field[2]
        if kind.startswith("[c_char;"):
            count = kind[len("[c_char; "):-1]
            value = ctypes.c_char * (96 if count == "FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_TEXT_CAPACITY" else int(count))
        else:
            value = {"u32": ctypes.c_uint32, "u64": ctypes.c_uint64, "*mut u8": ctypes.POINTER(ctypes.c_uint8)}[kind]
        fields.append((field[1], value))
    return type(name, (ctypes.Structure,), {"_fields_": fields})


class CurrentDisplayAbiSourceChecks(unittest.TestCase):
    def test_rust_and_c_result_declarations_match(self) -> None:
        for name in ("fullmag_fem_accepted_external_lead_result_v1", "fullmag_fem_accepted_external_lead_result_v2"):
            native, rust = layout(name), rust_layout(name)
            self.assertEqual(native._fields_, rust._fields_)
            self.assertEqual(ctypes.sizeof(native), ctypes.sizeof(rust))
        self.assertIn("FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_DISPLAY_ABI_VERSION: u32 = 2;", RUST_ABI)
        self.assertIn("fullmag:fem-accepted-external-lead:abi:v2:owned-current-display", RUST_ABI)
        self.assertIn("pub fn fullmag_fem_solve_accepted_external_lead_field_v2(", RUST_ABI)

    def test_rust_adapter_uses_one_v2_call_then_binds_both_records(self) -> None:
        adapter = body(RUST_ADAPTER, "solve_accepted_external_lead_display")
        self.assertEqual(adapter.count("ffi::fullmag_fem_solve_accepted_external_lead_field_v2("), 1)
        self.assertNotIn("ffi::fullmag_fem_solve_accepted_external_lead_field_v1(", adapter)
        self.assertLess(adapter.index("record::decode_bundle("), adapter.index("decode_current_display("))
        for field in ("canonical_payload_len", "current_display_payload_len"):
            self.assertIn(f"output.{field} == 0", adapter)
        self.assertIn("current_display_payload == current_payload.as_mut_ptr()", adapter)
        self.assertIn("current_display_payload_capacity == current_payload.len() as u64", adapter)
        self.assertIn("&bundle)?", adapter)

    def test_legacy_declarations_are_unchanged(self) -> None:
        baseline = subprocess.run(
            ["git", "show", "HEAD:native/include/fullmag_fem.h"],
            cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
        ).stdout
        for name in ("fullmag_fem_accepted_external_lead_request_v1", "fullmag_fem_accepted_external_lead_result_v1"):
            self.assertEqual(declaration(HEADER, name), declaration(baseline, name))

    def test_result_v2_x64_layout_is_frozen(self) -> None:
        self.assertEqual(ctypes.sizeof(ctypes.c_void_p), 8, "this gate targets the supported x64 ABI")
        v1 = layout("fullmag_fem_accepted_external_lead_result_v1")
        v2 = layout("fullmag_fem_accepted_external_lead_result_v2")
        self.assertEqual(ctypes.sizeof(v1), 656)
        self.assertEqual(ctypes.sizeof(v2), 944)
        self.assertEqual(ctypes.alignment(v2), 8)
        for field, _ in v1._fields_:
            self.assertEqual(getattr(v2, field).offset, getattr(v1, field).offset)
        for field, offset in {
            "current_display_payload": 656, "current_display_payload_capacity": 664,
            "current_display_payload_len": 672, "current_display_digest_schema": 680,
            "current_display_operator_version": 776, "current_display_content_sha256": 872,
        }.items():
            self.assertEqual(getattr(v2, field).offset, offset)
            self.assertIn(f"offsetof(fullmag_fem_accepted_external_lead_result_v2, {field}) == {offset}", C_API)

    def test_same_importer_and_exact_admission_precede_single_workflow(self) -> None:
        legacy = body(C_API, "solve_accepted_external_lead")
        display = body(C_API, "solve_accepted_external_lead_display")
        for function in (legacy, display):
            self.assertEqual(function.count("resolve_accepted_external_lead_request(request)"), 1)
            self.assertNotIn("solve_accepted_terminal_charge_source(", function)
        self.assertEqual(display.count("workflow::solve_accepted_external_lead_display_bundle("), 1)
        self.assertNotIn("workflow::solve_accepted_external_lead_bundle(", display)
        self.assertLess(display.index("external_lead_ranges_overlap("), display.index("resolve_accepted_external_lead_request(request)"))
        self.assertLess(display.index("expected_display_size <= result.current_display_payload_capacity"),
                        display.index("workflow::solve_accepted_external_lead_display_bundle("))
        self.assertIn("current.canonical_content_bytes.size() == expected_display_size", display)

    def test_publication_and_failure_reset_cover_both_results(self) -> None:
        display = body(C_API, "solve_accepted_external_lead_display")
        first_copy = display.index("std::copy(bundle.canonical_content_bytes")
        second_copy = display.index("std::copy(current.canonical_content_bytes")
        self.assertLess(display.rindex("copy_rt0_text("), first_copy)
        self.assertLess(first_copy, second_copy)
        self.assertLess(second_copy, display.index("published.canonical_payload_len ="))
        self.assertLess(display.index("published.current_display_payload_len ="), display.index("result = published;"))
        reset = re.search(r"void set_error\(fullmag_fem_accepted_external_lead_result_v2 \*result,.*?\n\}", C_API, re.S)
        self.assertIsNotNone(reset)
        text = reset.group(0)
        self.assertIn("result->struct_size < sizeof(*result)", text)
        for field in ("canonical_payload_len", "current_display_payload_len"):
            self.assertIn(f"result->{field} = 0;", text)
        for field in ("digest_schema", "operator_version", "layout_fingerprint", "content_sha256",
                      "current_display_digest_schema", "current_display_operator_version", "current_display_content_sha256"):
            self.assertIn(f"result->{field}[0] = '\\0';", text)

    def test_range_model_handles_touching_alias_and_overflow(self) -> None:
        maximum = (1 << 64) - 1

        def overlaps(first: int, first_size: int, second: int, second_size: int) -> bool:
            if not first or not second or first_size > maximum - first or second_size > maximum - second:
                raise ValueError("invalid address range")
            return first < second + second_size and second < first + first_size

        self.assertFalse(overlaps(100, 20, 120, 30))
        self.assertTrue(overlaps(100, 20, 119, 30))
        self.assertTrue(overlaps(100, 20, 100, 20))
        self.assertTrue(overlaps(100, 100, 150, 10))
        for args in ((0, 1, 100, 1), (maximum - 1, 3, 100, 1), (100, 1, maximum - 1, 3)):
            with self.assertRaises(ValueError):
                overlaps(*args)
        ranges = body(C_API, "external_lead_ranges_overlap")
        self.assertIn("first_size <= maximum - first_begin", ranges)
        self.assertIn("second_size <= maximum - second_begin", ranges)


if __name__ == "__main__":
    unittest.main(verbosity=2)
