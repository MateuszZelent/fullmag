# BORIS N/F reciprocal SHE comparison harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task with verification checkpoints. Do not promote a capability from this plan without the managed runtime evidence described in Task 7.

**Goal:** Build a reproducible executable BORIS N/F reciprocal-SHE diagnostic and compare its normalized fields, residuals, flux balances, and interface torque with the Fullmag FDM CPU-double M2 reference lane.

**Architecture:** A pure Python scenario renderer emits a deterministic embedded-NetSocks BORIS script. A host-side runner owns managed external execution and records immutable runtime identity; an independent verifier parses BORIS text-OVF fields, recomputes residuals and interface balances, and writes `fullmag.boris_she_nf.v1`. A separate comparison module maps BORIS `S` to `V_s` and then to Fullmag `mu_s`, rejecting mesh, sign, unit, or convention mismatches before calculating observable errors. N/T/F and CUDA reuse the schema but remain separate gates.

**Tech Stack:** Python 3.10+, standard library (`dataclasses`, `json`, `hashlib`, `subprocess`, `pathlib`), pytest, BORIS embedded NetSocks, text OVF 2.0, Fullmag FDM CPU-double JSON artifacts, and the repository `just` runtime wrappers.

## Global Constraints

- Keep `SHA=iSHA` for reciprocal evidence; unequal values are diagnostic-only and cannot pass the Onsager gate.
- Use the explicit adapter `V_s = De*S/(elC*MUB_E)` and declare `mu_s = 2*V_s` in every normalized artifact.
- The N region is below F in `+z`; the F mesh owns non-zero `Gi=[G_i,0]` and `Gmix=[G_r,G_i]` values.
- Store geometry, material values, tensor component order, signs, units, tolerances, and normal orientation in the artifact.
- Fail closed on missing fields, non-finite values, mismatched grids, missing runtime identity, or stale output files.
- Do not modify `external_solvers/BORIS`; use only the managed patched build copy under `/zfn2/mateuszz/git/fullmag/boris-build`.
- Keep heavy build/run data below `/zfn2/mateuszz/git/fullmag`; commit only source, small fixtures, summaries, and documentation.
- Do not change `docs/specs/capability-matrix-v0.json` to `validated` or add a production lane in this plan.
- Preserve the unrelated dirty paths listed by `git status --short` and stage only files named by each task.

---

### Task 1: Add the deterministic N/F scenario model and renderer

**Files:**
- Create: `scripts/boris_nf_interface_smoke.py`
- Create: `scripts/test_boris_nf_interface_smoke.py`

**Interfaces:**
- `NfCaseConfig(nx: int, ny: int, nz_n: int, nz_f: int, output_dir: Path, use_tunnel_barrier: bool = False, barrier_m: float = 0.0) -> None` stores the complete SI workload.
- `render_boris_script(config: NfCaseConfig) -> str` returns a self-contained script accepted by BORIS `-s` and containing no host-only imports.
- `scenario_manifest(config: NfCaseConfig) -> dict[str, object]` returns normalized JSON with sorted keys and the exact field names consumed by the verifier.

- [ ] **Step 1: Write the failing renderer tests**

```python
def test_nf_manifest_declares_reciprocal_interface() -> None:
    config = NfCaseConfig(output_dir=Path("/run"))
    manifest = scenario_manifest(config)
    assert manifest["workload"] == "N/F"
    assert manifest["parameters"]["SHA"] == manifest["parameters"]["iSHA"]
    assert manifest["parameters"]["Gi_Spm2"] > 0.0
    assert manifest["parameters"]["Gmix_Spm2"] == [1.5e15, 0.0]


def test_rendered_script_exports_both_meshes_and_all_fields() -> None:
    script = render_boris_script(NfCaseConfig(output_dir=Path("/run")))
    assert "ns.Conductor" in script and "ns.Ferromagnet" in script
    assert "conductor.param.iSHA" in script
    assert "ferromagnet.param.Gmix = [1.5e15, 0.0]" in script
    for filename in ("n_V.ovf", "f_V.ovf", "n_S.ovf", "f_S.ovf", "f_Ts.ovf", "f_Tsi.ovf"):
        assert filename in script
```

