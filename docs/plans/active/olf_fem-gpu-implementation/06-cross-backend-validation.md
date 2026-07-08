# S6: Cross-Backend Validation — FDM ↔ FEM

- Etap: **S6** (po S2, S3, S4)
- Priorytet: **HIGH** — bez walidacji nie wiadomo czy FEM działa poprawnie
- Docelowy katalog: `crates/fullmag-engine/tests/cross_backend/`

---

## 1. Cele etapu

1. **Porównanie FDM vs FEM** na wspólnych scenariuszach (Box geometry).
2. **Testy analityczne**: znane rozwiązania (demag czynniki, uniform state, ...).
3. **Testy zbieżności**: mesh refinement → wynik zbieżny do FDM.
4. **Testy parity CPU ↔ GPU**: CPU reference FEM vs native GPU FEM.
5. **Narzędzia diagnostyczne**: skrypty Python do generowania raportów.

---

## 2. Scenariusze testowe

### 2.1 Test A: Exchange-only relaxation na Box

**Geometria:** Box 100 × 100 × 20 nm   
**Materiał:** Ms = 800 kA/m, A = 13 pJ/m, α = 1.0 (quick relaxation)   
**m₀:** random (uniform noise per node)   
**Interakcje:** Exchange only   
**Kryterium:** Po relaxacji m powinno być jednorodne (spatially uniform).

| Metryka | FDM | FEM | Tolerancja |
|---------|-----|-----|------------|
| E_ex (final) | E₁ | E₂ | $\|E_1 - E_2\| / E_1 < 0.05$ |
| max_torque (final) | < 1e-3 | < 1e-3 | oba < 1e-3 |
| ⟨m⟩ (final) | ≈ const | ≈ const | $\|\langle m \rangle_{FDM} - \langle m \rangle_{FEM}\| < 0.01$ |

```python
# tests/cross_backend/test_a_exchange_relaxation.py

import fullmag as fm
import numpy as np

def test_exchange_relaxation_cross_backend():
    problem = fm.Problem(
        shape=fm.Box(100e-9, 100e-9, 20e-9),
        material=fm.Material(ms=800e3, a_exchange=13e-12, alpha=1.0),
        initial_magnetization=fm.RandomMagnetization(seed=42),
        energy_terms=[fm.Exchange()],
        integrator=fm.Heun(dt=1e-14),
        n_steps=5000,
    )

    # FDM
    result_fdm = problem.run(backend="fdm", output_dir="output_fdm")
    scalars_fdm = fm.load_scalars(result_fdm.output_dir / "scalars.csv")

    # FEM
    result_fem = problem.run(
        backend="fem",
        output_dir="output_fem",
        fem=fm.FEM(hmax=5e-9),
    )
    scalars_fem = fm.load_scalars(result_fem.output_dir / "scalars.csv")

    # Compare final exchange energy
    e_fdm = scalars_fdm["energy_exchange"].iloc[-1]
    e_fem = scalars_fem["energy_exchange"].iloc[-1]
    rel_diff = abs(e_fdm - e_fem) / abs(e_fdm)
    assert rel_diff < 0.05, f"Exchange energy diff {rel_diff:.4f} > 5%"

    # Both should have converged
    assert scalars_fdm["max_torque"].iloc[-1] < 1e-3
    assert scalars_fem["max_torque"].iloc[-1] < 1e-3
```

---

### 2.2 Test B: Demag thin plate — demagnetization factor

**Geometria:** Box 200 × 200 × 5 nm (thin plate, aspect ratio 40:1)   
**Materiał:** Ms = 800 kA/m, A = 13 pJ/m, α = 0.5   
**m₀:** uniform z   
**Interakcje:** Demag only (no exchange)   
**Kryterium:** $N_z \approx 1$ (czynnik demagnetyzacyjny cienkiej płyty)

Czynnik demagnetyzacyjny wyznaczamy z:

