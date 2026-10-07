"""Interpreted regressions for the five R4 equilibrium identity preimages."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from fem_equilibrium_identity_replay import (  # noqa: E402
    BOUNDARY_NAMESPACE,
    EquilibriumIdentityReplayError,
    MATERIAL_V1_NAMESPACE,
    MATERIAL_V2_NAMESPACE,
    STATIC_PHYSICS_NAMESPACE,
    framed_digest,
    raw_material_digest,
    replay_equilibrium_identity_preimages,
    replay_preimage_json,
)


MATERIAL_V1 = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null}'
)
MATERIAL_V2_ZERO_KU = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v2",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null,'
    '"uniaxial_anisotropy_j_per_m3":0.0,'
    '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]}'
)
STATIC_PHYSICS = (
    '{"schema_version":"EquilibriumStaticPhysicsSignaturePreimage.v1",'
    '"enable_exchange":true,"enable_demag":true,'
    '"external_field_a_per_m":[0.0,0.0,0.0]}'
)
BOUNDARY = (
    '{"schema_version":"EquilibriumBoundarySignaturePreimage.v1",'
    '"exchange_bc":"neumann","demag_realization":"poisson_robin",'
    '"air_box_config":null,"periodic_node_pairs":[],'
    '"periodic_boundary_pairs":[]}'
)
BOUNDARY_WITH_AIRBOX_AND_PBC = (
    '{"schema_version":"EquilibriumBoundarySignaturePreimage.v1",'
    '"exchange_bc":"neumann","demag_realization":"poisson_robin",'
    '"air_box_config":{"factor":4.0,"grading":1.4,"boundary_marker":99,'
    '"bc_kind":"robin","robin_beta_mode":"dipole",'
    '"robin_beta_factor":2.0,"shape":"bbox",'
    '"factor_source":"user","boundary_marker_source":"user_policy"},'
    '"periodic_node_pairs":[{"pair_id":"x+_x-","node_a":0,"node_b":1}],'
    '"periodic_boundary_pairs":[{"pair_id":"x+_x-",'
    '"source_marker":"xmin","destination_marker":"xmax",'
    '"marker_a":1,"marker_b":2,"translation":[1.0,0.0,0.0],'
    '"tolerance":1e-9,"axis_hint":"x","orientation":"opposite",'
    '"pairing_policy":"translation"}]}'
)
RAW_MATERIAL = (
    '{"name":"fixture","saturation_magnetisation":800000.0,'
    '"exchange_stiffness":1.3e-11,"damping":0.5,'
    '"uniaxial_anisotropy":null,"anisotropy_axis":null}'
)


def _digest(namespace: str, text: str) -> str:
    return framed_digest(namespace, text.encode("utf-8"))


MATERIAL_V1_DIGEST = "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af"
MATERIAL_V2_DIGEST = "sha256:5aff2c9f1fa917b8f55646cdb181e93feb1d2d8052d265d7256da089944e0f1b"
STATIC_DIGEST = "sha256:9f6f99073b14cc461ca1a7c9199282867bc2ce34789b38cd2f61a52124b63b48"
BOUNDARY_DIGEST = "sha256:9b1e80acd4476df1caf3c63f83ea40e504993f67dbc6dbbbb74b29eaddf6aa3e"
BOUNDARY_WITH_AIRBOX_AND_PBC_DIGEST = "sha256:ef0d169afbdc1811401472335603affaa0d2c204930d9953ed2ec2643a5f5152"
RAW_DIGEST = "sha256:dafbb79c4680dc3ad87b8adc6ddad189cbd6f2d04925fc4fcc404e24ace145fe"


def _identity_fixture() -> tuple[dict[str, object], bytes]:
    identity: dict[str, object] = {
        "schema_version": "linearization_identity.v2",
        "equilibrium_material_preimage_json": MATERIAL_V1,
        "equilibrium_material_signature": MATERIAL_V1_DIGEST,
        "equilibrium_static_physics_preimage_json": STATIC_PHYSICS,
        "equilibrium_static_physics_signature": STATIC_DIGEST,
        "equilibrium_boundary_preimage_json": BOUNDARY,
        "equilibrium_boundary_signature": BOUNDARY_DIGEST,
        "producer_material_provenance_preimage_json": RAW_MATERIAL,
        "producer_material_provenance_signature": RAW_DIGEST,
        "material_provenance_preimage_json": RAW_MATERIAL,
        "material_provenance_signature": RAW_DIGEST,
    }
    return identity, json.dumps(identity, separators=(",", ":")).encode("utf-8")


class EquilibriumIdentityReplayTests(unittest.TestCase):
    def test_frozen_v1_v2_zero_ku_and_other_framed_payloads(self) -> None:
        self.assertEqual(
            replay_preimage_json(MATERIAL_V1, MATERIAL_V1_DIGEST, "equilibrium_material"),
            MATERIAL_V1_DIGEST,
        )
        v2_digest = _digest(MATERIAL_V2_NAMESPACE, MATERIAL_V2_ZERO_KU)
        self.assertEqual(v2_digest, MATERIAL_V2_DIGEST)
        self.assertEqual(
            replay_preimage_json(MATERIAL_V2_ZERO_KU, v2_digest, "equilibrium_material"),
            v2_digest,
        )
        self.assertEqual(
            replay_preimage_json(STATIC_PHYSICS, STATIC_DIGEST, "static_physics"),
            STATIC_DIGEST,
        )
        self.assertEqual(
            replay_preimage_json(BOUNDARY, BOUNDARY_DIGEST, "boundary"),
            BOUNDARY_DIGEST,
        )

    def test_canonical_boundary_airbox_and_periodic_pairs(self) -> None:
        digest = _digest(BOUNDARY_NAMESPACE, BOUNDARY_WITH_AIRBOX_AND_PBC)
        self.assertEqual(digest, BOUNDARY_WITH_AIRBOX_AND_PBC_DIGEST)
        self.assertEqual(
            replay_preimage_json(
                BOUNDARY_WITH_AIRBOX_AND_PBC,
                BOUNDARY_WITH_AIRBOX_AND_PBC_DIGEST,
                "boundary",
            ),
            BOUNDARY_WITH_AIRBOX_AND_PBC_DIGEST,
        )
        mutations = (
            BOUNDARY_WITH_AIRBOX_AND_PBC.replace('"boundary_marker":99', '"boundary_marker":true'),
            BOUNDARY_WITH_AIRBOX_AND_PBC.replace('"node_a":0', '"node_a":0.0'),
            BOUNDARY_WITH_AIRBOX_AND_PBC.replace('"node_a":0', '"node_a":-0'),
            BOUNDARY_WITH_AIRBOX_AND_PBC.replace(
                '"translation":[1.0,0.0,0.0]',
                '"translation":[1.0,0.0]',
            ),
            BOUNDARY_WITH_AIRBOX_AND_PBC.replace(
                '"tolerance":1e-9',
                '"tolerance_m":1e-9',
            ),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(EquilibriumIdentityReplayError):
                    replay_preimage_json(
                        mutation,
                        _digest(BOUNDARY_NAMESPACE, mutation),
                        "boundary",
                    )

    def test_full_identity_replays_all_five_preimages(self) -> None:
        _, encoded = _identity_fixture()
        result = replay_equilibrium_identity_preimages(encoded)
        self.assertEqual(
            result,
            {
                "equilibrium_material_signature": MATERIAL_V1_DIGEST,
                "equilibrium_static_physics_signature": STATIC_DIGEST,
                "equilibrium_boundary_signature": BOUNDARY_DIGEST,
                "producer_material_provenance_signature": RAW_DIGEST,
                "material_provenance_signature": RAW_DIGEST,
            },
        )

    def test_damping_changes_raw_digest_but_not_physical_material_digest(self) -> None:
        changed_raw = RAW_MATERIAL.replace('"damping":0.5', '"damping":0.0')
        changed_raw_digest = raw_material_digest(changed_raw.encode("utf-8"))
        self.assertNotEqual(changed_raw_digest, RAW_DIGEST)
        self.assertEqual(
            replay_preimage_json(MATERIAL_V1, MATERIAL_V1_DIGEST, "equilibrium_material"),
            MATERIAL_V1_DIGEST,
        )
        self.assertEqual(
            replay_preimage_json(changed_raw, changed_raw_digest, "raw_material"),
            changed_raw_digest,
        )

    def test_material_schema_and_physical_mutations_are_rejected(self) -> None:
        mutations = (
            MATERIAL_V1.replace(
                '"schema_version":"EquilibriumMaterialSignaturePreimage.v1"',
                '"schema_version":"EquilibriumMaterialSignaturePreimage.v2"',
            ),
            MATERIAL_V1.replace(
                '"exchange_stiffness_field_j_per_m":null',
                '"exchange_stiffness_field_j_per_m":null,"uniaxial_anisotropy_j_per_m3":0.0',
            ),
            MATERIAL_V1.replace("800000.0", "0.0"),
            MATERIAL_V1.replace("1.3e-11", "-1.3e-11"),
            MATERIAL_V2_ZERO_KU.replace(
                '"saturation_magnetisation_field_a_per_m":null',
                '"saturation_magnetisation_field_a_per_m":[]',
            ),
            MATERIAL_V2_ZERO_KU.replace("0.0,\"canonical_uniaxial_axis\"", "-0.0,\"canonical_uniaxial_axis\""),
            MATERIAL_V2_ZERO_KU.replace(
                '"uniaxial_anisotropy_j_per_m3":0.0',
                '"uniaxial_anisotropy_j_per_m3":-0',
            ),
            MATERIAL_V2_ZERO_KU.replace(
                '"uniaxial_anisotropy_j_per_m3":0.0',
                '"uniaxial_anisotropy_j_per_m3":-0e0',
            ),
            MATERIAL_V2_ZERO_KU.replace(
                '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]',
                '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,-0]',
            ),
            MATERIAL_V2_ZERO_KU.replace(
                '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]',
                '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,-0e0]',
            ),
            MATERIAL_V2_ZERO_KU.replace("0.5547001962252291", "-0.5547001962252291"),
            MATERIAL_V1.replace("800000.0", "NaN"),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(EquilibriumIdentityReplayError):
                    replay_preimage_json(
                        mutation,
                        _digest(MATERIAL_V1_NAMESPACE, mutation),
                        "equilibrium_material",
                    )

    def test_static_boundary_and_raw_type_mutations_are_rejected(self) -> None:
        mutations = (
            (STATIC_PHYSICS.replace("true", "1", 1), "static_physics"),
            (STATIC_PHYSICS.replace("[0.0,0.0,0.0]", "[0.0,0.0]"), "static_physics"),
            (BOUNDARY.replace('"exchange_bc":"neumann"', '"exchange_bc":"bad"'), "boundary"),
            (BOUNDARY.replace('"poisson_robin"', '[]'), "boundary"),
            (RAW_MATERIAL.replace('"damping":0.5', '"damping":true'), "raw_material"),
            (RAW_MATERIAL.replace('"damping":0.5', '"damping":NaN'), "raw_material"),
            (RAW_MATERIAL.replace(',"uniaxial_anisotropy":null', ""), "raw_material"),
            (RAW_MATERIAL.replace(',"anisotropy_axis":null', ""), "raw_material"),
        )
        for mutation, kind in mutations:
            with self.subTest(kind=kind, mutation=mutation):
                digest = (
                    raw_material_digest(mutation.encode("utf-8"))
                    if kind == "raw_material"
                    else _digest(
                        STATIC_PHYSICS_NAMESPACE if kind == "static_physics" else BOUNDARY_NAMESPACE,
                        mutation,
                    )
                )
                with self.assertRaises(EquilibriumIdentityReplayError):
                    replay_preimage_json(mutation, digest, kind)

    def test_raw_replay_checks_shape_and_finiteness_only(self) -> None:
        changed = RAW_MATERIAL.replace(
            '"saturation_magnetisation":800000.0',
            '"saturation_magnetisation":-1.0',
        ).replace('"exchange_stiffness":1.3e-11', '"exchange_stiffness":-2.0')
        digest = raw_material_digest(changed.encode("utf-8"))
        self.assertEqual(replay_preimage_json(changed, digest, "raw_material"), digest)

    def test_exact_bytes_are_hashed_without_reserialization(self) -> None:
        changed = MATERIAL_V1 + " \n"
        changed_digest = _digest(MATERIAL_V1_NAMESPACE, changed)
        self.assertNotEqual(changed_digest, MATERIAL_V1_DIGEST)
        self.assertEqual(
            replay_preimage_json(changed, changed_digest, "equilibrium_material"),
            changed_digest,
        )
        with self.assertRaises(EquilibriumIdentityReplayError):
            replay_preimage_json(changed, MATERIAL_V1_DIGEST, "equilibrium_material")

    def test_unknown_duplicate_and_missing_fields_are_rejected(self) -> None:
        unknown = MATERIAL_V1[:-1] + ',"unexpected":1}'
        duplicate = MATERIAL_V1.replace(
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",',
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",',
        )
        missing = MATERIAL_V1.replace(
            ',"exchange_stiffness_field_j_per_m":null',
            "",
        )
        for mutation in (unknown, duplicate, missing):
            with self.subTest(mutation=mutation):
                with self.assertRaises(EquilibriumIdentityReplayError):
                    replay_preimage_json(
                        mutation,
                        _digest(MATERIAL_V1_NAMESPACE, mutation),
                        "equilibrium_material",
                    )

    def test_identity_requires_all_five_pairs_and_rejects_duplicate_outer_keys(self) -> None:
        identity, encoded = _identity_fixture()
        identity.pop("material_provenance_signature")
        with self.assertRaises(EquilibriumIdentityReplayError):
            replay_equilibrium_identity_preimages(
                json.dumps(identity, separators=(",", ":")).encode("utf-8")
            )
        duplicate = b'{"schema_version":"linearization_identity.v2",' + encoded[1:]
        with self.assertRaises(EquilibriumIdentityReplayError):
            replay_equilibrium_identity_preimages(duplicate)


if __name__ == "__main__":
    unittest.main()
