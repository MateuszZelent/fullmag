"""Synthetic metadata fixtures; no native or scientific qualification."""
import unittest
import copy
from hashlib import sha256
import json
import struct

from smoke_antenna_closed_loop_inspection import validate_resource, verify_field_evidence
from smoke_antenna_external_lead_inspection import SmokeError


def resource(sample_cells=24, target_count=14, source_cells=1867):
    digest = "sha256:" + "b" * 64
    source = {
        "digest_encoding": "canonical_named_fields_be_bits.v2",
        "periodic_operator_version": "fem_charge_h1_periodic_jump.v2",
        "closure_operator_version": "fem_closed_current_geometry.v2",
        "conservative_current_operator_version": "fem_conservative_current_rt0_view.v1",
        "weak_reaction_ledger_version": "original_k_paired_vertex_reactions.v2",
        "sampling_policy": "cell_center_and_cell_local_vertices.v1",
        "source_current_orientation": "authored_minus_outward.v1",
        **{key: "a" * 64 for key in (
            "prepared_execution_digest", "accepted_charge_field_digest",
            "accepted_source_state_digest", "view_identity_digest",
            "current_balance_certificate_digest")},
        "source_current_a": 0.1, "source_absolute_flux_a": 0.1,
        "potential_jump_v": 0.25, "measured_potential_jump_v": 0.25,
        "gauge_mean_v": 0.0, "charge_relative_residual": 1e-15,
        "max_paired_weak_flux_mismatch_a": 0.0,
        "terminal_observation_currents": {},
    }
    n, c, t, h, f, w = 678, source_cells, target_count, sample_cells, 4 * source_cells, 2
    specs = {
        "stable_vertex_ids": ("node_u64_le", "1", n * 8),
        "vertex_xyz": ("node_xyz_f64_le", "m", n * 24),
        "sample_xyz": ("sample_xyz_f64_le", "m", t * 24),
        "sample_cells": ("sample_tet4_u32_le", "1", h * 16),
        "conductivity": ("cell_f64_le", "S/m", c * 8),
        "v_raw": ("node_f64_le", "V", n * 8),
        "v_per_a": ("node_f64_le", "V/A", n * 8),
        "j_center_raw": ("cell_xyz_f64_le", "A/m^2", c * 24),
        "j_center_per_a": ("cell_xyz_f64_le", "1/m^2", c * 24),
        "j_local_raw": ("cell_local4_xyz_f64_le", "A/m^2", c * 96),
        "j_local_per_a": ("cell_local4_xyz_f64_le", "1/m^2", c * 96),
        "h_raw": ("sample_xyz_f64_le", "A/m", t * 24),
        "h_per_a": ("sample_xyz_f64_le", "1/m", t * 24),
        "cells": ("closed_loop_cell280_le", "SI", c * 280),
        "faces": ("face_u64x3_f64_le", "A", f * 32),
        "weak": ("paired_u64x2_f64x2_le", "A", w * 32),
        **{key: ("canonical_named_fields_be_bits.v2", "1", 1) for key in (
            "prepared_preimage", "charge_preimage", "source_preimage")},
        "certificate": ("canonical_balance_certificate.v1", "1", 1),
        "authoring_receipt": ("utf8_json_input.v1", "1", 1),
        "direct_evidence": ("fem_direct_oersted_evidence.v2", "SI", 296 + t * 96),
    }
    manifest = {
        "schema_version": "antenna_field_solution.v2", "status": "inspection_only",
        "direct_evidence_schema": "fem_direct_oersted_evidence.v2",
        "validation_scope": "full_cold_bundle", "qualification": "NOT VERIFIED",
        "field_scope": "full_closed_loop.inspection_only.v2",
        "content_digest": digest, "solution_id": "output", "stage_id": "inspect_loop",
        "port_mode_id": "port", "source_object_id": "antenna",
        "current_transport_id": "transport", "sample_carrier": {},
        "requested_intent": {}, "resolved_execution": {}, "source": source,
        "signed_normalization_a": 0.1, "scale_per_a": 10.0,
        "vertex_count": n, "cell_count": c, "target_count": t,
        "sample_cell_count": h, "face_count": f, "weak_reaction_count": w,
        "payloads": {
            key: {"path": f"antenna/field_solutions/output/{key}.bin",
                  "sha256": "c" * 64, "byte_length": size, "layout": layout, "unit": unit}
            for key, (layout, unit, size) in specs.items()
        },
    }
    return {
        "runtime_stage_id": "runtime-stage",
        "resource_id": "data/antenna/stages/runtime-stage/external-lead-inspection",
        **{key: "owner" for key in (
            "session_id", "session_epoch", "request_scope_epoch", "run_id")},
        "stage_id": "inspect_loop", "output_id": "output", "port_mode_id": "port",
        "source_object_id": "antenna", "stage_revision": 1,
        "record_content_digest": "sha256:" + "d" * 64,
        "schema_version": "antenna_closed_loop_stage_output.v2",
        "stage_kind": "antenna_field_solve", "resolved_action": "closed_loop_inspection",
        "status": "inspection_only", "qualification": "NOT VERIFIED",
        "field_scope": "full_closed_loop.inspection_only.v2",
        "closed_loop_manifest": manifest,
        "outputs": [{
            "inspection_ref": {"stage_id": "inspect_loop", "output_id": "output",
                               "content_digest": digest},
            "content_digest": digest, "kind": "antenna_closed_loop_inspection",
            "manifest_ref": "antenna/field_solutions/output/manifest.v2.json",
            "payload_units": {"V_electric": "V", "J_charge": "A/m^2", "H_ant": "A/m",
                              "H_ant_per_a": "1/m", "positions": "m"},
            "source": source,
        }],
    }