$$N_z = -\frac{\langle H_{d,z} \rangle}{M_s}$$

| Metryka | Analityczna | FDM | FEM | Tolerancja |
|---------|-------------|-----|-----|------------|
| $N_z$ | 1.0 | $N_z^{FDM}$ | $N_z^{FEM}$ | $\|N_z - 1\| < 0.15$ |
| $N_z^{FDM} \approx N_z^{FEM}$ | — | — | — | $\|N_z^{FDM} - N_z^{FEM}\| < 0.10$ |

```python
def test_demag_thin_plate():
    problem = fm.Problem(
        shape=fm.Box(200e-9, 200e-9, 5e-9),
        material=fm.Material(ms=800e3, a_exchange=0, alpha=0.5),
        initial_magnetization=fm.Uniform(0, 0, 1),
        energy_terms=[fm.Demag()],
        integrator=fm.Heun(dt=1e-14),
        n_steps=1,  # Just need H_d at t=0
    )

    # FDM
    result_fdm = problem.run(backend="fdm", output_dir="output_fdm_demag")
    hz_fdm = fm.load_field(result_fdm, "hz", step=0)
    nz_fdm = -np.mean(hz_fdm) / 800e3

    # FEM
    result_fem = problem.run(
        backend="fem", output_dir="output_fem_demag",
        fem=fm.FEM(hmax=5e-9),
    )
    hz_fem = fm.load_field(result_fem, "hz", step=0)
    nz_fem = -np.mean(hz_fem) / 800e3

    assert abs(nz_fdm - 1.0) < 0.15, f"FDM Nz = {nz_fdm}"
    assert abs(nz_fem - 1.0) < 0.15, f"FEM Nz = {nz_fem}"
    assert abs(nz_fdm - nz_fem) < 0.10, f"|Nz_FDM - Nz_FEM| = {abs(nz_fdm - nz_fem)}"
```

---

### 2.3 Test C: Full relaxation (Exchange + Demag + Zeeman)

**Geometria:** Box 100 × 100 × 20 nm   
**Materiał:** Ms = 800 kA/m, A = 13 pJ/m, α = 0.5   
**m₀:** uniform x = (1, 0, 0)   
**Pole ext:** Hz = 0.1 T (w kierunku z)   
**Interakcje:** Exchange + Demag + Zeeman   
**Kryterium:** m relaxuje do stanu bliskiego z (pole dominuje)

| Metryka | FDM | FEM | Tolerancja |
|---------|-----|-----|------------|
| ⟨mz⟩ (final) | > 0.95 | > 0.95 | oba > 0.95 |
| E_total (final) | $E_{FDM}$ | $E_{FEM}$ | $\|E_{FDM} - E_{FEM}\| / \|E_{FDM}\| < 0.10$ |
| max_torque (final) | < 1e-2 | < 1e-2 | oba small |

---

### 2.4 Test D: Mesh convergence study

**Cel:** Pokazać, że FEM zbieżne do FDM przy zmniejszaniu hmax.

**Setup:**
- Geometry: Box 100 × 100 × 20 nm
- Material: standard PermAlloy
- Interactions: Exchange + Demag
- hmax values: 10 nm, 7 nm, 5 nm, 3 nm
- Reference: FDM z dx = 2.5 nm

**Oczekiwanie:**

```
hmax     | E_ex diff vs FDM | Nz diff vs FDM |
---------|------------------|----------------|
10 nm    | < 20%            | < 0.20         |
7 nm     | < 10%            | < 0.15         |
5 nm     | < 5%             | < 0.10         |
3 nm     | < 3%             | < 0.05         |
```