- [ ] **Step 2: Run the focused tests and verify the expected import failure**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_nf_interface_smoke.py`

Expected: FAIL because `NfCaseConfig`, `scenario_manifest`, and `render_boris_script` do not exist.

- [ ] **Step 3: Implement the minimal scenario model and template**

Implement `NfCaseConfig` with defaults matching the stable first workload:
`nx=10`, `ny=4`, `nz_n=2`, `nz_f=2`, `cell=(1e-7,1e-7,1e-9) m`,
`length=(1e-6,4e-7) m`, `theta_sh=0.10`, `elC=5.8e7 S/m`, `De=0.01 m²/s`,
`lambda_sf=5e-9 m`, `Gi=5e14 S/m²`, `Gmix=(1.5e15,0.0) S/m²`,
`Jc=(1e11,0,0) A/m²`, `Ms=8e5 A/m`, `A=1.3e-11 J/m`, and `m=(1,0,0)`.

The rendered script must:

```python
from NetSocks import NSClient
ns = NSClient()
ns.configure(reset_to_default=True, script_verbose=True)
n = ns.Conductor([0, 0, 0, 1e-6, 4e-7, 2e-9], [1e-7, 1e-7, 1e-9], "normal")
f = ns.Ferromagnet([0, 0, 2e-9, 1e-6, 4e-7, 4e-9], [1e-7, 1e-7, 1e-9], "ferromagnet")
n.modules("transport")
f.modules("transport")
n.param.SHA = 0.10
n.param.iSHA = 0.10
f.param.Gi = [5e14, 0.0]
f.param.Gmix = [1.5e15, 0.0]
f.setangle(90.0, 0.0)
ns.setcurrentdensity(n, 1e11, 0.0, 0.0)
ns.statictransportsolver(1)
ns.setstages(["Relax", "iter", 1])
ns.Run()
```

It must export `V`, `S`, `Jc`, `Jsx`, `Jsy`, `Jsz` for N and F and `Ts`/`Tsi`
for F with `saveovf2("text", <absolute-output-path>)`, then write
`boris_native_samples.json` containing probe values, requested SHA/iSHA,
`Gi`, `Gmix`, stage completion, and the output file names. The optional
N/T/F renderer must be present but disabled by default and must add a named
insulator thickness/conductance rather than silently changing N/F.

- [ ] **Step 4: Run the focused tests and inspect the generated script**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_nf_interface_smoke.py && PYTHONPATH=scripts python3 -c 'from pathlib import Path; from boris_nf_interface_smoke import *; print(render_boris_script(NfCaseConfig(output_dir=Path("/tmp/boris-nf"))))' | rg 'Conductor|Ferromagnet|iSHA|Gmix|f_Ts.ovf'`

Expected: all renderer tests pass and the generated script contains both
meshes, reciprocal coefficients, non-zero interface conductances, and every
required field export.

- [ ] **Step 5: Commit the scenario unit**

```bash
git add scripts/boris_nf_interface_smoke.py scripts/test_boris_nf_interface_smoke.py
git diff --cached --name-only
git commit -m "test: add deterministic BORIS N/F SHE scenario"
```

### Task 2: Implement OVF parsing, adapter mapping, and independent residuals

**Files:**
- Create: `scripts/verify_boris_nf_interface.py`
- Create: `scripts/test_verify_boris_nf_interface.py`

