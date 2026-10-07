"""Partial-record synthetic RT0 regressions; never native execution proof."""
import hashlib
import itertools
from pathlib import Path
import struct

import pytest
from scripts import antenna_rt0_fixture_check as check
from scripts.compare_managed_antenna_ram import reconstruct_inputs


@pytest.fixture(scope="module")
def inputs():
    repo = Path(__file__).resolve().parents[1]
    return reconstruct_inputs(repo, repo / "examples/fem_antenna_current_source_inspection.py")


def encode(rows):
    data = bytearray()
    for name, tag, value in rows:
        name = name.encode()
        value = (value.encode() if tag == 1 else struct.pack(">Q", value) if tag == 2
                 else struct.pack(">d", value) if tag == 4 else value)
        data.extend(struct.pack(">Q", len(name)) + name + bytes([tag]) +
                    struct.pack(">Q", len(value)) + value)
    return bytes(data)


def synthetic_bundle(inputs, mutation=None):
    # Deliberately partial synthetic records. Missing native terminal/rank/etc.
    # sections make these unsuitable for native canonical publication.
    source_input = inputs["current_definition"]["conservative_current_source"]
    xyz, elements = {}, []
    for mesh, ids in ((inputs["device_mesh"], source_input["device_stable_vertex_ids"]),
                      (source_input["lead_mesh"], source_input["lead_stable_vertex_ids"])):
        xyz.update(zip(ids, mesh["nodes"]))
        for begin, end in zip(mesh["cells"]["offsets"], mesh["cells"]["offsets"][1:]):
            elements.append(tuple(sorted(ids[i] for i in mesh["cells"]["nodes"][begin:end])))
    incidence = {}
    for index, element in enumerate(elements):
        for face in itertools.combinations(element, 3):
            incidence.setdefault(face, []).append(index)
    faces = sorted(incidence)
    charge = [("schema", 1, "accepted_terminal_charge_source.ordered.v1"),
        ("operator", 1, "fem_accepted_terminal_charge_source.v1"), ("vertices", 2, 48),
        ("stable_vertex_version", 1, "stable_mesh_vertex_u64.v1")]
    for identity, position in sorted(xyz.items()):
        charge += [("vertex_id", 2, identity)] + [("xyz_m", 4, v) for v in position] + [
            ("potential_v", 4, 0.0), ("reaction_a", 4, 0.0), ("vertex_component_id", 2, 1)]
    charge += [("elements", 2, 36)]
    for element in elements:
        charge += [("attribute", 2, 1)] + [("vertex_id", 2, v) for v in element] + [
            ("conductivity_spm", 4, 4.0)]
    charge += [("faces", 2, 108)]
    moments, weights = [], []
    for index, face in enumerate(faces):
        dof = len(faces) - 1 - index
        encoded = dof if index % 2 == 0 else (1 << 64) - 1 - dof
        owners = incidence[face]
        charge += [("vertex_id", 2, v) for v in face] + [
            ("first_element", 2, owners[0]),
            ("second_element", 2, owners[1] if len(owners) == 2 else (1 << 64) - 1),
            ("signed_rt0_dof", 2, encoded)]
        a, b, c = (xyz[v] for v in face)
        # Independent exact-in-this-fixture determinant, not the checker helper.
        moment = ((b[1]-a[1])*(c[2]-a[2]) - (b[2]-a[2])*(c[1]-a[1])) / 2
        moments.append(moment if a[1] <= 1 else -moment)
        weights.append(2.0 if index % 2 == 0 else -2.0)
    charge += [("rt0", 2, 108)] + [("rt0_flux_a", 4, value or 0.0)
        for value in reversed([moment / weight for moment, weight in zip(moments, weights)])]
    source = [("schema", 1, "accepted_external_lead_current_source.ordered.v2"),
        ("operator_version", 1, "fem_accepted_external_lead_current_source.v2"),
        ("field_scope", 1, "external_electrode_truncation"),
        ("charge_content_digest", 1, "placeholder"),
        ("closure_revision", 1, source_input["revision"]), ("face_count", 2, 108)]
    for face, moment, weight in zip(faces, moments, weights):
        source += [("face_vertex_id", 2, v) for v in face] + [
            ("face_side_count", 2, len(incidence[face])),
            ("face_rt0_to_canonical_weight", 4, weight),
            ("face_canonical_flux_a", 4, moment or 0.0),
            ("face_first_outward_a", 4, 0.0), ("face_second_outward_a", 4, 0.0),
            ("face_canonical_jump_a", 4, 0.0)]
    if mutation:
        mutation(charge, source)
    charge_bytes = encode(charge)
    charge_sha = hashlib.sha256(charge_bytes).hexdigest()
    source[3] = ("charge_content_digest", 1, charge_sha)
    source_bytes = encode(source)
    outer = [("schema", 1, "accepted_external_lead_bundle.ordered.v1"),
        ("operator_version", 1, "fem_accepted_external_lead_bundle.v1"),
        ("field_scope", 1, "external_electrode_truncation")]
    for name, data in (("charge", charge_bytes), ("source", source_bytes),
                       ("field", b"synthetic field: not canonical native bytes")):
        outer += [(name + "_content_sha256", 1, hashlib.sha256(data).hexdigest()),
                  (name + "_record", 3, data)]
    return encode(outer)


