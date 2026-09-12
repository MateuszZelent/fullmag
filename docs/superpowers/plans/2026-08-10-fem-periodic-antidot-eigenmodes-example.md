# FEM Periodic Antidot Eigenmodes Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać osobny przykład Python DSL, który buduje periodyczny antidot z airboxem, relaksuje go na CPU, a następnie oblicza ograniczone widmo K0 `full_2x2` z dynamicznym demag i zapisuje zespolone mody.

**Architecture:** Nowy przykład jest samodzielnym płaskim skryptem authoringowym i nie modyfikuje istniejącego przykładu wymuszonego FMR. Dedykowany test ładuje skrypt przez publiczne `fm.load_problem_from_script`, sprawdza rzeczywisty ProblemIR, fizykę, kolejność etapów, strict device semantics, okno częstotliwości i outputs; osobne przypadki uruchamiają walidację zmiennych środowiskowych przed utworzeniem study.

**Tech Stack:** Python 3, `packages/fullmag-py`, `unittest`, publiczny Fullmag Python DSL, ProblemIR JSON, `pytest`.

## Global Constraints

- Nowy plik to dokładnie `examples/fem_periodic_antidot_relax_eigenmodes.py`.
- Istniejący `examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py` pozostaje bez zmian.
- Film ma 200 nm x 200 nm x 10 nm, otwór promień 25 nm, shared domain 200 nm x 200 nm x 400 nm.
- PBC jest dokładnie x/y, oś z pozostaje otwarta, demag PBC to `periodic_airbox_k0`.
- Zachować `hole_transition_refinement` jako conformal region tego samego physical object.
- Modalny operator to `full_2x2`, `include_demag=True`, `k=(0,0,0)`, `equilibrium_source="relax"`.
- Nie ma cichego strict GPU -> CPU fallbacku.
- Native FEM/MFEM proof używa wyłącznie container-backed `just`; nie wykonywać host-first builda.
- Worktree jest współdzielony i zabrudzony: bez stage, commit, reset i clean; zamiast commita dostarczyć scoped diff i raport.

---

## Struktura plików

- Create: `examples/fem_periodic_antidot_relax_eigenmodes.py` — jedyny publiczny przykład oraz walidacja jego parametrów środowiskowych.
- Create: `packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py` — eksport ProblemIR, kontrola wspólnej fizyki FMR/eigen, kolejności etapów, outputs i błędów konfiguracji.
- Create: `.superpowers/sdd/task-n1e-periodic-antidot-eigen-script-report.md` — wykonane RED/GREEN, dokładne komendy, wynik review i granica kwalifikacji.

### Task 1: Osobny przykład periodic-antidot eigensolve i kontrakt ProblemIR

**Files:**
- Create: `examples/fem_periodic_antidot_relax_eigenmodes.py`
- Create: `packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py`
- Create: `.superpowers/sdd/task-n1e-periodic-antidot-eigen-script-report.md`

**Interfaces:**
- Consumes: `fullmag.study`, `StudyStagesBuilder.add_minimize`, `StudyStagesBuilder.change_device`, `StudyStagesBuilder.add_eigenmodes`, `PeriodicBC`, `fm.load_problem_from_script(path, lightweight_assets=True)`.
- Produces: publiczny skrypt `examples/fem_periodic_antidot_relax_eigenmodes.py`; ProblemIR z etapami `flat_relax`, opcjonalnym `flat_change_device`, `flat_eigenmodes`; metadata `periodic_antidot_eigensolve`.

- [ ] **Step 1: Dodać failing test eksportu CPU ProblemIR**

Utworzyć `packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py`:

```python
from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest import mock

import fullmag as fm


REPO_ROOT = Path(__file__).resolve().parents[3]
EIGEN_EXAMPLE = REPO_ROOT / "examples/fem_periodic_antidot_relax_eigenmodes.py"
RESPONSE_EXAMPLE = (
    REPO_ROOT
    / "examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py"
)


class PeriodicAntidotEigenmodesExampleTests(unittest.TestCase):
    def load_example(self, environment: dict[str, str] | None = None):
        with mock.patch.dict(os.environ, environment or {}, clear=True):
            return fm.load_problem_from_script(EIGEN_EXAMPLE, lightweight_assets=True)

    def test_exchange_coupled_eigenmodes_scenario_relaxes_then_solves_k0_window(self) -> None:
        loaded = self.load_example(
            {
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "cpu",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "8",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "0.5",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ": "30.0",
                "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT": "4",
            }
        )

        self.assertEqual(len(loaded.stages), 2)
        relax = loaded.stages[0].problem.study.to_ir()
        self.assertEqual(relax["kind"], "relaxation")
        self.assertEqual(relax["algorithm"], "projected_gradient_bb")
        self.assertEqual(relax["stop"]["max_steps"], 4000)
        self.assertGreater(relax["stop"]["torque_tolerance_apm"], 0.0)

        eigen = loaded.stages[1].problem.study.to_ir()
        self.assertEqual(eigen["kind"], "eigenmodes")
        self.assertEqual(eigen["count"], 8)
        self.assertEqual(
            eigen["target"],
            {
                "kind": "frequency_window",
                "frequency_min_hz": 0.5e9,
                "frequency_max_hz": 30.0e9,
            },
        )
        self.assertEqual(eigen["operator"], {"kind": "full_2x2", "include_demag": True})
        self.assertEqual(eigen["equilibrium"], {"kind": "relaxed_initial_state"})
        self.assertEqual(eigen["normalization"], "unit_l2")
        self.assertEqual(eigen["damping_policy"], "ignore")
        self.assertEqual(eigen["k_sampling"], {"kind": "single", "k_vector": [0.0, 0.0, 0.0]})
        self.assertEqual(
            eigen["spin_wave_bc"],
            {"kind": "periodic", "pair_ids": ["x_faces", "y_faces"]},
        )
        self.assertEqual(eigen["magnetostatic_bc"], "periodic_airbox_k0")

        self.assertEqual(
            eigen["sampling"]["outputs"],
            [
                {"kind": "eigen_spectrum", "quantity": "eigenfrequency", "scope": "per_sample"},
                {"kind": "dispersion_curve", "name": "dispersion", "include_branch_table": True},
                {"kind": "eigen_mode", "field": "mode", "indices": [0, 1, 2, 3]},
            ],
        )

        problem_ir = loaded.to_ir(
            requested_backend="fem",
            execution_mode="strict",
            execution_precision="double",
            include_geometry_assets=False,
        )
        self.assertEqual(problem_ir["problem_meta"]["name"], "fem_periodic_antidot_relax_eigenmodes")
        self.assertEqual(
            problem_ir["pbc"],
            {"axes": ["periodic", "periodic", "open"], "demag": "periodic_airbox_k0"},
        )
        metadata = problem_ir["problem_meta"]["runtime_metadata"]
        scenario = metadata["periodic_antidot_eigensolve"]
        self.assertEqual(scenario["scenario"], "relax_then_eigenmodes_k0")
        self.assertEqual(scenario["periodic_pair_ids"], ["x_faces", "y_faces"])
        self.assertEqual(scenario["open_axis"], "z")
        self.assertEqual(scenario["mode_count"], 8)
        self.assertEqual(scenario["saved_mode_indices"], [0, 1, 2, 3])
        self.assertEqual(scenario["frequency_window_hz"], [0.5e9, 30.0e9])
```