**Interfaces:**
- `read_text_ovf(path: Path) -> OvfField` parses one rectangular OVF 2.0 text segment and rejects missing dimensions or wrong `valuedim`.
- `map_boris_spin_to_fullmag_mu_s(spin: Sequence[Vector3], de_m2_per_s: float, conductivity_spm: float) -> list[Vector3]` applies the declared `V_s` and `mu_s` mapping elementwise.
- `compute_field_residuals(fields: MeshFields, parameters: ScenarioParameters) -> ResidualReport` returns charge and spin scaled L2 residuals computed from finite-volume interior differences and reaction terms.
- `compute_interface_balance(normal: InterfaceSlice) -> InterfaceBalance` returns charge closure, spin-flux closure, absorbed transverse flux, and torque closure with signed normals.
- `validate_boris_artifact(root: Path) -> dict[str, object]` returns the schema-v1 diagnostic report or raises `ValueError` on any invalid contract.

- [ ] **Step 1: Write failing parser and physics tests**

```python
def test_text_ovf_reader_preserves_grid_and_vector_order(tmp_path: Path) -> None:
    path = tmp_path / "field.ovf"
    path.write_text("""# OOMMF OVF 2.0
# Begin: Segment
# Begin: Header
# meshtype: rectangular
# xnodes: 2
# ynodes: 1
# znodes: 1
# xstepsize: 1e-9
# ystepsize: 1e-9
# zstepsize: 1e-9
# valuedim: 3
# End: Header
# Begin: Data Text
1 2 3
4 5 6
# End: Data Text
# End: Segment
""", encoding="utf-8")
    field = read_text_ovf(path)
    assert field.shape == (2, 1, 1)
    assert field.values == [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)]


def test_spin_adapter_declares_full_splitting() -> None:
    mapped = map_boris_spin_to_fullmag_mu_s([(1.0, 0.0, 0.0)], 0.01, 5.8e7)
    assert mapped[0][0] == pytest.approx(2.0 * 0.01 / (5.8e7 * 5.788381608e-5))


def test_interface_balance_rejects_wrong_normal_sign() -> None:
    with pytest.raises(ValueError, match="normal"):
        compute_interface_balance(
            InterfaceSlice(
                normal_axis="q",
                normal_sign=0,
                normal_flux=(0.0, 0.0, 0.0),
                ferromagnet_flux=(0.0, 0.0, 0.0),
                torque=(0.0, 0.0, 0.0),
            )
        )
```

- [ ] **Step 2: Run tests and verify they fail before implementation**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_verify_boris_nf_interface.py`

Expected: FAIL because the parser, adapter, and balance functions are absent.

- [ ] **Step 3: Implement parser and mapping with explicit metadata**

`OvfField` must store `path`, `shape`, `origin_m`, `step_m`, `valuedim`,
`values`, and a SHA-256 of the source file. Parse only `# Begin: Data Text`
and reject binary segments, multiple segments, NaN/Inf, wrong value counts,
and data lengths different from `xnodes*ynodes*znodes`. Keep BORIS ordering
(`x` fastest, then `y`, then `z`) and expose a helper that reshapes without
transposing components.

Use the exact physical constant from the existing reduced oracle:
`MUB_E_V_PER_T = 5.788381608e-05`. The adapter result must carry
`spin_voltage_convention="boris_channel_voltage"`,
`mapping="V_s=De*S/(elC*MUB_E); mu_s=2*V_s"`, and the source conductivity and
`De` used for the conversion.

- [ ] **Step 4: Implement residuals and interface balances**

For each mesh, calculate centered finite-volume divergence of `Jc` and each
spin-current component `J_{i,a}` on interior cells. Scale charge by
`max(|Jc|, 1 A/m²)` and spin by `max(|J_s|, 1 A/m²)`. At the N/F plane use the
N `+z` slice and F `-z` slice with a declared outward-normal sign. Require
finite values, compare `Jc_z` closure, and report each component of
`Jsy/Jsz` flux difference and F `Ts`/`Tsi` torque. Never infer a missing torque
from a residual.

The verifier must retain all tolerances in the report:
`charge_residual_tolerance`, `spin_residual_tolerance`,
`charge_interface_tolerance`, and `spin_torque_balance_tolerance`.

- [ ] **Step 5: Implement schema-v1 validation and fixture reports**