class ClosedLoopMetadataBoundsTests(unittest.TestCase):
    def test_accepts_legacy_and_independent_universe_carriers(self):
        for cells, targets in ((24, 14), (6487, 1154), (16384, 1154)):
            with self.subTest(sample_cells=cells):
                value = resource(sample_cells=cells, target_count=targets)
                manifest, digest = validate_resource(value, "runtime-stage")
                self.assertIs(manifest, value["closed_loop_manifest"])
                self.assertEqual(digest, manifest["content_digest"])
                self.assertEqual(len(manifest["payloads"]), 22)

    def test_accepts_surface_evidence_descriptor(self):
        value = resource(sample_cells=6428, target_count=1145, source_cells=1856)
        manifest = value["closed_loop_manifest"]
        manifest["direct_evidence_schema"] = "fem_rt0_surface_evidence.v1"
        manifest["payloads"]["direct_evidence"].update(
            layout="fem_rt0_surface_evidence.v1", byte_length=176 + 10000)
        self.assertIs(validate_resource(value, "runtime-stage")[0], manifest)

    def test_rejects_invalid_sample_cell_counts(self):
        for count in (0, -1, True, 16385):
            with self.subTest(count=count):
                with self.assertRaisesRegex(SmokeError, "invalid bounded sample_cell_count"):
                    validate_resource(resource(sample_cells=count), "runtime-stage")

    def test_preserves_source_and_target_count_bounds(self):
        for key, count in (("cell_count", 4097), ("vertex_count", 16385),
                           ("target_count", 16385)):
            with self.subTest(key=key):
                value = resource()
                value["closed_loop_manifest"][key] = count
                with self.assertRaisesRegex(SmokeError, "invalid bounded " + key):
                    validate_resource(value, "runtime-stage")

    def test_rejects_sample_cells_descriptor_size_mismatch(self):
        for delta in (-16, 16):
            with self.subTest(delta=delta):
                value = resource()
                value["closed_loop_manifest"]["payloads"]["sample_cells"]["byte_length"] += delta
                with self.assertRaisesRegex(SmokeError, "sample_cells size differs"):
                    validate_resource(value, "runtime-stage")

    def test_preserves_individual_payload_byte_bound(self):
        value = resource()
        value["closed_loop_manifest"]["payloads"]["source_preimage"]["byte_length"] = (16 << 20) + 1
        with self.assertRaisesRegex(SmokeError, "invalid bounded source_preimage byte_length"):
            validate_resource(value, "runtime-stage")

    def test_preserves_aggregate_payload_byte_bound(self):
        value = resource()
        for key in ("prepared_preimage", "charge_preimage", "source_preimage", "certificate"):
            value["closed_loop_manifest"]["payloads"][key]["byte_length"] = 16 << 20
        with self.assertRaisesRegex(SmokeError, "aggregate payload bound exceeded"):
            validate_resource(value, "runtime-stage")


