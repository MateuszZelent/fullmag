# cuDSS direct Poisson solve: relaxation check against CG/AMG, fullmag FDM and MuMax3

Date: 2026-11-24. Build: this branch at `83376a9b6` (PR #550), Docker DEV backend, RTX 5050 8 GB under WSL2.
One GPU job at a time. Data: `~/git/simulations/fullmag/cudss-validation-film-300x300x5/` on the test host.

## 1. Question and case

Does the opt-in cuDSS direct solve (`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss`) change simulation results?

The case is a zero-field relaxation of a permalloy film:
- size 300 × 300 × 5 nm;
- Ms = 800 kA/m, A = 13 pJ/m, α = 0.02;
- initial m = (1, 0.1, 0)/|·|.

It runs in three codes:

| Code | Discretization | Relaxation |
|---|---|---|
| MuMax3 3.12 (fork `MateuszZelent/3`, float32) | 120 × 120 × 2 cells of 2.5 nm | `Relax()` |
| fullmag FDM GPU, double | same grid | projected-gradient Barzilai–Borwein (PGBB), tolT 1e-7 T |
| fullmag FEM GPU, double | see §4 | PGBB, tolT 1e-7 T, Poisson–Robin demag |

FEM runs with cuDSS and with CG/AMG (rtol 1e-12, 600 iterations) on the same mesh. The case script is `scripts/benchmarks/relax_film_compare_case.py`. The MuMax3 input is the case above with `SetGridSize(120,120,2)`, `SetCellSize(2.5e-9,2.5e-9,2.5e-9)`, `Relax()`.

## 2. cuDSS against CG/AMG (same mesh, same algorithm)

### Final relaxed states

Mesh: one-layer prism film mesh (§4), 36 576 nodes.

| Solver | Steps | ⟨mx⟩ | ⟨my⟩ | E_ex [J] | E_demag [J] | E_total [J] | Max torque [T] |
|---|---|---|---|---|---|---|---|
| cuDSS | 4 718 | 0.7529544 | 0.5940495 | 2.713722e-19 | 2.2365856e-18 | 2.507957770e-18 | 1.0e-7 |
| CG/AMG | 4 321 | 0.7529540 | 0.5940501 | 2.713719e-19 | 2.2365858e-18 | 2.507957770e-18 | 9.4e-8 |
| Relative difference | — | 5.2e-7 | 9.6e-7 | 8.4e-7 | 1.0e-7 | 5.9e-12 | — |

Both solvers reach the same minimum. The remaining differences are at the level set by the torque tolerance.

### Step-by-step trajectories

Relative differences between the AMG and cuDSS runs, step by step:

| Mesh | Steps 0–20 | Step 50 | Step 100 | Step 150 | Step 200 |
|---|---|---|---|---|---|
| Tetrahedral P2, 4 082 076 unknowns | E ≤ 1.5e-14, m ≤ 8e-16 | 1e-10 | 5e-6 | 8e-3 (my) | — |
| Prism P1, 36 576 unknowns | ≤ 2e-13 | 5e-9 | 2e-4 | 1.5e-2 (my) | 0.13 (my) |

The difference grows about 10× every 5–8 steps. In the tetrahedral run the maximum torque jumps between 0.04 and 22 T from step to step.

Interpretation (hypothesis): PGBB step selection amplifies round-off-level differences in H_demag. AMG stops at rtol 1e-12; the direct solve is exact to round-off. The converged states above agree, so the divergence comes from the iteration path, not from a different solution.

## 3. fullmag FDM against MuMax3

### Uniform state

The exact value for a uniformly magnetized prism comes from the analytic demagnetizing factors (Aharoni 1998): N_x = N_y = 0.02560212, N_z = 0.94879577. This gives E_demag = 4.632850e-18 J.

| Code | E_demag [J] | Relative to exact |
|---|---|---|
| fullmag FDM | 4.632850e-18 | −6e-9 |
| MuMax3, `DemagAccuracy` 6 (default) | 4.610057e-18 | −0.49 % |
| MuMax3, `DemagAccuracy` 8 / 10 / 12 | 4.617727 / 4.621442 / 4.624705e-18 | −0.33 / −0.25 / −0.18 % |
| fullmag FEM, tetrahedral P2 | 4.603813e-18 | −0.63 % |
| fullmag FEM, prism P1 | 3.237685e-18 | −30.1 % |

Note on fullmag FDM: the step-0 table row reports the unnormalized initial vector (1, 0.1, 0), so its energy is ×1.01. The FDM value above is normalized.

### Same non-uniform state in both codes

States were exchanged as OVF.

| State | Quantity | MuMax3 (acc 6) | MuMax3 (acc 12) | fullmag FDM |
|---|---|---|---|---|
| MuMax3 relaxed state | E_exch [J] | 3.964237e-19 | — | 3.964237e-19 (rel. diff 7e-8) |
| MuMax3 relaxed state | E_demag [J] | 2.691144e-18 | — | 2.713708e-18 (MuMax3 −0.83 %) |
| MuMax3 relaxed state | Max torque [T] | 5.2e-5 | — | 2.4e-4 |
| fullmag relaxed state | E_exch [J] | 3.895426e-19 | 3.895426e-19 | 3.895426e-19 |
| fullmag relaxed state | E_demag [J] | 2.697815e-18 (−0.83 %) | 2.712516e-18 (−0.29 %) | 2.720379e-18 |
| fullmag relaxed state | Max torque [T] | 2.3e-4 | 1.2e-4 | 9.5e-8 |

Exchange agrees to float32 precision. The E_total gap of 0.7 % between the codes is the MuMax3 demag-kernel accuracy for this thin film. It shrinks as `DemagAccuracy` grows.

### Relaxed states

| Run | Start | Steps | ⟨mx⟩ | ⟨my⟩ | E_total [J] | Max torque [T] |
|---|---|---|---|---|---|---|
| MuMax3 `Relax()`, 3 runs | uniform | 44 406 (run 3) | 0.7078–0.7093 | 0.6299–0.6318 | 3.08757–3.08760e-18 | 5.2–5.7e-5 |
| MuMax3 `Relax()` | fullmag final state | 246 | 0.671868 | 0.671544 | 3.087358e-18 | 2.6e-6 |
| fullmag FDM | uniform | 17 073 | 0.671866 | 0.671542 | 3.10992129e-18 | 9.5e-8 |
| fullmag FDM | MuMax3 final state | 14 281 | 0.671865 | 0.671544 | 3.10992129e-18 | 9.4e-8 |

The relaxed film has a soft mode: the average magnetization slowly rotates towards the diagonal while the energy hardly changes.
- fullmag passed through ⟨m⟩ = (0.7047, 0.6355) at 5.7e-5 T (step 1 241). It then needed 19 000 more steps to reach the diagonal, and the energy changed by only 5e-5 relative.
- MuMax3 `Relax()` stops inside this drift at about 5e-5 T, at a different point in each run (⟨mx⟩ 0.7078–0.7093).
- Started from the fullmag state, MuMax3 stays there. In MuMax3's own energy, that state is 2e-22 J lower than its own `Relax()` result.
- Both fullmag starts end in the same minimum: E_total equal to 1e-11.

## 4. FEM meshes and their limits (not related to cuDSS)

| Mesh | Size | Relaxation | Uniform E_demag |
|---|---|---|---|
| `film.mesh(maximum_element_size=2.5e-9)`, tetrahedral | 487 736 nodes (film 34 597, airbox 487 569), 3.1 M tetrahedra, P2 potential with 4 082 076 unknowns | too slow (§5) | −0.63 % |
| `film.mesh.thin_film(..., layers=1, topology="prismatic")` as in the SP4 scenario, 2.5 nm in plane | 36 576 nodes, 123 796 cells | completes | −30.1 % |

On the prism mesh the backend resolves the documented mixed-P1 potential (notes 0431 and 0980). The relaxed FEM state therefore differs from FDM: E_total is 19 % lower and ⟨m⟩ = (0.753, 0.594).

## 5. Run times

Wall times on the same machine, one GPU job at a time.

| Run | Unknowns in the demag solve | Steps | Setup | Relaxation stage | Mean per step | Whole run |
|---|---|---|---|---|---|---|
| MuMax3 `Relax()`, float32 | FFT, 28 800 cells | 44 406 | — | — | 1.5 ms (with start-up) | 68.8 s |
| fullmag FDM PGBB, from uniform | FFT, 28 800 cells | 17 073 | ~3 s | 131.6 s | 7.7 ms | 134.7 s |
| fullmag FDM PGBB, from MuMax3 state | FFT, 28 800 cells | 14 281 | ~6 s | 114.1 s | 8.0 ms | 119.8 s |
| FEM prism P1, cuDSS | 36 576 | 4 718 | ~18 s, including analysis 0.8 s and factorization 0.2 s | 43.0 s | 7.4 ms | 61.0 s |
| FEM prism P1, CG/AMG | 36 576 | 4 321 | ~18 s | 929.9 s | 213.4 ms | 947.9 s |
| FEM tetrahedral P2, cuDSS | 4 082 076 | 170, then killed | meshing 123 s, analysis 100.5 s, factorization 1 595.6 s | — | ~7.6 s | > 3 600 s |
| FEM tetrahedral P2, CG/AMG | 4 082 076 | 423, then killed | ~240 s | — | ~7.6 s | > 3 600 s |

Notes:
- **FDM step time** is the stage time divided by the number of steps. The device-resident PGBB loop reports no per-step callbacks.
- **Prism mesh:** cuDSS is 29× faster per step, 22× per relaxation stage and 16× per whole run. The factor has 3.03e6 nonzeros and needs 80 MB of VRAM.
- **Tetrahedral mesh:** the factor has 7.43e9 nonzeros, about 59 GB in double precision. It does not fit in 8 GB of VRAM, and the WDDM driver silently pages it to host memory. A step then takes as long as with AMG. This supports the VRAM preflight and the AMG fallback already listed as open points for this PR.

## 6. Other fullmag findings during this check (not fixed here)

1. **Strict FDM GPU, final receipt.** A PGBB relaxation that converges normally then fails the final receipt check:
   `strict FDM GPU final execution is not fully device-proven: executed=unknown required=0xa7 executed_device=0xa6 executed_unknown=0x1`.
   The same run in `study.mode("extended")` completes with an identical step count.
2. **FDM PGBB at the SP4 tolerance.** With tolT = 5.8349e-9 T, FDM PGBB reaches 3.8e-8 T and then stops with `failed Armijo line search after 20 backtracks`. The energy decrease it needs is far below double resolution (E ≈ 3.1e-18 J). The run ends with an error instead of reporting convergence at the precision floor.
3. **Two-layer prism mesh.** `thin_film(layers=2, topology="prismatic")` (2.5 nm) fails the mixed shared-domain conformity check for this film: 6 nonconforming tet4 faces near the film edge. `layers=1` works.
4. **Zarr input.** `m.loadfile(..., format="zarr")` could not read the MuMax3 Zarr layout `[t,z,y,x,c]`, so states were exchanged as OVF. A fix is on a separate local branch, not in this PR.
5. **WSL GPU hangs.** The GPU driver (dxg) hung twice during long FEM runs. In both cases the measuring probe was polling `nvidia-smi` every 0.2 s. With polling every 5 s the rerun completed. The probe's role is a hypothesis.

## 7. Reproduce

```sh
# inside the DEV backend container, from /opt/fullmag/source
P="python3 scripts/benchmarks/run_memory_transfer_probe.py --output /build/film --keep --sample-interval 5 --timeout 5400 --case-script scripts/benchmarks/relax_film_compare_case.py"
$P --backend fdm --env FILM_ENGINE=fdm --env FILM_TOLT=1e-7 --env FILM_MODE=extended --label fdm
$P --backend fem --env FILM_ENGINE=fem --env FILM_FEM_LAYERS=1 --env FILM_TOLT=1e-7 --env FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss --label fem_cudss
$P --backend fem --env FILM_ENGINE=fem --env FILM_FEM_LAYERS=1 --env FILM_TOLT=1e-7 --label fem_amg
# FDM start from a MuMax3 state: --env FILM_INIT_M=<state.ovf>
```