`validate_boris_artifact` must require:

```text
schema_version == "fullmag.boris_she_nf.v1"
runtime.identity_complete == true
scenario.workload == "N/F"
scenario.parameters.SHA == scenario.parameters.iSHA
scenario.parameters.Gi_Spm2 != 0
scenario.parameters.Gmix_Spm2[0] != 0
fields.normal and fields.ferromagnet contain V,S,Jc,Jsx,Jsy,Jsz
fields.ferromagnet contains Ts and Tsi
```

It writes `qualification.status="diagnostic"` even when all local checks pass;
the comparison and production qualification statuses are separate values.

- [ ] **Step 6: Run parser, mapping, residual, and mutation tests**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_verify_boris_nf_interface.py`

Expected: all tests pass, including mutations for missing runtime identity,
`SHA != iSHA`, NaN fields, wrong dimensions, wrong `mu_s` factor, and flipped
interface normals.

- [ ] **Step 7: Commit the independent verifier**

```bash
git add scripts/verify_boris_nf_interface.py scripts/test_verify_boris_nf_interface.py
git diff --cached --name-only
git commit -m "test: add independent BORIS SHE field verifier"
```

### Task 3: Add managed BORIS execution and immutable runtime identity

**Files:**
- Create: `scripts/run_boris_nf_interface.py`
- Create: `scripts/test_run_boris_nf_interface.py`
- Modify: `justfile` (add `verify-boris-nf-interface` after the external-solver smoke recipes)

**Interfaces:**
- `capture_runtime_identity(build_root: Path, image_digest: str, device: str) -> dict[str, object]` records source manifest, binary hash, image digest, Python version, requested/detected device, and precision.
- `validate_runtime_identity(identity: dict[str, object]) -> None` rejects incomplete CPU/CUDA identity records, including missing device-residency evidence for CUDA.
- `run_boris_case(config: NfCaseConfig, build_root: Path, output_dir: Path, device: str) -> Path` renders the scenario, invokes BORIS, validates exit/stage completion, and returns the artifact directory.
- CLI: `python3 scripts/run_boris_nf_interface.py --build-root /zfn2/mateuszz/git/fullmag/boris-build/source --output-dir /tmp/boris-nf-run --device cpu --resolution 0`.

- [ ] **Step 1: Write failing identity and command-construction tests**

```python
def test_identity_rejects_missing_binary(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="BorisLin"):
        capture_runtime_identity(tmp_path, "sha256:test", "cpu")


def test_runner_refuses_nonempty_output(tmp_path: Path) -> None:
    (tmp_path / "stale.txt").write_text("stale", encoding="utf-8")
    with pytest.raises(RuntimeError, match="non-empty"):
        run_boris_case(NfCaseConfig(output_dir=tmp_path), Path("/build"), tmp_path, "cpu")
```

- [ ] **Step 2: Run the tests and verify the expected missing-symbol failures**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_run_boris_nf_interface.py`

Expected: FAIL because the runner functions are absent.

- [ ] **Step 3: Implement identity capture without touching the ignored snapshot**

Require `build_root / "BorisLin"` and a source manifest file. Hash the executable
and manifest with SHA-256. Run `[str(build_root / "BorisLin"), "-version"]` in the managed
runtime and store stdout/stderr hashes. Store the exact CUDA image digest and
`nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader` output when the
device is CUDA. Missing values raise `RuntimeError`; they are never replaced
with `"unknown"`.

- [ ] **Step 4: Implement execution and artifact assembly**

Create a unique output directory below the caller-provided durable root,
write `scenario.py`, `scenario.json`, and `runtime.json`, then invoke the
existing BORIS embedded-script command from the managed CUDA image. The
runner must preserve stdout/stderr, require the `BORIS_NF_STAGE_COMPLETE`
marker, load the native samples, call `validate_boris_artifact`, and write
`summary.json`. A process timeout or listener exit is `not_run` unless the
stage marker and all fields are present.