def evidence_fixture(targets=3, surface=True):
    """Synthetic transport bindings, not a native numerical snapshot fixture."""
    m = resource(target_count=targets)["closed_loop_manifest"]
    positions = [[float(i), -0.0, 0.25] for i in range(targets)]
    fields = [[-0.0, float(-i-1), 0.5] for i in range(targets)]
    payloads = {"sample_xyz": b"".join(struct.pack("<3d", *v) for v in positions),
                "h_raw": b"".join(struct.pack("<3d", *v) for v in fields)}
    if not surface:
        data = bytearray(296 + targets * 96)
        data[:16] = b"FM-OEF1-Q3-V2\0\0\0"
        data[16:80] = m["source"]["view_identity_digest"].encode()
        data[80:144] = m["source"]["current_balance_certificate_digest"].encode()
        struct.pack_into("<Q", data, 144, targets)
        struct.pack_into("<3d", data, 272, 0.1, 10.0, 0.1)
        for i, (p, h) in enumerate(zip(positions, fields)):
            struct.pack_into("<9d3Q", data, 296 + 96*i, *p, *h, 0., 1., 0., 1, 1, 1)
        payloads["direct_evidence"] = bytes(data)
        return m, payloads, None
    m["direct_evidence_schema"] = "fem_rt0_surface_evidence.v1"
    policy = {"policy_version": "fixture", "limits": {}, "tolerances": {}}
    for key in ("requested_intent", "resolved_execution"):
        m[key]["surface_field_policy"] = copy.deepcopy(policy)
    def precision(h):
        return {"evaluated": True, "refusal_reason": "", "h_xyz_apm": [str(v) for v in h],
                "whole_h_xyz_apm": [str(v) for v in h], "sum_local_norm_apm": "1",
                "cancellation": "1", "maximum_face_cancellation": "1"}
    snapshot = {"schema_version": "fem_rt0_surface_snapshot.v1",
                "operator_version": "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1",
                "basis_version": "fem_generic_affine_rt0.v1", "inspection_only": True,
                "error_certificate_available": False, **policy,
                "source_view_identity_digest": m["source"]["view_identity_digest"],
                "accepted_source_state_digest": m["source"]["accepted_source_state_digest"],
                "targets_xyz_m": positions, "targets": [
                    {"h_xyz_apm": h, "precisions": [precision(h) for _ in range(3)],
                     "binary64_requires_highprecision": False, "precision_budget_apm": "1e-9",
                     "local_precision_delta_apm": "0", "local_formula_delta_apm": "0",
                     "local_formula_delta_80_apm": "0", "binary64_roundoff_indicator_apm": "0"}
                    for h in fields]}
    return m, payloads, snapshot


def encode_surface(m, payloads, snapshot):
    raw = json.dumps(snapshot, separators=(",", ":")).encode()
    ordered = sha256(b"antenna_rt0_surface_ordered_targets.v1" + struct.pack("<Q", m["target_count"]) + payloads["sample_xyz"]).hexdigest()
    payloads["direct_evidence"] = (b"FM-RT0-SURF-V1\0\0" + struct.pack("<Q3d", len(raw),
        m["source"]["source_current_a"], m["source"]["source_absolute_flux_a"], m["scale_per_a"])
        + m["source"]["current_balance_certificate_digest"].encode() + ordered.encode() + raw)
    m["payloads"]["direct_evidence"].update(layout=m["direct_evidence_schema"], byte_length=len(payloads["direct_evidence"]))