def change(rows, name, value, *, occurrence=0):
    matches = [i for i, row in enumerate(rows) if row[0] == name]
    index = matches[occurrence]
    rows[index] = (name, rows[index][1], value)


def test_all_geometric_moments_with_permuted_signed_nonunit_dofs(inputs):
    result = check.compare_rt0_fixture(inputs, synthetic_bundle(inputs))
    assert result["face_count"] == 108 and result["element_count"] == 36
    assert result["max_face_moment_error_a"] == result["max_element_flux_sum_a"] == 0.0
    assert result["physics_qualified"] is False
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["physical_DOF_weights"] == "retained_native_weights_not_independently_certified"


@pytest.mark.parametrize("mutation", ["coefficient", "weight", "canonical", "jump",
                                      "xyz", "dof", "adjacency", "face_count"])
def test_resigned_mutations_cannot_hide_rt0_or_geometry_mismatch(inputs, mutation):
    def mutate(charge, source):
        if mutation == "coefficient": change(charge, "rt0_flux_a", 1.0)
        elif mutation == "weight": change(source, "face_rt0_to_canonical_weight", 0.0)
        elif mutation == "canonical": change(source, "face_canonical_flux_a", 1.0)
        elif mutation == "jump": change(source, "face_canonical_jump_a", 1.0)
        elif mutation == "xyz": change(charge, "xyz_m", 10.0)
        elif mutation == "dof": change(charge, "signed_rt0_dof", 108)
        elif mutation == "adjacency": change(charge, "first_element", 36)
        else: change(source, "face_count", 107)
    with pytest.raises(ValueError, match="RT0 fixture"):
        check.compare_rt0_fixture(inputs, synthetic_bundle(inputs, mutate))


def test_wrong_input_pin_and_nested_hash_are_rejected(inputs):
    with pytest.raises(ValueError, match="exact fixed-fixture inputs"):
        check.compare_rt0_fixture({**inputs, "port_mode": {}}, synthetic_bundle(inputs))
    outer = check.fields(synthetic_bundle(inputs))
    change(outer, "charge_content_sha256", "0" * 64)
    with pytest.raises(ValueError, match="nested hash"):
        check.compare_rt0_fixture(inputs, encode(outer))


@pytest.mark.parametrize("data", [b"", b"\0" * 7, struct.pack(">Q", 257),
    encode([("number", 4, float("nan"))]), encode([("number", 4, -0.0)]),
    encode([("unknown", 9, b"x")]), b"x" * (check.LIMIT + 1)],
    ids=["empty", "truncated-word", "name-bound", "nan", "negative-zero",
         "unknown-tag", "oversized-record"])
def test_framing_and_finite_bounded_scalar_checks(data):
    with pytest.raises(ValueError):
        check.fields(data)


def test_duplicate_count_and_nonpositive_tolerance_are_rejected(inputs):
    def mutate(charge, source):
        charge.append(("rt0", 2, 108))
    with pytest.raises(ValueError, match="Ambiguous"):
        check.compare_rt0_fixture(inputs, synthetic_bundle(inputs, mutate))
    for tolerance in (0.0, -1.0, float("nan"), True):
        with pytest.raises(ValueError, match="tolerance"):
            check.compare_rt0_fixture(inputs, synthetic_bundle(inputs), flux_tolerance_a=tolerance)
