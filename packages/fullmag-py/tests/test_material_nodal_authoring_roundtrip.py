from __future__ import annotations

import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.script_builder import render_loaded_problem_as_script


FINGERPRINT = "sha256:" + "a" * 64
NODE_FIELDS = {
    "Ms_field": [700_000.0, 800_000.0],
    "A_field": [0.0, 13e-12],
    "alpha_field": [0.0, 0.02],
    "Ku_field": [-1_200.0, 2_400.0],
    "Ku2_field": [-80.0, 120.0],
    "Kc1_field": [-3.0, 4.0],
    "Kc2_field": [5.0, -6.0],
    "Kc3_field": [-7.0, 8.0],
    "Dind_field": [-1e-3, 2e-3],
    "Dbulk_field": [3e-3, -4e-3],
}


def _binding_source(node_count: int = 2) -> str:
    return (
        "fm.MaterialNodalFieldBinding("
        f"canonical_mesh_fingerprint={FINGERPRINT!r}, node_count={node_count})"
    )


def _load_text(script: str, directory: Path, name: str = "problem.py"):
    path = directory / name
    path.write_text(textwrap.dedent(script), encoding="utf-8")
    return fm.load_problem_from_script(path, lightweight_assets=True)


def _study_geometry_source(*, name: str = "material-nodal") -> str:
    return f"""
        import fullmag as fm

        study = fm.study({name!r})
        film = study.geometry(fm.Box(40e-9, 40e-9, 10e-9), name="film")
        film.Ms = 800e3
        film.Aex = 13e-12
        film.alpha = 0.01
    """


def _compose_script(base: str, body: str) -> str:
    base_source = textwrap.dedent(base).strip()
    body_source = textwrap.dedent(body).strip()
    return f"{base_source}\n\n{body_source}" if body_source else base_source


def _material_field_assignments() -> str:
    return "\n".join(
        f"film.{name} = {values!r}" for name, values in NODE_FIELDS.items()
    )


def _problem_material_source() -> str:
    fields = ",\n                ".join(
        f"{name}={values!r}" for name, values in NODE_FIELDS.items()
    )
    return f"""
        import fullmag as fm

        material = fm.Material(
            name="Py",
            Ms=800e3,
            A=13e-12,
            alpha=0.01,
            {fields},
            nodal_field_binding={_binding_source()},
        )
        film = fm.Ferromagnet(
            name="film",
            geometry=fm.Box(size=(40e-9, 40e-9, 10e-9)),
            material=material,
            m0=fm.texture.uniform((1.0, 0.0, 0.0)),
        )
        problem = fm.Problem(
            name="material-nodal-problem",
            magnets=[film],
            energy=[fm.Exchange()],
        )
    """


