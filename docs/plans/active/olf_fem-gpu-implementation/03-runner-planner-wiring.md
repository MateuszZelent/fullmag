# S3: Podłączenie FEM do Planner / Runner / Artifacts

- Etap: **S3** (po S1 + S2)
- Priorytet: **HIGH** — bez tego FEM nie jest uruchamialny z CLI/API
- Docelowe crate'y: `fullmag-plan`, `fullmag-runner`, `fullmag-engine`, `fullmag-py-core`

---

## 1. Cele etapu

1. **Planner**: Lowering `ProblemIR` + FEM hints → `FemPlanIR` z pełnymi danymi siatki.
2. **Runner**: Dispatch `FemPlanIR` do `execute_reference_fem()` (CPU ref) lub native backendu.
3. **Artefakty**: FEM generuje te same pliki co FDM (`scalars.csv`, `fields/*.json`, `metadata.json`).
4. **Python API**: `fm.run()` z `backend="fem"` uruchamia się end-to-end.
5. **CLI**: `fullmag run script.py --backend fem` działa.

---

## 2. Planner — lowering FEM

### Obecny stan (2026-03-24)

```rust
// crates/fullmag-plan/src/lib.rs
// BackendTarget::Fem → planner buduje bootstrapowy FemPlanIR z precomputed MeshIR,
// ale crates/fullmag-runner nadal nie wykonuje BackendPlanIR::Fem
```

### Docelowy stan

```rust
pub fn plan(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    match problem.backend {
        BackendTarget::Fdm => plan_fdm(problem),
        BackendTarget::Fem => plan_fem(problem),
    }
}

fn plan_fem(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    // 1. Validate FEM hints exist
    let fem_hints = problem.fem_hints.as_ref()
        .ok_or(PlanError::MissingFemHints)?;

    // 2. Validate mesh data exists (generated during to_ir())
    let mesh = problem.mesh.as_ref()
        .ok_or(PlanError::MissingMesh)?;
    mesh.validate().map_err(PlanError::InvalidMesh)?;

    // 3. Validate material
    let material = &problem.material;
    validate_material(material)?;

    // 4. Validate energy terms
    let energy_terms = &problem.energy_terms;
    validate_energy_terms_fem(energy_terms)?;

    // 5. Determine air-box config
    let air_box = if energy_terms.iter().any(|e| matches!(e, EnergyTermIR::Demag)) {
        Some(AirBoxConfig {
            factor: problem.air_box_factor.unwrap_or(3.0),
            outer_bc: AirBoxBoundaryCondition::Dirichlet,
        })
    } else {
        None
    };

    // 6. Build FemPlanIR
    let fem_plan = FemPlanIR {
        mesh: mesh.clone(),
        fe_order: fem_hints.order,
        material: material.clone(),
        energy_terms: energy_terms.clone(),
        initial_magnetization: problem.initial_magnetization.clone(),
        exchange_bc: problem.exchange_bc.clone(),
        integrator: problem.integrator.clone(),
        fixed_timestep: problem.fixed_timestep,
        air_box,
        demag_solver: DemagSolverConfig {
            solver: LinearSolverType::Cg,
            preconditioner: PreconditionerType::None,  // CPU ref: no preconditioning
            rtol: 1e-10,
            max_iter: 5000,
        },
    };

    Ok(ExecutionPlanIR::Fem(fem_plan))
}


fn validate_energy_terms_fem(terms: &[EnergyTermIR]) -> Result<(), PlanError> {
    for term in terms {
        match term {
            EnergyTermIR::Exchange => {} // OK
            EnergyTermIR::Demag => {}    // OK
            EnergyTermIR::Zeeman(_) => {} // OK
            EnergyTermIR::InterfacialDmi(_) => {
                return Err(PlanError::UnsupportedTerm("InterfacialDMI not yet implemented for FEM"));
            }
            EnergyTermIR::BulkDmi(_) => {
                return Err(PlanError::UnsupportedTerm("BulkDMI not yet implemented for FEM"));
            }
            EnergyTermIR::UniaxialAnisotropy(_) => {
                return Err(PlanError::UnsupportedTerm("UniaxialAnisotropy not yet implemented for FEM"));
            }
        }
    }
    Ok(())
}
```