class EvidenceTransportTests(unittest.TestCase):
    def test_surface_and_legacy_preserve_signed_zero_and_independent_target_counts(self):
        for surface in (False, True):
            for count in (1, 14, 1145):
                with self.subTest(surface=surface, targets=count):
                    m, payloads, snapshot = evidence_fixture(count, surface)
                    if surface: encode_surface(m, payloads, snapshot)
                    verify_field_evidence(m, payloads)

    def test_surface_accepts_actual_thin_named_counter_projection(self):
        m, payloads, snapshot = evidence_fixture()
        names = ("source_target_pairs", "face_precision_passes", "whole_face_formulas",
                 "signed_fan_panels", "exact_fraction_operations", "exact_integer_operations",
                 "exact_comparisons", "real_divisions", "copied_input_bytes",
                 "reserved_output_bytes", "sqrt_calls", "log_calls", "log1p_calls", "atan2_calls")
        snapshot["limits"] = {"total": list(range(1, 15)), "per_target": list(range(15, 29))}
        m["surface_counter_encoding"] = "named_work_kind.v1"
        for key in ("requested_intent", "resolved_execution"):
            policy = {name: copy.deepcopy(snapshot[name]) for name in ("policy_version", "limits", "tolerances")}
            for name in ("total", "per_target"):
                policy["limits"][name] = dict(zip(names, snapshot["limits"][name]))
            m[key]["surface_field_policy"] = policy
        encode_surface(m, payloads, snapshot)
        verify_field_evidence(m, payloads)
        m["resolved_execution"]["surface_field_policy"]["limits"]["total"]["real_divisions"] += 1
        with self.assertRaisesRegex(SmokeError, "policy differs"):
            verify_field_evidence(m, payloads)

    def test_surface_accepts_legacy_operator_and_legal_binary64_refusal(self):
        m, payloads, snapshot = evidence_fixture()
        snapshot["operator_version"] = "fem_oersted_rt0_surface.inspection.v1"
        target = snapshot["targets"][0]
        target["binary64_requires_highprecision"] = True
        target["binary64_roundoff_indicator_apm"] = ""
        precision = target["precisions"][0]
        precision.update(evaluated=False, refusal_reason="fixture refusal", h_xyz_apm=[""]*3,
                         whole_h_xyz_apm=[""]*3, sum_local_norm_apm="", cancellation="", maximum_face_cancellation="")
        encode_surface(m, payloads, snapshot)
        verify_field_evidence(m, payloads)

    def test_surface_rejects_crossed_sources_policy_carriers_and_diagnostics(self):
        mutations = [
            lambda s: s.update(source_view_identity_digest="e"*64),
            lambda s: s.update(accepted_source_state_digest="e"*64),
            lambda s: s.update(schema_version="unknown"),
            lambda s: s.update(operator_version="unknown"),
            lambda s: s.update(inspection_only=False),
            lambda s: s.update(error_certificate_available=True),
            lambda s: s.update(policy_version="foreign"),
            lambda s: s["targets"].pop(),
            lambda s: s["targets_xyz_m"].pop(),
            lambda s: s["targets_xyz_m"][0].__setitem__(0, 3.),
            lambda s: s["targets"][0]["h_xyz_apm"].__setitem__(0, 0.),
            lambda s: s["targets"][0]["h_xyz_apm"].__setitem__(0, float("inf")),
            lambda s: s["targets"][0]["precisions"][2]["h_xyz_apm"].__setitem__(0, "0"),
            lambda s: s["targets"][0]["precisions"][1].update(evaluated=False),
            lambda s: s["targets"][0]["precisions"][1].update(refusal_reason="foreign"),
            lambda s: s["targets"][0].update(local_precision_delta_apm="NaN"),
            lambda s: s["targets"][0].update(local_formula_delta_apm="-1"),
            lambda s: s["targets"][0].update(precision_budget_apm="1e2147483648"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                m, payloads, snapshot = evidence_fixture()
                mutate(snapshot); encode_surface(m, payloads, snapshot)
                with self.assertRaises(SmokeError): verify_field_evidence(m, payloads)

    def test_rejects_truncation_trailing_bytes_headers_and_legacy_counts(self):
        for surface in (False, True):
            m, payloads, snapshot = evidence_fixture(surface=surface)
            if surface: encode_surface(m, payloads, snapshot)
            raw = payloads["direct_evidence"]
            offsets = (0, 16, 24, 48, 112) if surface else (0, 16, 80, 144, 168, 272)
            variants = [raw[:-1], raw+b"x"]
            for offset in offsets:
                changed = bytearray(raw); changed[offset] ^= 1; variants.append(bytes(changed))
            for index, changed in enumerate(variants):
                with self.subTest(surface=surface, mutation=index):
                    p = {**payloads, "direct_evidence": changed}
                    with self.assertRaises(SmokeError): verify_field_evidence(m, p)

    def test_surface_rejects_duplicate_json_and_nonfinite_numeric_overflow(self):
        for suffix in (b',"inspection_only":true}', b',"unexpected":1e999}'):
            m, payloads, snapshot = evidence_fixture(); encode_surface(m, payloads, snapshot)
            raw = payloads["direct_evidence"]
            body = raw[176:-1] + suffix
            payloads["direct_evidence"] = raw[:16] + struct.pack("<Q", len(body)) + raw[24:176] + body
            m["payloads"]["direct_evidence"]["byte_length"] = len(payloads["direct_evidence"])
            with self.assertRaises(SmokeError): verify_field_evidence(m, payloads)

    def test_rejects_unknown_or_crossed_metadata_schema_and_short_surface_header(self):
        for schema, layout, length in (("unknown", "unknown", 1000),
                ("fem_rt0_surface_evidence.v1", "fem_direct_oersted_evidence.v2", 1000),
                ("fem_rt0_surface_evidence.v1", "fem_rt0_surface_evidence.v1", 176)):
            value = resource(); manifest = value["closed_loop_manifest"]
            manifest["direct_evidence_schema"] = schema
            manifest["payloads"]["direct_evidence"].update(layout=layout, byte_length=length)
            with self.assertRaises(SmokeError): validate_resource(value, "runtime-stage")


if __name__ == "__main__":
    unittest.main()