- [ ] **Step 5: Add the `just` recipe**

The recipe must use only repository-owned Python/managed runtime paths and
write reports below `/zfn2/mateuszz/git/fullmag/boris-build/reports` (or the
explicit `FULLMAG_BORIS_SHE_REPORT_ROOT`). It must execute three resolutions
(`10x4x2+2`, `20x8x4+4`, `40x16x8+8`) and pass each summary to the verifier.
It must not run automatically as part of `just test`.

- [ ] **Step 6: Run unit tests and a bounded managed case**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_run_boris_nf_interface.py`

Then run: `FULLMAG_BORIS_SHE_RESOLUTIONS=coarse just verify-boris-nf-interface`

Expected: unit tests pass. The managed run either writes a complete
`fullmag.boris_she_nf.v1` diagnostic summary or fails with the exact missing
runtime/field/residual reason; no silent skip is accepted.

- [ ] **Step 7: Commit the execution lane**

```bash
git add scripts/run_boris_nf_interface.py scripts/test_run_boris_nf_interface.py justfile
git diff --cached --name-only
git commit -m "test: add managed BORIS N/F SHE execution lane"
```

### Task 4: Materialize a Fullmag FDM M2 comparison artifact

**Files:**
- Create: `scripts/compare_boris_fullmag_she_nf.py`
- Create: `scripts/test_compare_boris_fullmag_she_nf.py`
- Modify: `scripts/verify_boris_nf_interface.py` (export normalized field helpers only)

**Interfaces:**
- `load_fullmag_m2_artifact(path: Path) -> NormalizedTransportArtifact` accepts the existing FDM M2 JSON field schema and requires `component_order="row_major_Q_ia"`.
- `normalize_boris_artifact(path: Path) -> NormalizedTransportArtifact` maps mesh coordinates, units, and `mu_s` convention without changing signs.
- `compare_transport_artifacts(boris: NormalizedTransportArtifact, fullmag: NormalizedTransportArtifact) -> dict[str, object]` reports per-observable max absolute error, normalized L2 error, endpoint error, and convention metadata.
- CLI: `python3 scripts/compare_boris_fullmag_she_nf.py --boris <summary.json> --fullmag <transport.json> --output <comparison.json>`.

- [ ] **Step 1: Write failing normalization and mismatch tests**

```python
def test_comparison_reports_zero_for_identical_normalized_fields(tmp_path: Path) -> None:
    boris = fixture_boris_artifact(mu_s=[(1.0, 2.0, 3.0)])
    fullmag = fixture_fullmag_artifact(mu_s=[(1.0, 2.0, 3.0)])
    result = compare_transport_artifacts(boris, fullmag)
    assert result["status"] == "diagnostic_match"
    assert result["observables"]["mu_s"]["max_relative_error"] == 0.0


def test_comparison_rejects_mesh_and_convention_mismatch() -> None:
    with pytest.raises(ValueError, match="incomparable"):
        compare_transport_artifacts(fixture_boris_artifact(nx=10), fixture_fullmag_artifact(nx=20))
```

- [ ] **Step 2: Run tests and verify missing comparison symbols**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_compare_boris_fullmag_she_nf.py`

Expected: FAIL because the normalization and comparison functions are absent.

- [ ] **Step 3: Implement normalized artifact loading**

Represent each normalized artifact with `shape`, `step_m`, `potential_v`,
`mu_s_v`, `charge_current_apm2`, `spin_current_qia_apm2`, `torque_per_s`,
`residuals`, `interface_balances`, `formula_version`, `normal_axis`, and
`normal_sign`. Require the Fullmag formula version and BORIS adapter metadata
to be explicit; reject an artifact that only supplies a flattened 3-vector in
place of the nine-component `Q_ia` tensor.

- [ ] **Step 4: Implement the comparison metrics**