```python
def test_mesh_convergence():
    """FEM results converge to FDM as hmax → 0."""
    fdm_reference = run_fdm(dx=2.5e-9)
    e_ref = fdm_reference.final_exchange_energy

    hmax_values = [10e-9, 7e-9, 5e-9, 3e-9]
    diffs = []

    for hmax in hmax_values:
        fem_result = run_fem(hmax=hmax)
        e_fem = fem_result.final_exchange_energy
        diff = abs(e_fem - e_ref) / abs(e_ref)
        diffs.append(diff)

    # Check convergence: diffs should decrease monotonically
    for i in range(1, len(diffs)):
        assert diffs[i] <= diffs[i-1] * 1.1, \
            f"Non-monotonic convergence at hmax={hmax_values[i]}"

    # Finest mesh should be within 5%
    assert diffs[-1] < 0.05, f"Finest mesh diff = {diffs[-1]}"
```

---

### 2.5 Test E: CPU FEM vs GPU FEM parity

**Cel:** Native GPU backend daje identyczne wyniki jak CPU reference.

```python
def test_gpu_cpu_parity():
    """GPU FEM backend produces same results as CPU FEM."""
    problem = standard_box_problem()

    # CPU reference
    result_cpu = problem.run(
        backend="fem", output_dir="output_fem_cpu",
        fem=fm.FEM(hmax=5e-9),
        env={"FULLMAG_FEM_BACKEND": "cpu"},
    )

    # GPU native
    result_gpu = problem.run(
        backend="fem", output_dir="output_fem_gpu",
        fem=fm.FEM(hmax=5e-9),
        env={"FULLMAG_FEM_BACKEND": "gpu"},
    )

    # Compare step-by-step
    scalars_cpu = fm.load_scalars(result_cpu.output_dir / "scalars.csv")
    scalars_gpu = fm.load_scalars(result_gpu.output_dir / "scalars.csv")

    for col in ['energy_exchange', 'energy_demag', 'avg_mx', 'avg_my', 'avg_mz']:
        max_rel_diff = max(
            abs(a - b) / (abs(a) + 1e-30)
            for a, b in zip(scalars_cpu[col], scalars_gpu[col])
        )
        assert max_rel_diff < 0.001, \
            f"{col}: max relative difference {max_rel_diff} > 0.1%"
```

---

### 2.6 Test F: Cylinder geometry (FEM-only)

**Cel:** FEM poprawnie obsługuje zakrzywioną geometrię bez staircasing artifacts.

**Geometria:** Cylinder R = 50 nm, H = 10 nm   
**Materiał:** Ms = 800 kA/m, A = 13 pJ/m, α = 0.5   
**m₀:** vortex state   
**Interakcje:** Exchange + Demag   
**Kryterium:** Worteks się stabilizuje; brak staircasing artifacts w polu demag.

```python
def test_cylinder_vortex():
    """FEM cylinder mesh supports vortex state without staircasing."""
    problem = fm.Problem(
        shape=fm.Cylinder(radius=50e-9, height=10e-9),
        material=fm.Material(ms=800e3, a_exchange=13e-12, alpha=0.5),
        initial_magnetization=fm.Vortex(),
        energy_terms=[fm.Exchange(), fm.Demag()],
        integrator=fm.Heun(dt=1e-14),
        n_steps=5000,
        fem=fm.FEM(hmax=5e-9),
    )

    result = problem.run(backend="fem", output_dir="output_fem_vortex")
    scalars = fm.load_scalars(result.output_dir / "scalars.csv")

    # Vortex should be stable: mz ≈ 0 (in-plane vortex)
    assert abs(scalars["avg_mz"].iloc[-1]) < 0.1

    # Energy should decrease or stabilize
    energies = scalars["energy_exchange"].values
    assert energies[-1] <= energies[0] * 1.01  # no blow-up
```

---

## 3. Narzędzia diagnostyczne

### 3.1 Skrypt porównawczy

**Plik:** `scripts/compare_backends.py`