class MaterialNodalAuthoringRoundTripTests(unittest.TestCase):
    def test_material_problem_roundtrips_all_ten_fields(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(_problem_material_source(), Path(tmp_dir), "source.py")
            before = loaded.problem.magnets[0].material.to_ir()

            source = render_loaded_problem_as_script(loaded)
            self.assertIn("film.Ms_field = [700000.0, 800000.0]", source)
            self.assertIn(
                f"film.nodal_field_binding = {_binding_source()}",
                source,
            )
            reloaded = _load_text(source, Path(tmp_dir), "canonical.py")
            after = reloaded.problem.magnets[0].material.to_ir()

        for name, values in NODE_FIELDS.items():
            self.assertEqual(after[name.lower()], before[name.lower()])
            self.assertEqual(after[name.lower()], values)
        self.assertEqual(
            after["nodal_field_binding"],
            {"canonical_mesh_fingerprint": FINGERPRINT, "node_count": 2},
        )

    def test_magnet_handle_forwards_nodal_values_during_materialization(self) -> None:
        source = _compose_script(
            _study_geometry_source(),
            "\n".join(
                (
                    _material_field_assignments(),
                    f"film.nodal_field_binding = {_binding_source()}",
                )
            ),
        )
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(source, Path(tmp_dir))
        material = loaded.problem.magnets[0].material.to_ir()
        for name, values in NODE_FIELDS.items():
            self.assertEqual(material[name.lower()], values)
        self.assertEqual(material["nodal_field_binding"]["node_count"], 2)

    def test_override_accepts_public_and_ir_field_names(self) -> None:
        base_script = _study_geometry_source(name="override-base")
        binding = {
            "canonical_mesh_fingerprint": FINGERPRINT,
            "node_count": 2,
        }
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(base_script, root, "source.py")
            for source_name in ("Ms_field", "ms_field"):
                with self.subTest(source_name=source_name):
                    override = {
                        "geometries": [
                            {
                                "name": "film",
                                "role": "magnet",
                                "geometry_kind": "Box",
                                "geometry_params": {
                                    "size": [40e-9, 40e-9, 10e-9]
                                },
                                "material": {
                                    "Ms": 800e3,
                                    "Aex": 13e-12,
                                    "alpha": 0.01,
                                    source_name: [700_000.0, 800_000.0],
                                    "nodal_field_binding": binding,
                                },
                            }
                        ]
                    }
                    source = render_loaded_problem_as_script(
                        loaded,
                        overrides=override,
                    )
                    reloaded = _load_text(source, root, f"{source_name}.py")
                    wire = reloaded.problem.magnets[0].material.to_ir()
                    self.assertEqual(wire["ms_field"], [700_000.0, 800_000.0])
                    self.assertEqual(wire["nodal_field_binding"], binding)

    def test_mutated_handle_array_and_unbound_field_fail_on_materialization(self) -> None:
        invalid_scripts = (
            _compose_script(
                _study_geometry_source(name="mutated-field"),
                f"""
                    film.Ms_field = [700_000.0, 800_000.0]
                    film.nodal_field_binding = {_binding_source()}
                    film.Ms_field.append(float("nan"))
                """,
            ),
            _compose_script(
                _study_geometry_source(name="unbound-field"),
                """
                    film.Ms_field = [700_000.0, 800_000.0]
                """,
            ),
        )
        for script in invalid_scripts:
            with self.subTest(script=script):
                with TemporaryDirectory() as tmp_dir:
                    with self.assertRaises(ValueError):
                        _load_text(script, Path(tmp_dir))

    def test_invalid_binding_is_rejected(self) -> None:
        malformed_fingerprint = "SHA256:" + "a" * 64
        invalid_sources = (
            _compose_script(
                _study_geometry_source(name="wrong-node-count"),
                f"""
                    film.Ms_field = [700_000.0, 800_000.0]
                    film.nodal_field_binding = {_binding_source(node_count=1)}
                """,
            ),
            _compose_script(
                _study_geometry_source(name="malformed-fingerprint"),
                f"""
                    film.Ms_field = [700_000.0, 800_000.0]
                    film.nodal_field_binding = fm.MaterialNodalFieldBinding(
                        canonical_mesh_fingerprint={malformed_fingerprint!r},
                        node_count=2,
                    )
                """,
            ),
        )
        for script in invalid_sources:
            with self.subTest(script=script):
                with TemporaryDirectory() as tmp_dir:
                    with self.assertRaises(ValueError):
                        _load_text(script, Path(tmp_dir))

    def test_explicit_dmi_term_preserves_missing_scalar_with_nodal_field(self) -> None:
        source = _compose_script(
            _study_geometry_source(name="explicit-dmi"),
            f"""
                film.Dind_field = [-1e-3, 2e-3]
                film.nodal_field_binding = {_binding_source()}
                study.terms.add(fm.InterfacialDMI(D=0.0))
            """,
        )
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(source, root, "source.py")
            before_material = loaded.problem.magnets[0].material.to_ir()
            self.assertIsNone(before_material["interfacial_dmi"])

            canonical = render_loaded_problem_as_script(loaded)
            self.assertIn(
                "study.terms.add(fm.InterfacialDMI(D=0.0))",
                canonical,
            )
            self.assertNotIn("film.Dind =", canonical)
            reloaded = _load_text(canonical, root, "canonical.py")

        after_material = reloaded.problem.magnets[0].material.to_ir()
        self.assertIsNone(after_material["interfacial_dmi"])
        self.assertEqual(after_material["dind_field"], [-1e-3, 2e-3])
        self.assertEqual(after_material["nodal_field_binding"], before_material["nodal_field_binding"])
        self.assertEqual(
            [term.to_ir() for term in loaded.problem.energy if isinstance(term, fm.InterfacialDMI)],
            [term.to_ir() for term in reloaded.problem.energy if isinstance(term, fm.InterfacialDMI)],
        )

    def test_legacy_scalar_mirror_keeps_heterogeneous_field_separate(self) -> None:
        source = _compose_script(
            _study_geometry_source(name="scalar-mirror"),
            f"""
                film.Dind = 0.0
                film.Dind_field = [-1e-3, 2e-3]
                film.nodal_field_binding = {_binding_source()}
            """,
        )
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(source, root, "source.py")
            before = loaded.problem.magnets[0].material.to_ir()
            before_dmi_terms = [
                term.to_ir()
                for term in loaded.problem.energy
                if isinstance(term, fm.InterfacialDMI)
            ]
            canonical = render_loaded_problem_as_script(loaded)
            self.assertIn("film.Dind = 0", canonical)
            self.assertIn("film.Dind_field = [-0.001, 0.002]", canonical)
            self.assertNotIn("study.terms.add(fm.InterfacialDMI", canonical)
            reloaded = _load_text(canonical, root, "canonical.py")

        after = reloaded.problem.magnets[0].material.to_ir()
        self.assertEqual(after["interfacial_dmi"], 0.0)
        self.assertEqual(after["dind_field"], [-1e-3, 2e-3])
        self.assertEqual(after["nodal_field_binding"], before["nodal_field_binding"])
        self.assertEqual(
            [
                term.to_ir()
                for term in reloaded.problem.energy
                if isinstance(term, fm.InterfacialDMI)
            ],
            before_dmi_terms,
        )

    def test_field_only_does_not_synthesize_dmi_term(self) -> None:
        source = _compose_script(
            _study_geometry_source(name="field-only"),
            f"""
                film.Dind_field = [-1e-3, 2e-3]
                film.nodal_field_binding = {_binding_source()}
            """,
        )
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            loaded = _load_text(source, root, "source.py")
            canonical = render_loaded_problem_as_script(loaded)
            self.assertNotIn("study.terms.add(fm.InterfacialDMI", canonical)
            reloaded = _load_text(canonical, root, "canonical.py")
        self.assertFalse(
            any(isinstance(term, fm.InterfacialDMI) for term in reloaded.problem.energy)
        )

    def test_study_registry_accepts_conventional_channels_and_rejects_conflicts(self) -> None:
        source = f"""
            import fullmag as fm

            study = fm.study("term-registry")
            film = study.geometry(fm.Box(40e-9, 40e-9, 10e-9), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.01
            study.terms.add(fm.InterfacialDMI(D=1e-3))
            study.terms.add(fm.BulkDMI(D=-2e-3))

            try:
                study.terms.add(fm.InterfacialDMI(D=2e-3))
            except ValueError:
                pass
            else:
                raise AssertionError("duplicate interfacial DMI term was accepted")

            try:
                study.terms.add(object())
            except TypeError:
                pass
            else:
                raise AssertionError("unsupported study energy term was accepted")

            try:
                study.terms.add(fm.RotatedInterfacialDMI(D=3e-3))
            except ValueError:
                pass
            else:
                raise AssertionError("rotated/conventional DMI conflict was accepted")
        """
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(source, Path(tmp_dir))
        self.assertEqual(
            [type(term) for term in loaded.problem.energy if isinstance(term, (fm.InterfacialDMI, fm.BulkDMI))],
            [fm.InterfacialDMI, fm.BulkDMI],
        )

    def test_nodal_dmi_still_conflicts_with_rotated_dmi(self) -> None:
        source = _compose_script(
            _study_geometry_source(name="rotated-field-conflict"),
            f"""
                film.Dind_field = [-1e-3, 2e-3]
                film.nodal_field_binding = {_binding_source()}
                study.terms.add(fm.RotatedInterfacialDMI(D=3e-3))
            """,
        )
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(source, Path(tmp_dir))
            with self.assertRaisesRegex(ValueError, "mixed conventional and rotated DMI"):
                render_loaded_problem_as_script(loaded)

    def test_scalar_dmi_mismatch_with_explicit_term_still_fails(self) -> None:
        source = _compose_script(
            _study_geometry_source(name="scalar-mismatch"),
            f"""
                film.Dind = 1e-3
                film.Dind_field = [-1e-3, 2e-3]
                film.nodal_field_binding = {_binding_source()}
                study.terms.add(fm.InterfacialDMI(D=2e-3))
            """,
        )
        with TemporaryDirectory() as tmp_dir:
            loaded = _load_text(source, Path(tmp_dir))
            with self.assertRaisesRegex(ValueError, "combining explicit and material interfacial DMI"):
                render_loaded_problem_as_script(loaded)


if __name__ == "__main__":
    unittest.main()
