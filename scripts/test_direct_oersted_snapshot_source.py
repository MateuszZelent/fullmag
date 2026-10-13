"""Interpreted ABI/source checks only; no native C++ or Rust execution."""
import ctypes
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
RECORD = "fullmag_fem_direct_oersted_target_record_v1"
SNAPSHOT = "fullmag_fem_direct_oersted_snapshot_result_v1"
SYMBOL = "fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1"


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def c_fields(name):
    header = source("native/include/fullmag_fem.h")
    match = re.search(r"typedef struct \{([^{}]*)\}\s*" + name + r"\s*;", header)
    assert match, f"missing C layout {name}"
    return re.findall(r"(\w+)\s*(\*?)\s*(\w+)(?:\[(\w+)\])?\s*;", match[1])


def rust_fields(name):
    rust = source("crates/fullmag-fem-sys/src/lib.rs")
    match = re.search(r"pub struct " + name + r" \{([^{}]*)\}", rust)
    assert match, f"missing Rust layout {name}"
    return re.findall(r"pub (\w+): ([^,]+),", match[1])


def body(text, marker):
    start = text.index(marker)
    start = text.index("{", start)
    depth = 1
    end = start + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start + 1:end - 1]


def test_existing_oersted_v1_layout_is_unchanged():
    fields = c_fields("fullmag_fem_steady_transport_rt0_oersted_result_v1")
    assert [row[2] for row in fields] == [
        "abi_version", "reserved_flags", "struct_size", "rt0", "h_xyz_apm",
        "h_xyz_apm_capacity", "h_xyz_apm_len", "source_target_pairs",
        "refined_pairs", "unconverged_pair_count", "maximum_pair_error_apm",
        "operator_version", "source_view_identity_digest", "error_message",
        "diagnostics_json",
    ]
    assert fields[-1] == ("char", "", "diagnostics_json", "1024")
    assert "target_records" not in source("native/include/fullmag_fem.h").split(
        "} fullmag_fem_steady_transport_rt0_oersted_result_v1;", 1)[0].rsplit(
            "typedef struct {", 1)[1]


def matching_fields(name):
    fields = c_fields(name)
    mapping = {"uint32_t": "u32", "uint64_t": "u64", "int32_t": "i32",
               "double": "f64", "char": "c_char", RECORD: RECORD}
    capacities = {"FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY": "96",
                  "FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY": "65"}
    expected = []
    for kind, pointer, field, count in fields:
        rust_kind = mapping[kind]
        if pointer:
            rust_kind = "*mut " + rust_kind
        if count:
            rust_kind = "[" + rust_kind + "; " + capacities.get(count, count) + "]"
        expected.append((field, rust_kind))
    assert rust_fields(name) == expected


def test_new_c_and_rust_record_fields_match_exactly():
    matching_fields(RECORD)


def test_new_c_and_rust_snapshot_fields_match_exactly():
    matching_fields(SNAPSHOT)


def test_twelve_owned_records_are_not_a_1024_byte_json_payload():
    fields = c_fields(RECORD)
    mapping = {"double": ctypes.c_double, "uint64_t": ctypes.c_uint64}
    layout = []
    for kind, pointer, name, count in fields:
        assert not pointer
        value = mapping[kind]
        layout.append((name, value * int(count) if count else value))
    record_type = type("TargetRecord", (ctypes.Structure,), {"_fields_": layout})
    assert ctypes.sizeof(record_type) == 96
    assert ctypes.sizeof(record_type * 12) == 1152
    records = (record_type * 12)()
    for index, row in enumerate(records):
        row.target_xyz_m[:] = (index, index + 0.5, -index)
        row.h_xyz_apm[:] = (index + 0.25, -index, index * 2)
        row.estimated_error_apm = index / 1000
        row.tolerance_apm = 1
        row.roundoff_indicator_apm = 1e-16
        row.final_leaf_count = index + 2
        row.kernel_evaluations = index + 20
        row.ledger_leaf_visits = index + 2
    copied = (record_type * 12).from_buffer_copy(bytes(records))
    assert bytes(copied) == bytes(records)
    assert [row.target_xyz_m[0] for row in copied] == list(range(12))


def test_snapshot_layout_matches_native_static_assertions_without_compiling():
    mapping = {"double": ctypes.c_double, "uint64_t": ctypes.c_uint64,
               "uint32_t": ctypes.c_uint32, "int32_t": ctypes.c_int32,
               "char": ctypes.c_char, RECORD: ctypes.c_void_p}
    capacities = {"FULLMAG_FEM_STEADY_TRANSPORT_RT0_STRING_CAPACITY": 96,
                  "FULLMAG_FEM_STEADY_TRANSPORT_RT0_DIGEST_CAPACITY": 65}
    layout = []
    for kind, pointer, name, count in c_fields(SNAPSHOT):
        value = ctypes.c_void_p if pointer else mapping[kind]
        if count:
            value *= capacities[count] if count in capacities else int(count)
        layout.append((name, value))
    snapshot_type = type("Snapshot", (ctypes.Structure,), {"_fields_": layout})
    assert ctypes.sizeof(snapshot_type) == 896
    assert snapshot_type.target_records.offset == 16
    assert snapshot_type.schema_version.offset == 152
    assert snapshot_type.source_view_identity_digest.offset == 568
    cpp = source("backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp")
    assert f"static_assert(sizeof({SNAPSHOT}) == 896);" in cpp


