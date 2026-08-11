# Publiczny FDM GPU CurrentTransport Neumanna — plan wdrożenia

> **Dla agentów wykonawczych:** WYMAGANY POD-SKILL: `subagent-driven-development` (zalecany) albo `executing-plans`. Kroki mają pola wyboru i są wykonywane z testem RED przed zmianą implementacji.

**Cel:** Udostępnić jeden, zamknięty publiczny wariant `CurrentTransport(OhmicPoisson)` z gauge `zero_mean` i dwiema zbilansowanymi elektrodami `NormalCurrentElectrode` przez Python, ProblemIR, planner, runner i natywny CUDA ABI.

**Architektura:** Publiczny model i natywny solver nie dostają nowej fizyki. Planner rozszerza istniejący bounded FDM/CUDA/FP64/strict descriptor tylko o kompatybilny wariant Neumanna; adapter runnera mapuje jego gauge i ściany do już istniejącego ABI. Natywny właściciel numeryki pozostaje w `backends/fdm/gpu/cuda/transport/**`; Rust wyłącznie waliduje, materializuje ABI, publikuje pola oraz proweniencję.

**Technologie:** Python DSL, `ProblemIR`, Rust planner/runner, append-only FDM GPU C ABI, CUDA FP64, container-backed `just`, JSON artefakty i dokumentacja MyST/Sphinx.

## Ograniczenia globalne

- Fizyczny problem to $\nabla\cdot(\sigma\nabla V)=0$, $\mathbf J_c=-\sigma\nabla V$ oraz $\mathbf n\cdot\mathbf J_c=J_n$; dodatnie `outward_current_density_apm2` oznacza prąd na zewnątrz komórki.
- Dla każdego wolnego komponentu Neumanna wymagane są $\sum_f |f|J_{n,f}=0$ i $\bar V_C=0$; niezbilansowane elektrody muszą zakończyć się błędem przed publikacją stanu zaakceptowanego.
- Publiczny zakres to dokładnie jeden `OhmicPoisson`, `coupling=one_way`, pełna prostokątna siatka FDM, explicit FDM + CUDA/GPU, FP64 i `execution_mode=strict`; fallback jest zakazany.
- Dopuszczone są dokładnie dwie przeciwległe, jedno-powierzchniowe elektrody dokładnej gęstości prądu na tej samej osi i cztery ściany izolujące. Nie wolno mieszać ich z elektrodami napięciowymi.
- Wykluczone pozostają PBC, częściowe maski, domeny nieprostokątne, spin/SHE/STT/SOT, Oersted, obwiednia czasowa, closure/source-cut, FEM, CPU/auto, single i wszystkie pozostałe warianty transportu.
- `allocator_limit=0` i `workspace_limit=0` zachowują dynamiczną politykę pamięci CUDA zależną od wolnej VRAM i rozmiaru zadania; nie wolno wprowadzać stałego limitu pamięci.
- Natywne buildy i dowód urządzenia wykonuje wyłącznie container-backed recepta `just`; ciężkie artefakty pozostają pod `/zfn2/mateuszz/git/fullmag` przez `/mnt/fullmag-zfn2-native`.
- Nie modyfikować `external_solvers/3` ani nie dodawać implementacji solvera do `dispatch.rs`.
- Dokumentacja opisuje ograniczony stan wykonawczy i nie promuje ogólnej capability `transport.charge.ohmic` do `validated` ani statusu produkcyjnego.

---

### Task 1: Pionowy slice publicznego pure-Neumann FDM GPU

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/current_transport.rs:113-305, 540-575`.
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs:134-305, 350-455, 900-940, 1140-1180, 1419-1505`.
- Modyfikuj: `justfile:637-643`.
- Utwórz: `examples/fdm_gpu_charge_zero_mean_public.py`.
- Utwórz: `scripts/verify_fdm_gpu_public_charge_zero_mean_output.py`.
- Modyfikuj: `docs/physics/0970-spin-hall-drift-diffusion-transport.md:756-870` oraz `.source-map.json`.
- Modyfikuj: `docs/specs/capability-matrix-v0.json`, `docs/specs/spin-transport-runtime-contract-v1.md` i canonical plan przez nowy §32.178.

