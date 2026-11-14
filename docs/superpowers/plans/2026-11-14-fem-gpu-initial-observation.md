# FEM GPU — początkowe obserwacje i pomiar przygotowania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** usunąć powtórną fizyczną ewaluację CPU przed FEM GPU, zachowując początkowe obserwacje, fizykę i artefakty.

**Architektura:** pomiary per-process zapisuje istniejący supervisor w exit receipt; początkowe pola pobiera istniejący worker GPU z własnego natywnego kontekstu. Nie powstaje nowy scheduler, evaluator lane ani drugi backend.

**Technologie:** Rust, istniejący FMS/session store, MFEM/hypre/CUDA, zarządzana grupa Docker DEV wskazanego worktree.

**Specyfikacja:** `docs/superpowers/specs/2026-11-14-fem-gpu-initial-observation-design.md`.

## Ograniczenia

- Zachować cztery istniejące cudze zmiany oraz źródłowe skrypty, siatki i Zarr.
- Budować wyłącznie w grupie Compose wskazanego checkoutu; dane techniczne w wolumenach Docker, wyniki przez zatwierdzony profil SP4 ext4.
- Nie zmieniać fizyki, tolerancji, kryteriów stopu, requested/resolved lane ani GPU lease.
- Czasy jako nieujemne `u64` ns, opcjonalne dla faz niewykonanych; brak danych nie oznacza czasu zero.
- Nie publikować nowych wyników na GitHub bez wymaganej zgody na konkretny payload.

## Ryzyka podlegające testom

- Retry po zapisie obserwacji nie może powodować konfliktu przez inny czas pomiaru.
- Stary receipt i brak metryk pozostają czytelne; niepoprawne metryki nie uzyskują statusu pomiaru.
- GPU initial frame nie może zostać powiązany z finalnym m/clock ani obcą próbą.
- Stop/Pause przy initial callback nie może wykonać kroku fizycznego.
- Brak budżetu lub obsługi live nie może powodować fallbacku CPU ani włączenia legacy kopii co krok.

## Etap 1: rozłączne, trwałe czasy preparera

Pliki: `crates/fullmag-api/src/accepted_fem_preparer.rs`, `accepted_fem_preparer_main.rs`, `accepted_fem_preparation_supervisor.rs`; typ i testy `crates/fullmag-session/src/types.rs`; istniejący ścisły konsumenci exit receipt w `scripts/` i ich testy.

- [x] Zdefiniować opcjonalny typ `FmsPreparationPhaseTimings` i walidację zakresów/sumy faz oraz round-trip starych rekordów.
- [x] Zmierzyć osobno load, replay validation, mesh/space, fizyczne evaluate, bundle/CAS, commit observation i commit task receipt.
- [x] Przekazać podsumowanie przez istniejący bounded stdout; supervisor przyjmuje wyłącznie metryki procesu z dokładnie zgodnymi identyfikatorami, bez nadawania im roli authority.
- [x] Uaktualnić wszystkie ścisłe czytniki; dodać testy starego schematu, uszkodzonych metryk i retry.
- [x] Wykonać adekwatne testy w zarządzanej ścieżce/CI, review, commit spójnego fragmentu; dopiero potem runtime baseline na tej samej fizyce SP4 z pełnym Zarr.

Stan etapu 1: commit `cbbf162dc108e7b600ca27c9983871a65f123e6e`, sześć workflow CI i zarządzana bramka natywnego Poissona PASS. Pierwsza próba baseline została odmówiona przed RunIntent z powodu brakującego origin. Po naprawie etapu 1b nowy publiczny Run ukończył się z pełnym Zarr i przeszedł niezmienione bramki naukowe oraz pomiarów faz. Szczegółowe wyniki pozostają w prywatnym checkpointcie kampanii.

## Etap 1b: odtworzenie origin potrzebne do porównywalnych powtórzeń

- [x] Zachować opcjonalny, zahashowany `source_origin` przy nowym managed terminal capture; plik readonly/nofollow, zamknięty DTO i parytet walidacji Python/Rust.
- [x] Przekazywać do hydratacji wyłącznie zweryfikowany locator; stare proofy bez origin zachowują widok, a względna siatka otrzymuje jawny błąd przed lowering/RunIntent.
- [x] Dla aktualnej starej sesji wykonać nowy capture z jawnymi pinami aktywacji, zgodnymi oboma RunIntentami i kompletnym inventory obu rodzin lease; nie przepisywać proofu `c7`, nie kopiować assetów ani nie zwiększać limitu aktywacji.
- [x] Dokończyć review, CI i zarządzany build w tej samej grupie SP4; restore nie może wykonać Solve ani nowego RunIntent. Następnie wykonać baseline z metrykami faz i pełnym Zarr.

Stan etapu 1b: commity `7770a95b50423c74d6496d19f708ffe009e92170` i `cb16b1e84f7fdd9967a267155e389c58509946b7`; sześć workflow CI oraz zarządzany build/restore PASS. Historyczne odmowy pozostają zachowane; nie powtarzano Solve w trakcie odtwarzania.

## Etap 2: jednokrotne początkowe obserwacje GPU

Pliki: `crates/fullmag-runner/src/types.rs`, `lib.rs`, produkcyjny `dispatch.rs`, `fem/relax/{direct_minimizer,llg_overdamped,preview,scalars}.rs`; `crates/fullmag-api/src/accepted_fem_study_worker.rs` i `accepted_fem_preparer.rs`; właściwe testy i dokumentacja ADR/physics source-map.

- [ ] Utrwalić wykonywalny runtime regression check: poprzednia wersja odmawia kwalifikacji GPU-only-prepared physics przez rzeczywisty rekord `fem_cpu`.
- [ ] Wprowadzić jawny tryb pojedynczego native GPU initial capture, z zachowaniem dotychczasowych wywołań bool i bez zmiany legacy `initial_snapshot`.
- [ ] Wpiąć jeden coherent capture w obu produkcyjnych pętlach FEM przed pierwszym krokiem, zachowując rzeczywisty zegar po begin-stage i Stop/Pause.
- [ ] Włączyć tryb wyłącznie dla zakwalifikowanego, mieszczącego się w budżecie workera FEM GPU.
- [ ] Usunąć fizyczną ewaluację CPU z preparera żądanego GPU; utrwalić jawny powód braku pola przed compute lease i zachować CPU preview toru CPU.
- [ ] Uaktualnić ADR 0071 oraz opis/source-map obserwacji; nie zmieniać równań ani deklarować niewykonanych dowodów.
- [ ] Wykonać testy i niezależne review przed commitem fragmentu, potem zbudować/uruchomić przez tę samą grupę i profil SP4.
- [ ] Wykonać trzy porównywalne próby z pełnym Zarr. Sprawdzić wszystkie energie, torque, certyfikat residuum, authored m0, tożsamość planu i brak CPU physical evaluation. Porównać osobno runner, fazy preparera oraz cały publiczny Run.

## Kontynuacja pełnego celu

- [ ] Dokończyć pięć naprzemiennych par wspólnego protokołu BB oraz kwalifikowany, ograniczony profil GPU.
- [ ] Dokończyć statykę i dynamikę A/B FDM CPU/GPU, FEM CPU/GPU względem zweryfikowanej referencji MuMax3 GPU.
- [ ] Po spełnieniu wymaganych bramek dokończyć CI/review/PR i lokalną integrację, zachowując cudze zmiany, wyniki i aktywne środowiska.
