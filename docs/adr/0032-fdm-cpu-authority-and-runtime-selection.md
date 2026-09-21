# ADR 0032: bieżąca własność FDM CPU i wybór runtime'u

- Status: accepted for this P0-D implementation (scoped current authority)
- Data: 2026-09-20
- Decydent: autoryzacja użytkownika dla P0-D; implementacja agenta
- Zakres: aktualna ścieżka FDM CPU, FDM GPU i provenance wyboru silnika
- Powiązane: `docs/architecture/backend-golden-masterplan.md`,
  `docs/adr/0028-fdm-cuda-precision-policy.md`,
  `docs/specs/capability-matrix-v0.json`

## Kontekst

Dokumentacja backendu zawiera dwa różne opisy własności FDM CPU. Instrukcje
backendu nazywają Rustową realizację CPU produkcyjną, a masterplan opisuje
`backends/fdm` jako docelowy kompilowany backend produkcyjny i Rust jako
reference. Bieżący kod rozstrzyga tylko część tego sporu: publiczny wybór
`FdmEngine` ma warianty `CpuReference` i `CudaFdm`
(`crates/fullmag-runner/src/solver_runtime/engine.rs::FdmEngine`), a dispatch
wykonania kieruje CPU do `cpu_reference` i GPU do CUDA
(`crates/fullmag-runner/src/solvers/fdm/execute.rs::execute_fdm`). Nie istnieje
gotowy, jawnie wybrany wariant natywnego skompilowanego FDM CPU zastępujący
`CpuReference`.

Nazwa katalogu `backends/fdm` oraz obecność natywnych bibliotek nie są dowodem,
że każda rodzina FDM, w szczególności pełny CPU LLG, jest już wystawiona przez
planner i runner. Zmiana etykiety albo przeniesienie wrappera nie może zmienić
ownerstwa numeryki bez osobnej kwalifikacji.

## Decyzja

### 1. Bieżące realizacje pozostają bez relokacji

W bieżącym kontrakcie:

| Publiczna intencja | Bieżąca realizacja | Znaczenie |
|---|---|---|
| `device=cpu` / legalne `auto -> cpu` | `FdmEngine::CpuReference` | Obecna CPU/reference execution route i zaufany oracle. |
| `device=gpu` | `FdmEngine::CudaFdm` | Natywna kompilowana ścieżka FDM GPU, z wymaganym runtime'em CUDA. |
| wymuszony GPU bez wymagań | brak realizacji | Jawny błąd; nie wolno przełączyć na CPU. |

`CpuReference` zachowuje bieżące zachowanie, parametry, artefakty i
provenance. Nie tworzymy teraz `NativeCpu` przez rename, wrapper ani zmianę
tekstu w capability matrix. `backends/fdm` pozostaje strategicznym właścicielem
kompilowanego FDM i miejscem przyszłej realizacji CPU, ale sam katalog nie
promuje aktualnej ścieżki Rust do native CPU production.

### 2. Requested, resolved i executed są odrębne

Planner i runner zachowują osobno:

- requested device/engine i execution mode;
- resolved engine (`CpuReference` albo `CudaFdm`);
- executed engine/runtime identity;
- fallback reason, wyłącznie gdy publiczny tryb na niego pozwala.

`auto` może rozwiązać się do dostępnej legalnej realizacji, lecz `auto` nie
znika z provenance. Jawne `gpu` nie może rozwiązać się do `CpuReference`.
Jawne `cpu` nie jest cicho przepisywane na przyszły native CPU, dopóki taki
engine nie ma własnego capability, ABI i dowodów.

### 3. Status capability nie jest kwalifikacją fizyki

`fdm_cpu_reference` i `fdm_gpu_production` pozostają odrębnymi lane'ami
macierzy. Status `implemented`, `reference_executable` albo
`production_executable` opisuje tylko zakres wpisu i nie zastępuje runtime
receipt, parity ani physics validation. Nowy status dla natywnego FDM CPU
może powstać dopiero razem z konkretnym engine identity, planner legality,
provenance, managed/runtime proof i workload-scoped qualification.

### 4. Zakaz ukrytej zmiany ownerstwa

Refaktor `crates/fullmag-engine`, `crates/fullmag-runner`, `backends/fdm` lub
sys bindings musi zachować ten ADR albo wprowadzić nowy, jawnie zatwierdzony
ADR. W szczególności:

- runner pozostaje właścicielem wyboru, ABI, artefaktów i provenance;
- hot loop i natywne CUDA pozostają w `backends/fdm`;
- Rust CPU pozostaje jawnie nazwany reference/current CPU route;
- cross-discretization i cross-engine state transfer są jawne i walidowane;
- żaden forced GPU path nie otrzymuje CPU fallbacku.

## Konsekwencje

- P0-D może zamknąć konflikt dokumentów bez ryzykownej migracji solvera.
- Plan backendowej modularizacji może równolegle porządkować `backends/fdm`,
  ale nie może udawać, że native CPU FDM już istnieje.
- Capability/API/UI muszą pokazywać `CpuReference` jako obecną realizację CPU,
  a nie wyprowadzać ownerstwa z nazwy katalogu.
- Przyszły native FDM CPU wymaga osobnego scoped ADR albo aktualizacji tego
  ADR, z mapą ABI i planem rollbacku.

## Obowiązki implementacyjne

1. Utrzymać mapping `CpuReference`/`CudaFdm` w plannerze, runnerze, CLI,
   artefaktach i statusie API.
2. Dodać source/contract guard, który wykryje ciche zastąpienie
   `CpuReference` innym engine albo GPU-to-CPU fallback.
3. Dla każdej nowej funkcji FDM wskazać osobno source presence, executability,
   runtime evidence, physics validation i production qualification.
4. Przy przyszłym native CPU zdefiniować engine identity, ABI, requested /
   resolved / executed provenance, parity z `CpuReference`, rollback i
   workload-scoped receipt przed zmianą capability.

## Migracja i rollback

Migracja pozostaje strangler migration. Najpierw można wydzielać kontrakty,
state/workspace, interakcje, demag, integratory i workflow bez zmiany bieżącego
dispatchu. Jeśli nowy native CPU nie przejdzie dowodu, capability pozostaje
przy `CpuReference`, a zmiana implementacyjna jest wyłączana bez usuwania
reference route.

## Walidacja

Ten ADR jest decyzją dokumentacyjną; nie oznacza wykonania runtime'u. Zależna
kwalifikacja musi osobno dowieść:

- legalnego planner dispatchu dla CPU i GPU;
- zgodności requested/resolved/executed oraz braku forced-GPU fallbacku;
- CPU/reference i GPU parity dla zdefiniowanych workloadów;
- source-bound managed receipt, artefaktów, energii, pól i zbieżności.