### Zmiany w `ExecutionPlanIR`

```rust
pub enum ExecutionPlanIR {
    Fdm(FdmPlanIR),
    Fem(FemPlanIR),  // NEW
}
```

---

## 3. Runner — dispatch FEM

### Obecny stan

Runner obsługuje `ExecutionPlanIR::Fdm` → dispatch do CPU ref lub native CUDA.

### Docelowy stan

```rust
// crates/fullmag-runner/src/lib.rs

pub fn execute(plan: ExecutionPlanIR, output_dir: &Path) -> Result<RunResult, RunError> {
    match plan {
        ExecutionPlanIR::Fdm(fdm_plan) => execute_fdm(fdm_plan, output_dir),
        ExecutionPlanIR::Fem(fem_plan) => execute_fem(fem_plan, output_dir),
    }
}

fn execute_fem(plan: FemPlanIR, output_dir: &Path) -> Result<RunResult, RunError> {
    // Check if native FEM backend is available
    let use_native = std::env::var("FULLMAG_FEM_BACKEND")
        .unwrap_or_else(|_| "cpu".into());

    let result = match use_native.as_str() {
        "cuda" | "gpu" => {
            // Phase S4: Native MFEM/libCEED backend
            #[cfg(feature = "native-fem")]
            {
                execute_native_fem(plan)?
            }
            #[cfg(not(feature = "native-fem"))]
            {
                return Err(RunError::BackendUnavailable(
                    "Native FEM backend not compiled. Use FULLMAG_FEM_BACKEND=cpu"
                ));
            }
        }
        "cpu" | _ => {
            // CPU reference engine (S2)
            fullmag_engine::fem::execute_reference_fem(&plan)
                .map_err(RunError::FemEngine)?
        }
    };

    // Write artifacts
    write_fem_artifacts(&result, &plan, output_dir)?;

    Ok(RunResult {
        backend: "fem".into(),
        device: use_native,
        n_steps: result.steps.len(),
        final_time: result.steps.last().map(|s| s.time).unwrap_or(0.0),
        output_dir: output_dir.to_path_buf(),
    })
}
```

---

## 4. Artefakty — format wspólny z FDM

### 4.1 `scalars.csv`

Identyczny format jak FDM:

```csv
step,time,energy_exchange,energy_demag,energy_zeeman,energy_total,avg_mx,avg_my,avg_mz,max_torque
0,0.000000e+00,1.234e-18,5.678e-19,0.000e+00,1.802e-18,0.000,0.000,1.000,5.432e+04
...
```

### 4.2 `fields/step_NNNNNN.json`

FEM dodaje dane siatki do snapshotu:

```json
{
  "step": 0,
  "time": 0.0,
  "backend": "fem",
  "mesh": {
    "n_nodes": 5432,
    "n_elements": 28901,
    "nodes": [x0, y0, z0, x1, y1, z1, ...],
    "elements": [n0, n1, n2, n3, ...]
  },
  "magnetization": {
    "mx": [0.0, 0.0, ...],
    "my": [0.0, 0.0, ...],
    "mz": [1.0, 1.0, ...]
  },
  "effective_field": {
    "hx": [...],
    "hy": [...],
    "hz": [...]
  }
}
```

### 4.3 `metadata.json`

```json
{
  "backend": "fem",
  "device": "cpu",
  "fe_order": 1,
  "n_nodes": 5432,
  "n_elements": 28901,
  "hmax": 5e-9,
  "total_volume": 2e-22,
  "material": {
    "ms": 800000,
    "a_exchange": 1.3e-11,
    "alpha": 0.5
  },
  "energy_terms": ["exchange", "demag", "zeeman"],
  "integrator": "heun",
  "dt": 1e-13,
  "n_steps": 10000,
  "air_box_factor": 3.0,
  "demag_solver": {
    "method": "cg",
    "preconditioner": "none",
    "rtol": 1e-10,
    "max_iter": 5000
  }
}
```

---

## 5. Implementacja zapisu artefaktów

