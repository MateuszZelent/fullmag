"""Independent face-moment check of the fixed inspection fixture's RT0 field.

Partial bounded extraction, not the canonical bundle validator. Native publication
owns full charge/source/field and input-pin validation. Retained physical DOF
weights are used, not independently certified as MFEM basis normalization.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import itertools
import math
import struct

from antenna_current_source_oracle import FIXTURE_INPUT_SHA256, fixture_input_digest

LIMIT = 2 << 20
FIELD_LIMIT = 20000


def fields(data):
    """Extract typed framing with fixed-fixture bounds; preserve repeated names."""
    if not data or len(data) > LIMIT:
        raise ValueError("RT0 fixture record exceeds bounded support")
    result, position = [], 0
    def take(size):
        nonlocal position
        if size > len(data) - position:
            raise ValueError("Truncated RT0 fixture field")
        begin = position
        position += size
        return data[begin:position]
    def word():
        return struct.unpack(">Q", take(8))[0]
    while position < len(data):
        if len(result) == FIELD_LIMIT:
            raise ValueError("RT0 fixture field count exceeds support")
        size = word()
        if not 0 < size <= 256:
            raise ValueError("RT0 fixture field name exceeds support")
        name = take(size).decode("utf-8")
        if "\0" in name:
            raise ValueError("Invalid RT0 fixture field name")
        tag = take(1)[0]
        value = take(word())
        if tag in (2, 4):
            if len(value) != 8:
                raise ValueError("RT0 fixture scalar is not eight bytes")
            value = struct.unpack(">Q" if tag == 2 else ">d", value)[0]
            if tag == 4 and (not math.isfinite(value) or
                            value == 0.0 and math.copysign(1.0, value) < 0):
                raise ValueError("Noncanonical RT0 fixture binary64")
        elif tag == 1:
            if len(value) > 8192 or b"\0" in value:
                raise ValueError("RT0 fixture text exceeds support")
            value = value.decode("utf-8")
        elif tag != 3:
            raise ValueError("Unknown RT0 fixture field tag")
        result.append((name, tag, value))
    return result


def one(rows, name, tag):
    values = [value for key, kind, value in rows if key == name and kind == tag]
    if len(values) != 1 or sum(key == name for key, _, _ in rows) != 1:
        raise ValueError(f"Ambiguous RT0 fixture field: {name}")
    return values[0]


def group(rows, count_name, expected_count, layout, *, skip=0):
    if one(rows, count_name, 2) != expected_count:
        raise ValueError(f"RT0 fixture count differs: {count_name}")
    start = next(i for i, row in enumerate(rows) if row[0] == count_name) + 1 + skip
    result = []
    for index in range(expected_count):
        chunk = rows[start + index * len(layout):start + (index + 1) * len(layout)]
        if [(name, tag) for name, tag, _ in chunk] != layout:
            raise ValueError(f"RT0 fixture sequence differs: {count_name}")
        result.append([value for _, _, value in chunk])
    return result


def signed(value):
    return value if value < 1 << 63 else value - (1 << 64)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def compare_rt0_fixture(inputs, bundle, *, flux_tolerance_a=1e-8):
    """Check all fixed-fixture DOF moments and element balances geometrically.

    Each canonical triangle moment is J dot cross(b-a,c-a)/2. Constant J is
    +ex in signal and -ex in return, in both device and leads. Its four normal
    moments uniquely determine the RT0 field on a tetrahedron. This checks the
    measured coefficients through retained native physical weights, not an
    independent implementation of MFEM's reference-basis normalization.
    """
    if fixture_input_digest(inputs) != FIXTURE_INPUT_SHA256:
        raise ValueError("RT0 check requires the exact fixed-fixture inputs")
    if isinstance(flux_tolerance_a, bool) or not math.isfinite(flux_tolerance_a) \
            or flux_tolerance_a <= 0:
        raise ValueError("Invalid RT0 fixture flux tolerance")
    outer = fields(bundle)
    if [(name, tag) for name, tag, _ in outer] != [
            ("schema", 1), ("operator_version", 1), ("field_scope", 1),
            ("charge_content_sha256", 1), ("charge_record", 3),
            ("source_content_sha256", 1), ("source_record", 3),
            ("field_content_sha256", 1), ("field_record", 3)] \
            or one(outer, "schema", 1) != "accepted_external_lead_bundle.ordered.v1" \
            or one(outer, "operator_version", 1) != "fem_accepted_external_lead_bundle.v1" \
            or one(outer, "field_scope", 1) != "external_electrode_truncation":
        raise ValueError("RT0 fixture bundle identity/order differs")
    for name in ("charge", "source", "field"):
        if hashlib.sha256(one(outer, name + "_record", 3)).hexdigest() != \
                one(outer, name + "_content_sha256", 1):
            raise ValueError("RT0 fixture nested hash differs")
    charge = fields(one(outer, "charge_record", 3))
    source = fields(one(outer, "source_record", 3))
    if one(charge, "schema", 1) != "accepted_terminal_charge_source.ordered.v1" \
            or one(charge, "operator", 1) != "fem_accepted_terminal_charge_source.v1" \
            or one(source, "schema", 1) != "accepted_external_lead_current_source.ordered.v2" \
            or one(source, "operator_version", 1) != "fem_accepted_external_lead_current_source.v2" \
            or one(source, "field_scope", 1) != "external_electrode_truncation" \
            or one(source, "charge_content_digest", 1) != one(outer, "charge_content_sha256", 1):
        raise ValueError("RT0 fixture charge/source association differs")
    authored = inputs["current_definition"]["conservative_current_source"]
    xyz, expected_elements = {}, set()
    for mesh, ids in ((inputs["device_mesh"], authored["device_stable_vertex_ids"]),
                      (authored["lead_mesh"], authored["lead_stable_vertex_ids"])):
        xyz.update((identity, tuple(point)) for identity, point in zip(ids, mesh["nodes"]))
        cells = mesh["cells"]
        for begin, end in zip(cells["offsets"], cells["offsets"][1:]):
            expected_elements.add(tuple(sorted(ids[i] for i in cells["nodes"][begin:end])))
    if one(source, "closure_revision", 1) != authored["revision"] \
            or one(charge, "stable_vertex_version", 1) != "stable_mesh_vertex_u64.v1":
        raise ValueError("RT0 fixture closure/vertex identity differs")
    vertices = group(charge, "vertices", 48,
        [("vertex_id", 2)] + [("xyz_m", 4)] * 3 +
        [("potential_v", 4), ("reaction_a", 4), ("vertex_component_id", 2)], skip=1)
    if len({row[0] for row in vertices}) != 48 \
            or {row[0]: tuple(row[1:4]) for row in vertices} != xyz:
        raise ValueError("RT0 fixture retained geometry differs from authored inputs")
    elements = group(charge, "elements", 36,
        [("attribute", 2)] + [("vertex_id", 2)] * 4 + [("conductivity_spm", 4)])
    element_keys = [tuple(sorted(row[1:5])) for row in elements]
    if len(set(element_keys)) != 36 or set(element_keys) != expected_elements:
        raise ValueError("RT0 fixture tetrahedral topology differs")
    incidence = defaultdict(list)
    for index, element in enumerate(element_keys):
        for face in itertools.combinations(element, 3):
            incidence[face].append(index)
    face_rows = group(charge, "faces", 108,
        [("vertex_id", 2)] * 3 + [("first_element", 2),
        ("second_element", 2), ("signed_rt0_dof", 2)])
    coefficients = [row[0] for row in group(charge, "rt0", 108, [("rt0_flux_a", 4)])]
    ledger = group(source, "face_count", 108,
        [("face_vertex_id", 2)] * 3 + [("face_side_count", 2),
        ("face_rt0_to_canonical_weight", 4), ("face_canonical_flux_a", 4),
        ("face_first_outward_a", 4), ("face_second_outward_a", 4),
        ("face_canonical_jump_a", 4)])
    by_key = {tuple(row[:3]): row for row in ledger}
    if len(by_key) != 108 or set(by_key) != set(incidence):
        raise ValueError("RT0 fixture physical face map differs")
    seen_faces, seen_dofs = set(), set()
    balances = [[] for _ in elements]
    maximum_error = 0.0
    for row in face_rows:
        face = tuple(sorted(row[:3]))
        first, second, encoded = (signed(v) for v in row[3:])
        dof = encoded if encoded >= 0 else -1 - encoded
        owners = incidence.get(face, [])
        if face in seen_faces or dof in seen_dofs or not 0 <= dof < 108 \
                or not owners or first not in owners \
                or (len(owners) == 1 and second != -1) \
                or (len(owners) == 2 and (second not in owners or second == first)):
            raise ValueError("RT0 fixture face/DOF adjacency differs")
        seen_faces.add(face)
        seen_dofs.add(dof)
        physical = by_key[face]
        if physical[3] != len(owners) or physical[4] == 0.0:
            raise ValueError("RT0 fixture face weight/sides differ")
        a, b, c = (xyz[i] for i in face)
        area = tuple(v / 2 for v in cross(tuple(v-u for u, v in zip(a, b)),
                                         tuple(v-u for u, v in zip(a, c))))
        direction = 1.0 if a[1] <= 1.0 else -1.0
        expected = direction * area[0]
        actual = physical[4] * coefficients[dof]
        error = max(abs(actual - expected), abs(physical[5] - actual), abs(physical[8]))
        if not math.isfinite(actual) or not math.isfinite(error) or error > flux_tolerance_a:
            raise ValueError(f"RT0 fixture face moment mismatch: {face}")
        maximum_error = max(maximum_error, error)
        for owner in owners:
            opposite = next(v for v in element_keys[owner] if v not in face)
            orientation = math.fsum(v * (xyz[opposite][i] - a[i]) for i, v in enumerate(area))
            if orientation == 0.0:
                raise ValueError("Degenerate RT0 fixture face orientation")
            balances[owner].append(actual if orientation < 0 else -actual)
    maximum_balance = max(abs(math.fsum(values)) for values in balances)
    if maximum_balance > flux_tolerance_a:
        raise ValueError("RT0 fixture independently summed element balance failed")
    return {"scope": "fixed_fixture_geometric_RT0_moments_only", "comparison": "PASS",
        "face_count": 108, "element_count": 36, "flux_tolerance_a": flux_tolerance_a,
        "max_face_moment_error_a": maximum_error, "max_element_flux_sum_a": maximum_balance,
        "physical_DOF_weights": "retained_native_weights_not_independently_certified",
        "native_canonical_bundle_redecoded": False, "physics_qualified": False,
        "qualification": "NOT VERIFIED"}


def compare_bundle_observables(inputs, values):
    """Bind derived V/xyz/H bytes to the same partial bounded bundle extraction.

    This is not a full charge/source decoder or native request-pin validation.
    Callers must also run the fixed-fixture geometry/RT0 and provenance gates.
    Global-target diagnostics are retained and structurally checked, not an
    adaptive-history certificate. Exact native hypot/fma tolerance binding is
    owned by the canonical Rust decoder, not recomputed across Python libraries.
    """
    def require(condition, message):
        if not condition:
            raise ValueError("Bundle observable association: " + message)
    def real_bytes(numbers):
        require(all(type(v) in (int, float) and math.isfinite(v) for v in numbers),
                "nonfinite or untyped derived scalar")
        return b"".join(struct.pack(">d", v) for v in numbers)
    require(fixture_input_digest(inputs) == FIXTURE_INPUT_SHA256, "fixed input pin differs")
    outer = fields(values["bundle_bytes"])
    nested = {name: one(outer, name + "_record", 3) for name in ("charge", "source", "field")}
    digests = {name: one(outer, name + "_content_sha256", 1) for name in nested}
    require(values["nested_content_sha256"] == digests and
            all(hashlib.sha256(nested[name]).hexdigest() == digests[name] for name in nested),
            "manifest/nested digests differ")
    charge, field = fields(nested["charge"]), fields(nested["field"])
    vertices = group(charge, "vertices", 48,
        [("vertex_id", 2)] + [("xyz_m", 4)] * 3 +
        [("potential_v", 4), ("reaction_a", 4), ("vertex_component_id", 2)], skip=1)
    by_id = {row[0]: row[4] for row in vertices}
    device_ids = inputs["current_definition"]["conservative_current_source"]["device_stable_vertex_ids"]
    require(len(by_id) == 48 and values["device_ids"] == device_ids and
            all(identity in by_id for identity in device_ids), "device selection differs")
    require(len(values["potential_v"]) == 16 and real_bytes(values["potential_v"]) ==
            real_bytes([by_id[identity] for identity in device_ids]), "derived V differs from charge")
    prefix = [("schema", 1), ("operator_version", 1), ("quadrature_operator_version", 1),
        ("field_scope", 1), ("accepted_external_source_digest", 1), ("charge_content_digest", 1),
        ("base_quadrature_order", 2), ("maximum_subdivision_depth", 2),
        ("absolute_tolerance_apm", 4), ("relative_tolerance", 4),
        ("relative_scale_floor_apm", 4), ("maximum_source_target_pairs", 2)]
    sample = [("target_coordinate_m", 4)] * 3 + [("h_component_apm", 4)] * 3
    suffix = [("source_target_pairs", 2), ("refined_pairs", 2),
              ("unconverged_pair_count", 2), ("maximum_pair_error_apm", 4)]
    quadrature_version = one(field, "quadrature_operator_version", 1)
    identity = (one(field, "schema", 1), one(field, "operator_version", 1), quadrature_version)
    legacy = identity[:2] == ("accepted_external_lead_field.ordered.v1",
                             "fem_accepted_external_lead_field.v1") and quadrature_version in {
        "fem_oersted_direct_tetra_quadrature.v1", "fem_oersted_direct_tetra_quadrature.v2"}
    global_target = identity == ("accepted_external_lead_field.ordered.v2",
        "fem_accepted_external_lead_field.v2", "fem_oersted_direct_tetra_quadrature.v3")
    require(legacy or global_target, "mixed or unknown field schema/operator/quadrature")
    if global_target:
        prefix += [("quadrature_scope", 1), ("estimated_error_policy", 1),
            ("roundoff_indicator_policy", 1), ("maximum_final_leaves_per_target", 2),
            ("maximum_kernel_evaluations", 2), ("maximum_ledger_leaf_visits", 2)]
        sample += [("target_estimated_error_apm", 4), ("target_tolerance_apm", 4),
            ("target_roundoff_indicator_apm", 4), ("target_final_leaf_count", 2),
            ("target_kernel_evaluations", 2), ("target_ledger_leaf_visits", 2)]
        suffix += [("kernel_evaluations", 2), ("ledger_leaf_visits", 2)]
    prefix += [("target_count", 2)]
    require([(name, tag) for name, tag, _ in field] == prefix + sample * 4 + suffix,
            "fixed field framing differs")
    for name, expected in {
            "field_scope": "external_electrode_truncation",
            "accepted_external_source_digest": digests["source"],
            "charge_content_digest": digests["charge"]}.items():
        require(one(field, name, 1) == expected, "field identity/source differs")
    require(2 <= one(field, "base_quadrature_order", 2) <= 16 and
            one(field, "maximum_subdivision_depth", 2) <= 6 and
            one(field, "absolute_tolerance_apm", 4) >= 0 and
            one(field, "relative_tolerance", 4) >= 0 and
            one(field, "relative_scale_floor_apm", 4) == (0.0 if global_target else 1.0) and
            144 <= one(field, "maximum_source_target_pairs", 2) <= 1000000,
            "field policy exceeds fixed bounded support")
    require(one(field, "target_count", 2) == 4 and len(values["positions_m"]) == 4 and
            len(values["field_apm"]) == 4 and
            all(len(row) == 3 for row in values["positions_m"] + values["field_apm"]),
            "derived sample cardinality differs")
    samples = group(field, "target_count", 4, sample)
    require(real_bytes([v for row in samples for v in row[:3]]) ==
            real_bytes([v for row in values["positions_m"] for v in row]),
            "derived targets differ from field")
    require(real_bytes([v for row in samples for v in row[3:6]]) ==
            real_bytes([v for row in values["field_apm"] for v in row]),
            "derived H differs from field")
    retained_global = None
    if global_target:
        for name, expected in {
                "quadrature_scope": "global_target",
                "estimated_error_policy": "sum_final_leaf_l2_difference.v1",
                "roundoff_indicator_policy": "weighted_terms_binary64_epsilon.v1"}.items():
            require(one(field, name, 1) == expected, "global target policy differs")
        for name, expected in {"maximum_final_leaves_per_target": 1000000,
                "maximum_kernel_evaluations": 100000000,
                "maximum_ledger_leaf_visits": 100000000}.items():
            require(one(field, name, 2) == expected, "global target resource cap differs")
        targets = []
        for row in samples:
            error, tolerance, roundoff, leaves, kernels, visits = row[6:]
            require(0 <= error <= tolerance and 0 <= roundoff <= tolerance and
                    math.fsum((error, -tolerance, roundoff)) <= 0 and
                    36 <= leaves <= 1000000 and 72 <= kernels <= 100000000 and
                    36 <= visits <= 100000000, "global target diagnostics exceed retained budget")
            targets.append(dict(zip(("estimated_error_apm", "tolerance_apm",
                "roundoff_indicator_apm", "final_leaf_count", "kernel_evaluations",
                "ledger_leaf_visits"), row[6:])))
        roots, refined = one(field, "source_target_pairs", 2), one(field, "refined_pairs", 2)
        kernels, visits = one(field, "kernel_evaluations", 2), one(field, "ledger_leaf_visits", 2)
        require(roots == 144 and one(field, "unconverged_pair_count", 2) == 0 and
                one(field, "maximum_pair_error_apm", 4) >= 0 and
                refined <= roots * (8 ** one(field, "maximum_subdivision_depth", 2) - 1) // 7 and
                sum(row[9] for row in samples) == roots + 7 * refined and
                sum(row[10] for row in samples) == kernels <= 100000000 and
                sum(row[11] for row in samples) == visits <= 100000000,
                "global target work/leaf totals differ")
        retained_global = {name: one(field, name, tag) for name, tag in [
            ("quadrature_scope", 1), ("estimated_error_policy", 1), ("roundoff_indicator_policy", 1),
            ("maximum_final_leaves_per_target", 2), ("maximum_kernel_evaluations", 2),
            ("maximum_ledger_leaf_visits", 2)]}
        retained_global.update({"targets": targets, "kernel_evaluations": kernels,
            "ledger_leaf_visits": visits, "exact_native_tolerance_recomputed": False,
            "adaptation_history_verified": False})
    return {"scope": "fixed_fixture_exact_bundle_observable_association", "comparison": "PASS",
        "device_count": 16, "target_count": 4, "nested_content_sha256": digests,
        "quadrature_operator_version": quadrature_version,
        "retained_global_target_diagnostics": retained_global,
        "native_canonical_bundle_redecoded": False, "physics_qualified": False,
        "qualification": "NOT VERIFIED"}