**Interfejsy:**

- Konsumuje: `ChargePotentialGaugeIR::{DirichletReference,ZeroMean}`, `ChargeBoundaryIR::{VoltageElectrode,NormalCurrentElectrode,Insulating}`, `ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity` oraz istniejący `ResolvedFdmGpuChargeTransportIR`.
- Produkuje: `GpuChargeGauge::ZeroMeanPerFreeComponent`, ABI `FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT`, proweniencję `gauge_policy="zero_mean_per_free_component"` i nową receptę zarządzanego E2E.

- [x] **Krok 1: Zapisać testy RED planera i adaptera**

W `current_transport.rs` zastąpić test odrzucający `bounded_public_fdm_gpu_charge_rejects_zero_mean_current_electrodes` pozytywnym fixturem z `charge.gauge = ChargePotentialGaugeIR::ZeroMean`, x-min `+2.0e13 A/m²`, x-max `-2.0e13 A/m²`. Asercje: jeden deskryptor `charge_gauge == ZeroMean`, dwie warunkowe ściany `OutwardNormalCurrentDensity` i cztery `Insulating`.

Dodaj negatywne przypadki z `fdm_gpu_charge_scope_rejected` i `fallback=none`: identyczny znak na obu elektrodach, elektrody na różnych osiach, mieszanie `VoltageElectrode` i `NormalCurrentElectrode`, oraz `DirichletReference` z elektrodami prądowymi.

W `charge_transport.rs` zastąpić test odrzucający zero-mean testem akceptacji poprawnego wejścia z `ExactCurrentDensity`, potem dodać odrzucenie niezbilansowanego strumienia, mieszanych napięciowych/prądowych ścian i gauge niezgodnego z rodzajem elektrod. Mock ABI musi wykazać:

```rust
assert_eq!(
    abi.solve_request.expect("solve request").gauge_policy,
    ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_ZERO_MEAN_PER_FREE_COMPONENT,
);
```

- [x] **Krok 2: Uruchomić RED**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-gpu-public-neumann-plan CARGO_INCREMENTAL=0 cargo test -p fullmag-plan --lib current_transport::tests::materializes_bounded_public_fdm_gpu_zero_mean_charge_plan -- --exact
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-gpu-public-neumann-runner CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --lib fdm::gpu::cuda::charge_transport::tests::bounded_public_zero_mean_contract_uses_zero_mean_ffi_policy -- --exact
```

Oczekiwany wynik przed implementacją: pierwszy test kończy się `charge_gauge=ZeroMean`, drugi błędem boundary-reference; żaden test nie wywołuje prawdziwego CUDA ABI.

- [x] **Krok 3: Zaimplementować minimalne rozszerzenie planera**

W `resolve_fdm_gpu_charge_transports` rozdziel dwa wzajemnie wykluczające się profile:

```rust
let voltage_profile = charge.gauge == ChargePotentialGaugeIR::DirichletReference
    && two_single_surface_voltage_electrodes
    && no_normal_current_electrodes;
let neumann_profile = charge.gauge == ChargePotentialGaugeIR::ZeroMean
    && two_opposite_single_surface_current_electrodes_same_axis
    && no_voltage_electrodes
    && equal_and_opposite_area_weighted_flux;