- [ ] **Step 2: Uruchomić test i potwierdzić RED**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  -k exchange_coupled_eigenmodes_scenario_relaxes_then_solves_k0_window
```

Expected: FAIL, ponieważ `examples/fem_periodic_antidot_relax_eigenmodes.py` nie istnieje.

- [ ] **Step 3: Dodać failing test strict GPU oraz wspólnej fizyki**

```python
    def test_exchange_coupled_eigenmodes_gpu_adds_explicit_device_transition(self) -> None:
        loaded = self.load_example({"FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "gpu"})
        self.assertEqual(len(loaded.stages), 3)
        self.assertEqual(loaded.stages[1].kind, "change_device")
        self.assertEqual(loaded.stages[1].device, "gpu")
        self.assertEqual(loaded.stages[2].problem.study.to_ir()["kind"], "eigenmodes")

    def test_eigenmodes_and_frequency_response_examples_share_antidot_physics(self) -> None:
        eigen_source = EIGEN_EXAMPLE.read_text(encoding="utf-8")
        response_source = RESPONSE_EXAMPLE.read_text(encoding="utf-8")
        shared_fragments = [
            "fm.Box(size=(200e-9, 200e-9, 10e-9",
            "fm.Cylinder(radius=25e-9, height=10e-9",
            "size=(200e-9, 200e-9, 400e-9)",
            'study.pbc(x=True, y=True, demag="periodic_airbox_k0")',
            '"hole_transition_refinement"',
            "radius=43e-9",
            "body.Ms = 800e3",
            "body.Aex = 13e-12",
            "study.b_ext(10e-3, 0.0, 0.0)",
            'study.demag(realization="poisson_robin")',
        ]
        for fragment in shared_fragments:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, eigen_source)
                self.assertIn(fragment, response_source)
```

- [ ] **Step 4: Potwierdzić RED dla testów GPU/fizyki**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  -k 'exchange_coupled_eigenmodes_gpu or eigenmodes_and_frequency_response'
```

Expected: FAIL na brakującym nowym pliku.

- [ ] **Step 5: Zaimplementować kompletny nowy skrypt**

Utworzyć `examples/fem_periodic_antidot_relax_eigenmodes.py`:

```python
"""Relax a periodic Permalloy antidot and compute its K0 eigenmodes.

The unit cell is periodic in x/y and open in z. Dynamic demagnetization uses
the same periodic Poisson-airbox domain as the relaxed equilibrium.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_eigenmodes.py
"""

import math
import os

import fullmag as fm


device = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE", "cpu")
if device not in {"cpu", "gpu"}:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE must be 'cpu' or 'gpu'")

mode_count_raw = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT", "8")
save_mode_count_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT", "4"
)
try:
    mode_count = int(mode_count_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT must be an integer, "
        f"got {mode_count_raw!r}"
    ) from exc
try:
    save_mode_count = int(save_mode_count_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must be an integer, "
        f"got {save_mode_count_raw!r}"
    ) from exc
if mode_count <= 0:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT must be positive, "
        f"got {mode_count}"
    )
if save_mode_count <= 0:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must be positive, "
        f"got {save_mode_count}"
    )
if save_mode_count > mode_count:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT must not exceed "
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT"
    )

frequency_min_ghz_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ", "0.5"
)
frequency_max_ghz_raw = os.environ.get(
    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ", "30.0"
)
try:
    frequency_min_ghz = float(frequency_min_ghz_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be a number, "
        f"got {frequency_min_ghz_raw!r}"
    ) from exc
try:
    frequency_max_ghz = float(frequency_max_ghz_raw)
except ValueError as exc:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be a number, "
        f"got {frequency_max_ghz_raw!r}"
    ) from exc
if not math.isfinite(frequency_min_ghz):
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be finite, "
        f"got {frequency_min_ghz_raw!r}"
    )
if not math.isfinite(frequency_max_ghz):
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be finite, "
        f"got {frequency_max_ghz_raw!r}"
    )
frequency_min_hz = frequency_min_ghz * 1.0e9
frequency_max_hz = frequency_max_ghz * 1.0e9
if frequency_min_hz < 0.0:
    raise ValueError("FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ must be non-negative")
if frequency_max_hz <= frequency_min_hz:
    raise ValueError(
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ must be greater than "
        "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ"
    )

mu0_t_m_per_a = 4.0e-7 * math.pi
equilibrium_torque_tolerance_t = 5.0e-3
equilibrium_torque_tolerance_a_per_m = (
    equilibrium_torque_tolerance_t / mu0_t_m_per_a
)

study = fm.study("fem_periodic_antidot_relax_eigenmodes")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(200e-9, 200e-9, 400e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9,
    maximum_element_size=100e-9,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.interactive(False)

film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="periodic_antidot_base")
hole = fm.Cylinder(radius=25e-9, height=10e-9, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10e-9,
    maximum_element_size=20e-9,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(radius=43e-9, height=10e-9, name="hole_transition_refinement"),
    priority=10,
    realization_policy="conformal",
)
hole_transition.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=20e-9,
    transition_distance=20e-9,
    order=1,
)

study.runtime_metadata(
    "periodic_antidot_eigensolve",
    {
        "scenario": "relax_then_eigenmodes_k0",
        "exchange_coupled_across_periods": True,
        "magnetostatic_pbc": "periodic_airbox_k0",
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "open_axis": "z",
        "film_size_m": [200e-9, 200e-9, 10e-9],
        "universe_size_m": [200e-9, 200e-9, 400e-9],
        "hole_radius_m": 25e-9,
        "bias_field_t": [10e-3, 0.0, 0.0],
        "requested_modal_device": device,
        "frequency_window_hz": [frequency_min_hz, frequency_max_hz],
        "mode_count": mode_count,
        "saved_mode_indices": list(range(save_mode_count)),
        "equilibrium_torque_tolerance_t": equilibrium_torque_tolerance_t,
        "equilibrium_torque_tolerance_a_per_m": equilibrium_torque_tolerance_a_per_m,
    },
)

study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-4, max_iterations=1000)
study.objects.mesh.defaults(
    periodic_pair_ids=["x_faces", "y_faces"],
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()
study.solver(dt=1e-13, g=2.115)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=tuple(range(save_mode_count)))

study.stages.add_minimize(
    method="bb",
    max_steps=4000,
    tolA=equilibrium_torque_tolerance_a_per_m,
)
if device == "gpu":
    study.stages.change_device("gpu")
study.stages.add_eigenmodes(
    count=mode_count,
    target="frequency_window",
    frequency_min=frequency_min_hz,
    frequency_max=frequency_max_hz,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)
```

- [ ] **Step 6: Uruchomić trzy testy i doprowadzić do GREEN**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  -k 'exchange_coupled_eigenmodes or eigenmodes_and_frequency_response'
```

Expected: 3 PASS, 0 FAIL.

- [ ] **Step 7: Dodać failing test walidacji pięciu zmiennych środowiskowych**

Do dedykowanego pliku testowego dodać:

```python
    def test_eigenmodes_example_rejects_invalid_environment(self) -> None:
        invalid_cases = [
            ({"FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE": "auto"}, "must be 'cpu' or 'gpu'"),
            ({"FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "0"}, "must be positive"),
            ({"FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "nan"}, "must be finite"),
            (
                {
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ": "30",
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ": "10",
                },
                "must be greater",
            ),
            (
                {
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT": "2",
                    "FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT": "3",
                },
                "must not exceed",
            ),
        ]
        for environment, message in invalid_cases:
            with self.subTest(environment=environment):
                with mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(ValueError, message):
                        fm.load_problem_from_script(EIGEN_EXAMPLE, lightweight_assets=True)
```

Przed implementacją walidatorów test musi failować na pierwszym przypadku, który nie jest odrzucany oczekiwanym komunikatem.

- [ ] **Step 8: Uruchomić walidację środowiska i potwierdzić GREEN**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  -k eigenmodes_example_rejects_invalid_environment
```

Expected: 1 PASS z pięcioma subtestami.

- [ ] **Step 9: Uruchomić pełny focused plik testowy**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py
```

Expected: wszystkie testy PASS; istniejące scenariusze FMR/relax/time-domain pozostają niezmienione.

- [ ] **Step 10: Zweryfikować składnię, publiczny eksport i diff**

Run:

```bash
python3 -m py_compile examples/fem_periodic_antidot_relax_eigenmodes.py
PYTHONPATH=packages/fullmag-py/src python3 -m fullmag.runtime.helper \
  export-run-config \
  --script examples/fem_periodic_antidot_relax_eigenmodes.py \
  --backend fem \
  --mode strict \
  --precision double \
  --skip-geometry-assets
git diff --check -- \
  examples/fem_periodic_antidot_relax_eigenmodes.py \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py
```

Expected: compile exit 0, export exit 0 z dwoma etapami CPU, diff-check exit 0.

- [ ] **Step 11: Zaktualizować raport zamiast commitować shared worktree**

Zapisać `.superpowers/sdd/task-n1e-periodic-antidot-eigen-script-report.md` po polsku z:

```markdown
# Raport N1e: osobny skrypt periodic-antidot eigensolve

## RED
- dokładna komenda i oczekiwany brak pliku;
- dokładna komenda negatywnych parametrów.

## GREEN
- liczba testów i exit codes;
- wynik publicznego eksportu ProblemIR;
- scoped diff-check.

## Granica kwalifikacji
Source/IR complete nie oznacza managed MFEM solve. Export lock i native proof są
osobną bramką; nie deklarować widma ani modów bez świeżych artifacts.
```

Nie wykonywać `git add` ani `git commit`, ponieważ index zawiera obce staged zmiany.

- [ ] **Step 12: Niezależny review**

Reviewer musi porównać nowy skrypt z zatwierdzoną specyfikacją i istniejącym przykładem FMR, sprawdzić brak uproszczeń fizyki, aktualny Python/ProblemIR, strict GPU semantics, poprawne SI, outputs i TDD evidence. Werdykty `SPEC` i `QUALITY` muszą być `APPROVED`; wszystkie Critical/Important wracają do tego samego implementera, po czym następuje re-review.

## Dalsza bramka N1e poza tym slice’em

Po zamknięciu locka managed runtime osobny task musi wykonać:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

oraz container-backed CPU uruchomienie nowego skryptu z walidacją niepustego widma, pełnych reszt i zespolonych pól modów. Ten plan nie może zostać użyty jako dowód produkcyjnego solve.