Compare `V`, mapped `mu_s`, each `Q_ia` component, `Jc`, interface absorbed
spin flux, torque, charge residual, and spin residual separately. Use
`max(|a-b|)/max(max(|a|),max(|b|),1e-300)` and an L2 norm with the same mesh
weights. Preserve numerical differences as data; do not emit `validated` from
this module. Set `status` to `diagnostic_match`, `diagnostic_mismatch`, or
`incomparable`.

- [ ] **Step 5: Run comparison unit tests**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_compare_boris_fullmag_she_nf.py`

Expected: all tests pass, including wrong factor-of-two, flipped normal,
flattened-vector, wrong formula version, and non-finite field mutations.

- [ ] **Step 6: Commit the comparison adapter**

```bash
git add scripts/compare_boris_fullmag_she_nf.py scripts/test_compare_boris_fullmag_she_nf.py scripts/verify_boris_nf_interface.py
git diff --cached --name-only
git commit -m "test: compare normalized BORIS and Fullmag SHE artifacts"
```

### Task 5: Connect the adapter to the existing Fullmag FDM M2 reference lane

**Files:**
- Modify: `scripts/compare_boris_fullmag_she_nf.py`
- Create: `scripts/run_fullmag_m2_nf_reference.py`
- Create: `scripts/test_run_fullmag_m2_nf_reference.py`

**Interfaces:**
- `build_fullmag_nf_problem(resolution: Resolution) -> dict[str, object]` returns a canonical Python/ProblemIR input with two transport regions, identical N/F geometry, explicit `Gi/Gmix` interface data, and FDM CPU-double strict execution.
- `run_fullmag_nf_reference(fullmag_binary: Path, resolution: Resolution, output_dir: Path) -> Path` executes only the supported FDM CPU-double M2 reference path and returns its JSON artifact.

- [ ] **Step 1: Write failing canonical-input tests**

```python
def test_reference_problem_is_strict_fdm_cpu_double() -> None:
    problem = build_fullmag_nf_problem(Resolution(10, 4, 2, 2))
    assert problem["execution"]["discretization"] == "fdm"
    assert problem["execution"]["device"] == "cpu"
    assert problem["execution"]["precision"] == "double"
    assert problem["transport"]["coupling"] == "bidirectional"
    assert problem["transport"]["interface"]["Gi_Spm2"] > 0.0
```

- [ ] **Step 2: Run focused tests and verify missing canonical builder**

Run: `PYTHONPATH=packages/fullmag-py/src:scripts python3 -m pytest -q scripts/test_run_fullmag_m2_nf_reference.py`

Expected: FAIL because the canonical builder is absent.

- [ ] **Step 3: Implement the canonical FDM CPU-double input**

Use the public Python DSL and existing M2 coupling-owned lowering. The input
must carry the same `sigma`, `theta_SH`, `lambda_sf`, `SHA=iSHA`, `Gi/Gmix`,
mesh dimensions, charge gauge, and spin boundary declarations as the BORIS
manifest. It must reject FEM/GPU/single requests before execution.

- [ ] **Step 4: Implement subprocess execution and artifact checks**

Invoke the existing Fullmag JSON runner with an explicit output directory,
require the M2 artifact schema and `resolved_execution={fdm,cpu,double}`,
require finite `mu_s`, `Q_ia`, charge/spin residuals, interface observations,
and preserve the exact generated ProblemIR/source hashes.

- [ ] **Step 5: Run the focused reference tests**

Run: `PYTHONPATH=packages/fullmag-py/src:scripts python3 -m pytest -q scripts/test_run_fullmag_m2_nf_reference.py`

Expected: authoring and fail-closed execution tests pass. If the managed
Fullmag binary is unavailable, the test must report `not_run` rather than
fabricate an artifact.

- [ ] **Step 6: Commit the Fullmag reference adapter**

```bash
git add scripts/run_fullmag_m2_nf_reference.py scripts/test_run_fullmag_m2_nf_reference.py scripts/compare_boris_fullmag_she_nf.py
git diff --cached --name-only
git commit -m "test: materialize Fullmag M2 N/F reference artifact"
```

### Task 6: Add three-resolution and tolerance-sweep orchestration

**Files:**
- Modify: `scripts/run_boris_nf_interface.py`
- Modify: `scripts/run_fullmag_m2_nf_reference.py`
- Modify: `scripts/compare_boris_fullmag_she_nf.py`
- Create: `scripts/test_boris_fullmag_she_nf_matrix.py`
- Modify: `justfile`

**Interfaces:**
- `run_resolution_matrix(resolutions: Sequence[Resolution], tolerances: Sequence[float], boris_build_root: Path, fullmag_binary: Path, report_root: Path) -> dict[str, object]` writes one immutable run directory per tuple and an aggregate summary.
- `validate_matrix_summary(summary: dict[str, object]) -> None` requires all declared tuples, finite metrics, and monotone residual/error trends before writing a report.

- [ ] **Step 1: Write failing matrix tests**

```python
def test_matrix_requires_three_resolutions_and_two_tolerances() -> None:
    with pytest.raises(ValueError, match="three resolutions"):
        validate_matrix_summary({"runs": [{"resolution": "coarse", "tolerance": 1e-8}]})