if !(voltage_profile || neumann_profile) {
    scope_reasons.push("boundary_contract=...".into());
}
```

Porównanie bilansu ma używać pola powierzchni obliczanego z `context.cell_size` i tolerancji skali, nie dokładnego porównania `f64`. Zachowaj całą dotychczasową fail-closed politykę device/precision/mode/maski/modułów.

- [x] **Krok 4: Zaimplementować mapowanie runnera i walidację ABI**

W `input_from_resolved` mapuj `DirichletReference` na `BoundaryReferencePerComponent`, a `ZeroMean` na `ZeroMeanPerFreeComponent`; odrzuć każdy descriptor niezgodny z BC. `validate_boundary_faces` ma dopuszczać wyłącznie:

```text
DirichletReference: 2 voltage source IDs + insulating
ZeroMeanPerFreeComponent: 2 ExactCurrentDensity source IDs + insulating,
area-weighted outward flux sum ~= 0
```

Przekaż `input.gauge` do `solve_request.gauge_policy`, zachowaj lifecycle ABI oraz publikuj zależną od wejścia wartość `gauge_policy` w `ChargeTransportExecutionProvenance`.

- [x] **Krok 5: Dodać fixture, verifier i receptę**

Nowy przykład ma pręt `2 x 1 x 1`: wymiary `20 x 10 x 10 nm`, komórki `10 x 10 x 10 nm`, `sigma=4e6 S/m`, x-min `+2e13 A/m²`, x-max `-2e13 A/m²`, reszta `Insulating`, `zero_mean`, FDM/GPU/FP64/strict, `study.exchange()` i demag wyłączony.

Verifier sprawdza:

```text
execution_engine == cuda_fdm_charge_only
fallbacks_triggered == []
gauge_policy == zero_mean_per_free_component
mean(V_electric) == 0
V_electric == [-0.025, +0.025] V
J_charge.x == [-2e13, -2e13] A/m²
J_charge.y == J_charge.z == 0
physical_residual, component_balance, electrode_balance < 1e-12
```

Korekta znaku została potwierdzona z `gpu_m1_charge_uniform_v1_contract.cpp`:
autorska wielkość to $J_n=\mathbf n\cdot\mathbf J_c$, dlatego dodatnie
$J_n$ na `x_min` i ujemne na `x_max` dają ujemny, jednokierunkowy $J_x$ w
rosnącym porządku komórek.

Skopiuj strukturę `verify-fdm-gpu-public-charge-runtime` do `verify-fdm-gpu-public-charge-zero-mean-runtime`, ale użyj `/mnt/fullmag-zfn2-native/fdm-gpu-public-charge-zero-mean`, nowego przykładu i verifiera. To jest jedyny końcowy dowód CUDA; host build nie wystarcza.

- [x] **Krok 6: Uruchomić GREEN i dowód urządzenia**

```bash
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-gpu-public-neumann-plan CARGO_INCREMENTAL=0 cargo test -p fullmag-plan --lib current_transport::tests -- --nocapture
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fdm-gpu-public-neumann-runner CARGO_INCREMENTAL=0 cargo test -p fullmag-runner --lib fdm::gpu::cuda::charge_transport::tests -- --nocapture
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs scripts.test_fdm_gpu_m1_charge_scalability_contract
just verify-fdm-gpu-public-charge-zero-mean-runtime
```

Wymagany wynik: testy Rust/Python przechodzą, `just` kończy się kodem 0 na realnym CUDA. Zapisz UUID, runtime, driver, build digest, wynik fixture i residuale z faktycznie utworzonego `metadata.json`.

- [x] **Krok 7: Zaktualizować dokumentację i commit**

Najpierw uzupełnij §7.3 noty fizycznej o publiczną granicę zero-mean i tabelę faktycznego E2E; source map wskazuje planner, adapter, fixture, verifier i receptę `just`. Dodaj §32.178, zaktualizuj bounded capability row i runtime contract. Ogólny wiersz capability pozostaje `semantic_only`, `validation_state=unvalidated`, `validated_workloads=[]`.

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
git diff --check
git diff --cached --name-only
git commit -m "feat(fdm): expose bounded GPU zero-mean charge transport"
```

Przed commitem osobne `git diff --cached --name-only` może zawierać wyłącznie pliki taska; nie stage'ować `external_solvers/3`.

## Autokontrola planu

- Pokrycie: kontrakt fizyczny, publiczne obniżenie, planner, adapter ABI, pola/provenance, E2E, dokumentacja i capability są przypisane do Task 1.
- Granica: nie ma nowej fizyki spinowej, FEM, maski częściowej ani promotion ogólnej capability.
- TDD: RED i GREEN obejmują planner, runner, kontrakty dokumentacji i urządzenie CUDA.