```python
#!/usr/bin/env python3
"""Compare FDM and FEM backend results.

Usage:
    python scripts/compare_backends.py output_fdm/ output_fem/
"""

import sys
import pandas as pd
import numpy as np
import json
from pathlib import Path


def compare(fdm_dir: Path, fem_dir: Path):
    # Load scalars
    fdm_scalars = pd.read_csv(fdm_dir / "scalars.csv")
    fem_scalars = pd.read_csv(fem_dir / "scalars.csv")

    print("=" * 60)
    print("Cross-Backend Comparison Report")
    print("=" * 60)

    # Metadata
    with open(fdm_dir / "metadata.json") as f:
        fdm_meta = json.load(f)
    with open(fem_dir / "metadata.json") as f:
        fem_meta = json.load(f)

    print(f"\nFDM: {fdm_meta.get('backend', '?')}, device={fdm_meta.get('device', '?')}")
    print(f"FEM: {fem_meta.get('backend', '?')}, device={fem_meta.get('device', '?')}")
    print(f"FEM nodes: {fem_meta.get('n_nodes', '?')}, elements: {fem_meta.get('n_elements', '?')}")

    # Final state comparison
    print("\n--- Final State ---")
    for col in ['energy_exchange', 'energy_demag', 'energy_zeeman',
                'avg_mx', 'avg_my', 'avg_mz', 'max_torque']:
        if col in fdm_scalars.columns and col in fem_scalars.columns:
            v_fdm = fdm_scalars[col].iloc[-1]
            v_fem = fem_scalars[col].iloc[-1]
            if abs(v_fdm) > 1e-30:
                rel = abs(v_fdm - v_fem) / abs(v_fdm)
                status = "✅" if rel < 0.05 else "⚠️" if rel < 0.10 else "❌"
                print(f"  {status} {col:20s}  FDM={v_fdm:+.6e}  FEM={v_fem:+.6e}  "
                      f"rel_diff={rel:.4f}")
            else:
                abs_diff = abs(v_fdm - v_fem)
                status = "✅" if abs_diff < 1e-3 else "⚠️"
                print(f"  {status} {col:20s}  FDM={v_fdm:+.6e}  FEM={v_fem:+.6e}  "
                      f"abs_diff={abs_diff:.4f}")

    # Convergence check
    print("\n--- Convergence ---")
    for backend, scalars in [("FDM", fdm_scalars), ("FEM", fem_scalars)]:
        if 'max_torque' in scalars.columns:
            final_torque = scalars['max_torque'].iloc[-1]
            status = "✅" if final_torque < 1e-3 else "⚠️"
            print(f"  {status} {backend} max_torque = {final_torque:.6e}")

    # Energy monotonicity
    print("\n--- Energy Monotonicity ---")
    for backend, scalars in [("FDM", fdm_scalars), ("FEM", fem_scalars)]:
        if 'energy_exchange' in scalars.columns:
            e = scalars['energy_exchange'].values
            n_increase = sum(1 for i in range(1, len(e)) if e[i] > e[i-1] * 1.001)
            status = "✅" if n_increase == 0 else "⚠️"
            print(f"  {status} {backend}: {n_increase} non-monotonic steps "
                  f"(out of {len(e)-1})")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <fdm_output_dir> <fem_output_dir>")
        sys.exit(1)
    compare(Path(sys.argv[1]), Path(sys.argv[2]))
```

---

## 4. Porównanie z referencyjnymi solverami

### 4.1 tetmag comparison (opcjonalnie)

Jeśli tetmag jest skompilowany, porównać:
- Exchange energy na tym samym meshu
- Demag field na tym samym meshu
- Relaxation trajectory

**Ograniczenia:** tetmag używa innego integratora (RK45 z SUNDIALS) i BEM dla demag, 
więc wyniki nie będą identyczne — tylko rząd wielkości i trend powinny się zgadzać.

### 4.2 tetrax comparison (opcjonalnie)

tetrax (Python) jest łatwiejszy do uruchomienia. Porównanie:
- Exchange stiffness matrix K: element-wise comparison
- Node volumes: should match exactly
- Demag field for thin plate

---

## 5. CI integration

### 5.1 Test tiers

