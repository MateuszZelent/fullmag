# Eksperyment paczek PCG FEM GPU — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Zmierzyć na tym samym SP4, czy stride 4 zmniejsza czas względem 8.

**Architecture:** Opcjonalny zamknięty metadata → typed FemPlanIR → addytywny
setter natywnego Context. Niezależne surowe liczniki Context są odczytywane
raz na końcu; obecna domyślna polityka i certyfikat pozostają niezmienione.

**Tech Stack:** Python DSL, Rust/serde, C ABI, C++/CUDA, MFEM/HYPRE.

**Spec:** `docs/physics/0914-fem-gpu-pcg-control-experiment.md`, ADR 0082.

## Ograniczenia

- Istniejący worktree i grupa `fullmag-worktree-fullmag-a8342df1f0247d61`.
- Build i natywne testy wyłącznie w zarządzanym backendzie tej grupy.
- Zachować cztery cudze dirty pliki, sesje, środowiska i wszystkie Zarr.
- Brak zmiany fizyki, tolerancji, certyfikatu i fallbacku na CPU.
- Nowych prywatnych wyników nie publikować na GitHub bez konkretnej zgody.

## Review Focus

- Null/nieznane klucze/float/bool/stride poza 4,8: błąd przed wykonaniem.
- CPU/FDM/FEM-BEM/eigensolve/PBC: odrzucenie eksperymentu.
- Próba solve zakończona błędem i reset workspace: setter nadal zablokowany.
- Domyślny stary plan: serializacja i pierwsze 5/następne 8 bez zmian.
- Terminalne raw countery obejmują failed/rejected, nie udają wykonanych kerneli.

## Zadanie 1 — native Context i kontrakty (właściciel: bounded worker)

Pliki: `native/include/fullmag_fem.h`, `backends/fem/include/context.hpp`,
`gpu/cuda/demag_poisson/{control_state.hpp,pcg_device_scalar_kernels.hpp,hypre_device_solver.cpp,hypre_device_solver.hpp}`,
`backends/fem/src/api.cpp`, właściwe natywne fixture/testy Poissona.

Interfejsy:
- `fullmag_fem_gpu_pcg_control_config_v1`: u32 abi_version=1, struct_size=16,
  status_batch_stride=4|8, reserved=0.
- `fullmag_fem_backend_set_gpu_pcg_control_v1(handle, const config*)`.
- `fullmag_fem_gpu_pcg_control_info_v1`: u32 abi_version=1, struct_size=64,
  requested_status_batch_stride (0 gdy brak), resolved_status_batch_stride;
  u64 solve_attempts, enqueued_iterations, amg_apply_calls,
  hot_loop_solve_attempts, hot_loop_enqueued_iterations, hot_loop_amg_apply_calls.
- `fullmag_fem_backend_get_gpu_pcg_control_info_v1(handle, info*)`.

- [ ] Test obu stride i błędnych konfiguracji/zmiany po solve.
- [ ] Implementacja stanu Context i zliczania przy faktycznym zleceniu API.
- [ ] Managed native gate obu wariantów, w tym warm/zero/nonfinite/failure.

## Zadanie 2 — lowering i provenance (właściciel: root)

Pliki: `fullmag-ir/src/plan.rs`, `fullmag-plan/src/{lib.rs,fem.rs,pcg_control_experiment.rs}`,
`fullmag-fem-sys/src/lib.rs`, `fullmag-runner/src/{native_fem.rs,native_fem/runtime_info.rs,types.rs,fem/relax/finalize.rs}`,
odpowiednie testy, dokumentacja i source-map.

- [ ] Typed optional `FemGpuPcgControlExperimentIR` i zamknięta walidacja metadata.
- [ ] Test poprawnego round-trip, braku zmiany starego planu i nielegalnych lane.
- [ ] Wywołanie settera przed pierwszym obliczeniem; obrona przed błędnym planem.
- [ ] FFI layout 16/64 B i terminalny `fem_gpu_pcg_control_experiment` provenance.
- [ ] Adekwatne managed testy Rust/Python i walidator dokumentacji.
- [ ] Review wspólnego diff, dokładny staging i commit zweryfikowanego fragmentu.

## Zadanie 3 — ten sam SP4 i integracja

- [ ] Recheck idle/drain grupy i chronionych zmian; managed rebuild z profilem E:.
- [ ] Krótkie przeplatane RK45 8/4 z identycznym wejściem i pełnym Zarr.
- [ ] Porównać każdą energię, pola, torque, residuum i aktywne/zlecone iteracje.
- [ ] Zmierzyć wall time, synchronizacje i liczniki; wynik może być regresją.
- [ ] Aktualizować prywatny checkpoint; kontynuować pełne A/B czterech solverów.
- [ ] Wymagane review/CI/PR/master i kwalifikowany cleanup po spełnieniu pełnych bramek.

## Odblokowanie pomiaru — limit eksportu konfiguracji

Odczytowa diagnoza tego samego wejścia wykazała, że pełny eksport konfiguracji
z rozwiniętą siatką przekracza limit odpowiedzi inwentarza. Nie zmieniamy siatki
ani wymagań przyjęcia. Istniejący kontrakt ADR 0036 przewiduje 16 MiB dla
metadanych pipeline; limit 8 MiB nadal obowiązuje dla inwentarza i eksportu
samej sceny oraz dla źródeł użytkownika.

Właściciel bounded worker: wyłącznie `crates/fullmag-application/src/script_source_capture.rs`.
Root: niniejszy plan, doprecyzowanie ADR 0036, review, zarządzany rebuild i pomiar.

- [ ] Oddzielić 16 MiB pełnej konfiguracji od 8 MiB inwentarza/sceny.
- [ ] Przekazać właściwy limit do helpera i niezależnie sprawdzić jego odpowiedź.
- [ ] Zachować limity stderr, plików, runtime, rekordów i wszystkie kontrole SHA/path/postimage.
- [ ] Regression check rzeczywistego capture: konfiguracja 8–16 MiB przyjęta;
      przekroczenia inwentarza/sceny 8 MiB i konfiguracji 16 MiB odrzucone.
- [ ] Ponowić przygotowanie jako nową jawną próbę dopiero po terminalnym błędzie
      poprzedniej i nowym zarządzanym buildzie; nie odtwarzać niepewnego Solve.