```rust
/// crates/fullmag-runner/src/artifacts.rs (new or extended)

use std::path::Path;
use std::io::Write;

pub fn write_fem_artifacts(
    result: &FemResult,
    plan: &FemPlanIR,
    output_dir: &Path,
) -> Result<(), RunError> {
    std::fs::create_dir_all(output_dir)?;

    // 1. scalars.csv
    write_scalars_csv(result, output_dir)?;

    // 2. Field snapshots
    let fields_dir = output_dir.join("fields");
    std::fs::create_dir_all(&fields_dir)?;

    // Write final state (always)
    write_field_snapshot(
        result, plan,
        result.steps.last().map(|s| s.step).unwrap_or(0),
        &fields_dir,
    )?;

    // 3. metadata.json
    write_metadata_json(plan, result, output_dir)?;

    Ok(())
}

fn write_scalars_csv(result: &FemResult, output_dir: &Path) -> Result<(), RunError> {
    let path = output_dir.join("scalars.csv");
    let mut f = std::fs::File::create(path)?;

    writeln!(f, "step,time,energy_exchange,energy_demag,energy_zeeman,energy_total,avg_mx,avg_my,avg_mz,max_torque")?;

    for s in &result.steps {
        let total = s.energy_exchange + s.energy_demag + s.energy_zeeman;
        writeln!(
            f,
            "{},{:.6e},{:.6e},{:.6e},{:.6e},{:.6e},{:.6f},{:.6f},{:.6f},{:.6e}",
            s.step, s.time,
            s.energy_exchange, s.energy_demag, s.energy_zeeman, total,
            s.avg_mx, s.avg_my, s.avg_mz,
            s.max_torque,
        )?;
    }

    Ok(())
}
```

---

## 6. Python API — `fm.run()` z FEM

### Zmiana w `problem.py`

```python
class Problem:
    def run(self, output_dir: str = "output", backend: str = None):
        """Execute the problem.

        Args:
            output_dir: Directory for output artifacts.
            backend: Override backend ("fdm" or "fem").
                     Auto-detected from discretization if not specified.
        """
        # Determine backend
        if backend is None:
            backend = self._detect_backend()

        # Generate IR
        ir = self.to_ir(backend=backend)

        # If FEM: generate mesh
        if backend == "fem":
            ir = self._attach_mesh(ir)

        # Plan
        plan = _core.plan(ir)

        # Execute
        result = _core.execute(plan, output_dir)

        return result

    def _detect_backend(self) -> str:
        """Auto-detect backend from discretization type."""
        if isinstance(self.discretization, FEM):
            return "fem"
        return "fdm"  # default

    def _attach_mesh(self, ir):
        """Generate mesh and attach to IR for FEM."""
        from fullmag.meshing import generate_box_mesh, generate_cylinder_mesh, validate_mesh

        fem = self.discretization
        geometry = self.shape

        if isinstance(geometry, Box):
            mesh = generate_box_mesh(
                size=(geometry.sx, geometry.sy, geometry.sz),
                hmax=fem.hmax,
                order=fem.order,
                air_factor=3.0 if self._has_demag() else 0.0,
            )
        elif isinstance(geometry, Cylinder):
            mesh = generate_cylinder_mesh(
                radius=geometry.radius,
                height=geometry.height,
                hmax=fem.hmax,
                order=fem.order,
                air_factor=3.0 if self._has_demag() else 0.0,
            )
        else:
            raise ValueError(f"Unsupported geometry for FEM: {type(geometry)}")

        # Validate
        report = validate_mesh(mesh)
        if not report.is_valid:
            raise ValueError(f"Mesh quality check failed: {report.issues}")

        # Attach to IR
        ir.mesh = _core.mesh_data_to_ir(
            mesh.nodes, mesh.elements,
            mesh.node_markers, mesh.element_markers,
            mesh.boundary_faces, mesh.boundary_markers,
        )

        return ir
```

---

## 7. CLI — `fullmag run --backend fem`

### Zmiana w `crates/fullmag-cli/src/main.rs`