def test_matrix_rejects_duplicate_run_identity() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        validate_matrix_summary(fixture_matrix_with_duplicate_identity())
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_fullmag_she_nf_matrix.py`

Expected: FAIL because matrix validation is absent.

- [ ] **Step 3: Implement matrix orchestration**

Use resolutions `(10,4,2,2)`, `(20,8,4,4)`, `(40,16,8,8)` and tolerances
`1e-8`, `1e-10`. Every run stores `scenario_sha256`, `runtime_sha256`,
`binary_sha256`, `resolution`, `tolerance`, and normalized comparison output.
No run may reuse a non-empty directory or overwrite a previous identity.

- [ ] **Step 4: Add an aggregate `just verify-boris-fullmag-she-nf` recipe**

The recipe runs the BORIS managed lane, the Fullmag FDM CPU-double lane, the
comparison, and `validate_matrix_summary` in that order. It writes only small
JSON/CSV summaries to the durable report root and leaves large OVF fields in
the durable run store. It does not alter capability JSON.

- [ ] **Step 5: Run matrix unit tests**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_fullmag_she_nf_matrix.py`

Expected: all matrix contract tests pass.

- [ ] **Step 6: Commit matrix orchestration**

```bash
git add scripts/run_boris_nf_interface.py scripts/run_fullmag_m2_nf_reference.py scripts/compare_boris_fullmag_she_nf.py scripts/test_boris_fullmag_she_nf_matrix.py justfile
git diff --cached --name-only
git commit -m "test: add BORIS Fullmag SHE convergence matrix"
```

### Task 7: Execute the managed evidence and document the result