def test_export_copies_same_direct_result_before_publishing_length():
    cpp = source("backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp")
    solve = body(cpp, "int solve_rt0(")
    assert solve.count("DirectTetraQuadrature::Evaluate(") == 1
    export = body(solve, "if (quadrature_snapshot != nullptr)")
    for field in ("estimated_error_apm", "tolerance_apm", "roundoff_indicator_apm",
                  "final_leaf_count", "kernel_evaluations", "ledger_leaf_visits"):
        assert f"record.{field} = diagnostic.{field};" in export
    assert "target_points[index][component]" in export
    assert "direct.h_xyz_apm[3u * index + component]" in export
    assert export.index("record.h_xyz_apm") < export.index(
        "quadrature_snapshot->target_records_len = target_count;")
    for field in ("source_target_pairs", "refined_pairs", "unconverged_pair_count",
                  "maximum_pair_error_apm", "kernel_evaluations", "ledger_leaf_visits"):
        assert f"quadrature_snapshot->{field} = direct.diagnostics.{field};" in export
    for token in ("fem_direct_oersted_target_snapshot.v1", "global_target",
                  "sum_final_leaf_l2_difference.v1", "weighted_terms_binary64_epsilon.v1"):
        assert token in export
    for field in ("maximum_final_leaves_per_target", "maximum_kernel_evaluations",
                  "maximum_ledger_leaf_visits"):
        assert f"DirectTetraQuadrature::{field}" in export
    assert "quadrature_snapshot->relative_scale_floor_apm = 0.0;" in export


def test_new_entrypoint_preflights_and_resets_all_published_outputs():
    cpp = source("backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp")
    entry = body(cpp, 'extern "C" int ' + SYMBOL + "(")
    for refusal in ("quadrature_snapshot == nullptr", "reserved_flags != 0",
                    "struct_size != sizeof(*quadrature_snapshot)",
                    "target_records == nullptr", "target_records_capacity",
                    "FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_MAX_TARGETS"):
        assert refusal in entry
    assert entry.index("target_records_capacity") < entry.index(
        "solve_steady_transport_rt0_oersted_impl(")
    assert "set_error(result, message);" in entry
    assert "set_error(charge_snapshot, message);" in entry
    assert "set_error(quadrature_snapshot, message);" in entry
    assert "status != FULLMAG_FEM_OK" in entry
    reset = body(cpp, "void set_error(\n    " + SNAPSHOT)
    for field in ("target_records_len", "source_target_pairs", "refined_pairs",
                  "unconverged_pair_count", "maximum_pair_error_apm",
                  "kernel_evaluations", "ledger_leaf_visits"):
        assert f"result->{field} = 0" in reset
    assert SYMBOL in source("native/include/fullmag_fem.h")
    assert SYMBOL in source("crates/fullmag-fem-sys/src/lib.rs")


def test_preflight_and_kernel_failure_clear_tokens_options_and_all_three_results():
    cpp = source("backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp")
    reset = body(cpp, "void set_error(\n    " + SNAPSHOT)
    fields = c_fields(SNAPSHOT)
    for _, _, name, count in fields:
        if name in ("abi_version", "reserved_flags", "struct_size",
                    "target_records", "target_records_capacity", "error_message"):
            continue
        assert (f"result->{name}[0] = '\\0';" if count else
                f"result->{name} = 0") in reset
    entry = body(cpp, 'extern "C" int ' + SYMBOL + "(")
    fail = body(entry, "const auto fail =")
    for value in ("result", "charge_snapshot", "quadrature_snapshot"):
        assert f"set_error({value}, message);" in fail
    assert "result->struct_size >= sizeof(*result)" in fail
    assert "target_count == 0" in entry
    assert "target_count > FULLMAG_FEM_DIRECT_OERSTED_SNAPSHOT_MAX_TARGETS" in entry
    assert entry.index("char message[256];") < entry.index("return fail(message, status);")
    impl = body(cpp, "static int solve_steady_transport_rt0_oersted_impl(")
    assert "nullptr, charge_snapshot, quadrature_snapshot);" in impl
    assert "#else" in impl and "FULLMAG_FEM_ERR_UNAVAILABLE" in impl


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(unittest.FunctionTestCase(value)
                              for name, value in sorted(globals().items())
                              if name.startswith("test_") and callable(value))


if __name__ == "__main__":
    unittest.main()