```rust
#[derive(clap::Parser)]
struct RunArgs {
    /// Python script to execute.
    script: PathBuf,

    /// Override backend: "fdm" or "fem".
    #[arg(long)]
    backend: Option<String>,

    /// Output directory.
    #[arg(long, default_value = "output")]
    output_dir: PathBuf,
}

fn run(args: RunArgs) -> Result<()> {
    // Load and parse script
    let problem_ir = load_problem_from_script(&args.script)?;

    // Override backend if specified
    let problem_ir = if let Some(ref backend) = args.backend {
        let mut ir = problem_ir;
        ir.backend = match backend.as_str() {
            "fdm" => BackendTarget::Fdm,
            "fem" => BackendTarget::Fem,
            other => return Err(anyhow!("Unknown backend: {}", other)),
        };
        ir
    } else {
        problem_ir
    };

    // Plan
    let plan = fullmag_plan::plan(&problem_ir)?;

    // Execute
    let result = fullmag_runner::execute(plan, &args.output_dir)?;

    println!("Simulation complete:");
    println!("  Backend: {}", result.backend);
    println!("  Device: {}", result.device);
    println!("  Steps: {}", result.n_steps);
    println!("  Output: {}", result.output_dir.display());

    Ok(())
}
```

---

## 8. Capability matrix update

```
docs/specs/capability-matrix-v0.md update:

| Feature          | FDM cpu-ref | FDM CUDA | FEM cpu-ref | FEM GPU |
|------------------|:-----------:|:--------:|:-----------:|:-------:|
| Box geometry     | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| Cylinder         | ⬜          | ⬜       | ✅ S3       | ⬜ S4   |
| Exchange         | ✅          | ✅       | ✅ S2       | ⬜ S4   |
| Demag            | ✅          | ✅       | ✅ S2       | ⬜ S4   |
| Zeeman           | ✅          | ✅       | ✅ S2       | ⬜ S4   |
| LLG Heun         | ✅          | ✅       | ✅ S2       | ⬜ S4   |
| scalars.csv      | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| field snapshots  | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| metadata.json    | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| CLI --backend    | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| Python fm.run()  | ✅          | ✅       | ✅ S3       | ⬜ S4   |
| 3D mesh viewer   | ✅ (voxels) | ✅       | ⬜ S5       | ⬜ S5   |
```

---

## 9. Testy S3

| Test | Opis |
|------|------|
| `test_plan_fem_basic` | `plan()` generuje `ExecutionPlanIR::Fem` z poprawnym mesh |
| `test_plan_fem_missing_hints` | Brak FemHintsIR → `PlanError::MissingFemHints` |
| `test_plan_fem_missing_mesh` | Brak mesh → `PlanError::MissingMesh` |
| `test_plan_fem_unsupported_dmi` | DMI → `PlanError::UnsupportedTerm` |
| `test_execute_fem_cpu` | End-to-end: Box+Exchange → scalars.csv exists |
| `test_execute_fem_scalars_csv_format` | CSV parseable, columns match header |
| `test_execute_fem_field_snapshot` | fields/step_000000.json contains mesh + magnetization |
| `test_execute_fem_metadata` | metadata.json contains backend="fem" |
| `test_cli_fem_backend_flag` | `fullmag run --backend fem` works |
| `test_python_fm_run_fem` | `problem.run(backend="fem")` produces output |

---

## 10. Struktura plików (co nowego tworzy S3)

```
crates/fullmag-plan/src/
    lib.rs              # + plan_fem(), validate_energy_terms_fem()

crates/fullmag-runner/src/
    lib.rs              # + execute_fem()
    artifacts.rs        # + write_fem_artifacts(), write_scalars_csv(), etc.

crates/fullmag-ir/src/
    lib.rs              # + ExecutionPlanIR::Fem variant

crates/fullmag-cli/src/
    main.rs             # + --backend flag

packages/fullmag-py/src/fullmag/model/
    problem.py          # + _attach_mesh(), _detect_backend()
```

---

## 11. Kryteria akceptacji S3

| # | Kryterium |
|---|-----------|
| 1 | `fullmag run script.py --backend fem` produkuje output/ |
| 2 | `scalars.csv` ma ten sam format co FDM |
| 3 | `fields/step_000000.json` zawiera mesh nodes/elements |
| 4 | `metadata.json` zawiera `"backend": "fem"` |
| 5 | `fm.run(backend="fem")` w Pythonie działa end-to-end |
| 6 | Brak FEM hints → czytelny błąd |
| 7 | Unsupported energy term → czytelny błąd z nazwą termu |
