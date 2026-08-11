# FDM multilayer — P0 containment i preflight pamięci

> **Dla agentów implementujących:** WYMAGANA UMIEJĘTNOŚĆ: użyj
> `subagent-driven-development` i realizuj zadania kolejno, z osobnym review po
> każdym zadaniu.

**Cel:** Usunąć możliwość wykonania niekanonicznego operatora CUDA multilayer,
naprawić niedoszacowanie pamięci ABI v2 oraz odrzucać semantykę `boundary_*`,
której plan multilayer nie potrafi zachować.

**Architektura:** Planner i runner używają jednego kontraktu containment oraz
jednego checked modelu kosztu par. Pierwszy inkrement pozostaje konserwatywny:
ABI v2 jest budżetowane według pełnych `L²` uporządkowanych par, bez deklarowania
niezaimplementowanego reuse. Nie zmieniamy równań ani operatora CPU.

**Technologie:** Rust, Fullmag ProblemIR/planner/runner, CUDA ABI v2, MyST i
source-map JSON.

## Globalne ograniczenia

- Jawny `multilayer_convolution` nie może zostać zreinterpretowany jako natywny single-grid.
- Niekanoniczne CUDA-assisted musi zakończyć się przed sondą urządzenia, alokacją i FFI.
- CPU FP64 zachowuje obecny zakres `two_d_stack`, heterogenicznego `h_z` i `push_pull`.
- Dozwolony CUDA multilayer w tym inkremencie to wyłącznie `three_d + identity` z ważnym certyfikatem.
- `estimated_unique_kernels` pozostaje telemetrią; admission ABI v2 używa kosztu `L²`.
- Wszystkie rozmiary i koszty używają checked arithmetic, bez zwężających `as`.
- Brak cichego fallbacku urządzenia, strategii, transferu lub semantyki boundary.
- Testy powstają RED przed implementacją i GREEN po minimalnej zmianie.

---

### Task 1: Fail-closed CUDA multilayer containment

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Modyfikuj: `crates/fullmag-plan/src/lib.rs`
- Testuj: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`

**Interfejsy:**

- Produkuje współdzielony helper zwracający stabilne reason codes dla
  `two_d_stack`, `push_pull`, heterogenicznego native `h_z` i XY offsetu.
- Runner używa helpera jako defense-in-depth dla planów historycznych i
  deserializowanych.

- [ ] Napisać RED testy planera dla czterech niekwalifikowanych klas CUDA i kontroli CPU.
- [ ] Napisać RED testy runnera potwierdzające odrzucenie przed CUDA probe/alokacją.
- [ ] Zaimplementować wspólny helper i plannerowy fail-close dla forced CUDA.
- [ ] Zabronić native-stacked single-grid fast path dla jawnego `multilayer_convolution`.
- [ ] Zachować `three_d + identity` oraz auto-strategy fast path w dotychczas legalnym zakresie.
- [ ] Uruchomić focused plan/runner tests, formatowanie i diff check.
- [ ] Commit i osobny review zgodności/spec jakości.

### Task 2: Konserwatywny, checked preflight pamięci ABI v2

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Modyfikuj: `crates/fullmag-plan/src/lib.rs`
- Testuj: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/mod.rs`
- Testuj: właściwy moduł testowy runnera

**Interfejsy:**

- Produkuje `checked_multilayer_pair_kernel_footprint(common_cells, layer_count)`
  zwracający pełny koszt hostowego tensor payload ABI v2.
- Planner zapisuje ten koszt w `estimated_kernel_bytes`; runner oblicza go tym
  samym helperem i odrzuca stale lub sfałszowane summary.

- [ ] Napisać RED test dokładnego kosztu `L=3`, `common=[4,5,6]`: `829440` B.
- [ ] Napisać RED test progu, gdzie shift-only przechodzi, lecz `L²` przekracza 8 GiB.
- [ ] Napisać RED test `L² > u32::MAX` i overflow padded cells/bytes.
- [ ] Zaimplementować helper wyłącznie z `try_from` i `checked_mul`.
- [ ] Zastąpić shift-only admission w plannerze i runnerze kosztem ABI v2 `L²`.
- [ ] Zachować unique-shift count tylko jako jawną telemetrię, bez twierdzenia o alokacji.
- [ ] Uruchomić focused plan/runner tests, formatowanie i diff check.
- [ ] Commit i osobny review zgodności/spec jakości.

### Task 3: Fail-closed `boundary_*` dla multilayer

**Pliki:**

- Modyfikuj: `crates/fullmag-plan/src/fdm.rs`
- Testuj: `crates/fullmag-plan/src/tests.rs`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`
- Modyfikuj: `docs/specs/capability-matrix-v0.md`

**Interfejsy:**

- Neutralny intent to dokładnie `boundary_correction in {None, "none"}` oraz
  oba parametry tuningowe równe `None`.
- Każdy jawny `boundary_phi_floor` lub `boundary_delta_min`, także `0.0`, jest
  odrzucany, ponieważ plan nie ma pola pozwalającego zachować tę intencję.

- [ ] Napisać RED testy neutralnego i każdego nie-neutralnego wariantu.
- [ ] Dodać jedną plannerową walidację przed budową warstw.
- [ ] Zaktualizować notę, source map i capability matrix bez deklarowania runtime proof.
- [ ] Uruchomić testy planera i walidator dokumentacji.
- [ ] Commit i osobny review zgodności/spec jakości.

## Końcowa brama tej fali

- Wszystkie trzy task reviews są zatwierdzone bez Critical/Important.
- Pełne focused suite planera i runnera przechodzą.
- Scientific-doc validator i `git diff --check` przechodzą.
- Managed CUDA runtime nie jest promowany do production-qualified; ten inkrement
  dowodzi containment i preflight, nie device parity.