**Files:**
- Modify: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md`
- Modify: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/BORIS_FULLMAG_SHE_COMPARISON.md`
- Create: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/boris-nf-she-v1/README.md`

- [ ] **Step 1: Verify the repository state and managed storage**

Run:

```bash
git status --short --branch
df -h /zfn2/mateuszz/git/fullmag
test -x /zfn2/mateuszz/git/fullmag/boris-build/source/BorisLin
```

Expected: only the known unrelated paths are dirty, the durable root has
space, and the managed BORIS executable exists. If any check fails, record
`unqualified_runtime` and do not substitute a host build.

- [ ] **Step 2: Run the complete N/F matrix**

Run: `FULLMAG_BORIS_SHE_REPORT_ROOT=/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-boris-she-nf-v1 just verify-boris-fullmag-she-nf`

Expected: each of the six resolution/tolerance tuples produces an immutable
BORIS artifact, a Fullmag CPU-double artifact, and a comparison JSON; any
failure stops the recipe and retains stdout/stderr plus the failure reason.

- [ ] **Step 3: Review physics evidence manually**

Check that `S`, `V`, `Jc`, `Jsx`, `Jsy`, `Jsz`, `Ts`, and `Tsi` are finite and
non-zero where the scenario requires them; `SHA=iSHA`; `Gi/Gmix` are non-zero;
charge and spin residuals are below their recorded tolerances; interface
flux plus torque closes with the declared normal; and the three-resolution
trend is reproducible. Treat numerical disagreement separately from solver
failure and convention mismatch.

- [ ] **Step 4: Update the two audit documents with exact evidence**

Add a dated subsection containing the report root, scenario/source/runtime/
binary hashes, container image digest, resolution/tolerance matrix, residuals,
interface balances, mapped `mu_s`, comparison metrics, and explicit status.
If the run fails, document the exact failure and leave `SHE-BORIS-001` open.
Never write `validated` unless every gate in the plan has actually passed.

- [ ] **Step 5: Run documentation and regression checks**

Run:

```bash
git diff --check
python3 scripts/check_repo_consistency.py
PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_nf_interface_smoke.py scripts/test_verify_boris_nf_interface.py scripts/test_run_boris_nf_interface.py scripts/test_compare_boris_fullmag_she_nf.py scripts/test_boris_fullmag_she_nf_matrix.py
```

Expected: no whitespace errors, documentation consistency passes, and all
focused harness tests pass. The managed matrix remains the only executable
physics evidence.

- [ ] **Step 6: Commit and push only the harness/documentation changes**

Before committing, run `git diff --cached --name-only` in a separate command
after staging only the files listed in this task. Commit with:

```bash
git add scripts docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/BORIS_FULLMAG_SHE_COMPARISON.md
git diff --cached --name-only
git commit -m "docs: record BORIS N/F reciprocal SHE evidence"
git push origin master
```

Do not include `external_solvers/3`, the existing Mumax audit, or the OVF
conversion files in the commit.

### Task 8: Add the N/T/F and CUDA follow-up gates without conflating status

**Files:**
- Modify: `scripts/boris_nf_interface_smoke.py`
- Modify: `scripts/verify_boris_nf_interface.py`
- Modify: `scripts/run_boris_nf_interface.py`
- Create: `scripts/test_boris_ntf_interface.py`
- Modify: `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md`

- [ ] **Step 1: Write failing N/T/F contract tests**

```python
def test_ntf_requires_barrier_thickness_and_conductance() -> None:
    with pytest.raises(ValueError, match="barrier"):
        render_boris_script(NfCaseConfig(use_tunnel_barrier=True, barrier_m=0.0))


def test_cuda_evidence_requires_device_residency_fields() -> None:
    with pytest.raises(ValueError, match="device residency"):
        validate_runtime_identity({"requested_device": "cuda", "detected_device": "RTX"})
```

- [ ] **Step 2: Implement explicit N/T/F and CPU/CUDA metadata**

Add a real insulator mesh and independent N/T and T/F conductance parameters;
export both interface fluxes and barrier-limit comparison. For CUDA require
requested device, detected device, precision, runtime kernel/device evidence,
and field hashes; source CUDA code or a successful launch without those fields
must remain `unqualified_runtime`.

- [ ] **Step 3: Run follow-up unit tests and update the plan status**

Run: `PYTHONPATH=scripts python3 -m pytest -q scripts/test_boris_ntf_interface.py`

Expected: N/T/F and CUDA metadata tests pass. Update the audit plan only with
the actual status (`diagnostic`, `failed_physics`, `unqualified_runtime`, or
`incomparable`) and preserve `semantic_only` capability entries until the
separate CPU/CUDA, three-grid, interface, and cross-backend gates are complete.

- [ ] **Step 4: Commit follow-up scope separately**

```bash
git add scripts/boris_nf_interface_smoke.py scripts/verify_boris_nf_interface.py scripts/run_boris_nf_interface.py scripts/test_boris_ntf_interface.py docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md
git diff --cached --name-only
git commit -m "test: define BORIS N/T/F and CUDA SHE gates"
```