| Tier | Czas | Co testuje | CI frequency |
|------|------|------------|--------------|
| Smoke | < 10s | Create/step/destroy, basic assertions | Każdy PR |
| Parity | < 60s | CPU=GPU, small mesh (1k nodes) | Każdy PR |
| Cross-backend | < 5 min | FDM vs FEM on Box | Nightly |
| Convergence | < 30 min | Mesh refinement study (4 hmax) | Weekly |
| Reference (ext.) | < 1h | vs tetmag/tetrax | On-demand |

### 5.2 GitHub Actions

```yaml
# .github/workflows/fem-tests.yml

name: FEM Tests

on:
  pull_request:
    paths:
      - 'crates/fullmag-engine/src/fem/**'
      - 'native/backends/fem/**'
      - 'packages/fullmag-py/src/fullmag/meshing/**'

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      - name: Run FEM smoke tests
        run: cargo test --package fullmag-engine -- fem::tests

  parity:
    if: contains(github.event.pull_request.labels.*.name, 'gpu-test')
    runs-on: [self-hosted, gpu]
    steps:
      - uses: actions/checkout@v4
      - name: Build native FEM backend
        run: cmake --build native/build --target fullmag_fem_backend
      - name: Run GPU parity test
        run: ./native/build/fem_parity_test

  cross-backend:
    if: github.event.schedule
    runs-on: [self-hosted, gpu]
    steps:
      - uses: actions/checkout@v4
      - name: Run cross-backend comparison
        run: python -m pytest tests/cross_backend/ -v --timeout=300
```

---

## 6. Metryki jakości

### 6.1 Tablica wynikowa (do wypełnienia po implementacji)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cross-Backend Validation Results                                   │
├──────────────────┬─────────┬─────────┬──────────┬──────────────────┤
│  Scenario        │ FDM ref │ FEM CPU │ FEM GPU  │ Status           │
├──────────────────┼─────────┼─────────┼──────────┼──────────────────┤
│  A: Exchange     │  ___    │  ___    │  ___     │  ☐ PASS / FAIL   │
│  B: Demag Nz     │  ___    │  ___    │  ___     │  ☐ PASS / FAIL   │
│  C: Full relax   │  ___    │  ___    │  ___     │  ☐ PASS / FAIL   │
│  D: Convergence  │  OK     │  ___    │  ___     │  ☐ PASS / FAIL   │
│  E: CPU/GPU par  │  N/A    │  ref    │  ___     │  ☐ PASS / FAIL   │
│  F: Cylinder     │  N/A    │  ___    │  ___     │  ☐ PASS / FAIL   │
└──────────────────┴─────────┴─────────┴──────────┴──────────────────┘
```

---

## 7. Kryteria akceptacji S6

| # | Kryterium |
|---|-----------|
| 1 | Test A (exchange relaxation): FDM ↔ FEM < 5% |
| 2 | Test B (demag Nz): oba < 15% od analitycznego |
| 3 | Test C (full sim): oba converge to same state |
| 4 | Test D (convergence): monotonic decrease in error |
| 5 | Test E (CPU/GPU parity): < 0.1% |
| 6 | Test F (cylinder): stable vortex, no blow-up |
| 7 | Skrypt `compare_backends.py` generuje raport |
| 8 | CI: smoke tests pass on every PR |

---

## 8. Ryzyka

| Ryzyko | Wpływ | Mitigacja |
|--------|-------|-----------|
| FEM air-box za mały → demag nie zgadza się z FDM | Test B fails | Eksperymentować z factor 3→5→7 |
| FDM i FEM mają różne boundary effects | Duże diff na krawędziach | Porównywać wnętrze (ignorować boundary nodes) |
| Mesh convergence non-monotonic | Test D fails | Sprawdzić jakość meshów, stabilność CG |
| tetmag/tetrax niedostępne na CI | Brak reference test | Opcjonalny test, nie blokujący |
