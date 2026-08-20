# ADR 0026: model ograniczenia i selekcji dla frozen spins

- Status: zaakceptowany projekt implementacyjny
- Data: 2026-08-20
- Właściciel: Fullmag core
- Powiązane dokumenty:
  - `docs/superpowers/specs/2026-08-20-frozen-spins-production-design.md`
  - `docs/physics/0996-frozen-spins-constraint.md`
  - `docs/specs/selection-expr-v1.md`
  - `docs/specs/frozen-spins-v1.md`
  - `docs/validation/frozen-spins-qualification-matrix.md`

## Kontekst

Użytkownik musi móc zachować wybraną magnetyzację bez ruchu podczas relaksacji
i dynamiki, przy zachowaniu wpływu tych spinów na pełną energię, pola i
sąsiednie swobodne stopnie swobody. Obecny `ObjectRegionIR` opisuje geometrię
regionu, przypisania materiałowe i politykę meshu. Przeciążenie go semantyką
solvera związałoby ograniczenie z materiałem, uniemożliwiło prawdziwą algebrę
nakładających się selekcji i rozmyło provenance.

Chronimy następujący inwariant produktu: Python DSL i Control Room zapisują ten
sam typed `ProblemIR`, planner zachowuje requested intent i publikuje resolved
execution, a każdy backend realizuje jeden backend-neutralny kontrakt fizyczny
bez cichego pominięcia lub fallbacku.

## Decyzja

### Własność semantyczna i aktywacja

`ProblemIR` otrzymuje top-level definicje `selections` oraz
`magnetization_constraints`. `FrozenSpins` jest wariantem osobnego
`MagnetizationConstraintIR`, a nie właściwością regionu ani materiału.
Aktywacja pozostaje częścią constraintu i wskazuje cały run albo jawne
`stage_ids`. Składnia `constraints=[...]` przy stage w Pythonie jest wyłącznie
sugar; lowering zawsze tworzy top-level definicję z zakresem aktywacji.

Publiczne wersje kontraktu to `selection_expr.v1` i `frozen_spins.v1`.
Wprowadzenie nowych publicznych kolekcji wymaga docelowego bumpu `ProblemIR` z
aktualnego `0.3.0` do `0.4.0`; migracja `0.3.0 -> 0.4.0` dodaje dwie puste
kolekcje i nie rekonstruuje constraintów z regionów.

### Selekcja

Selekcja jest zamkniętym typed AST. V1 dopuszcza aktywną domenę magnetyczną,
obiekt, `ObjectRegion`, predykat geometrii, współrzędne, składowe i normę
magnetyzacji, `AND`, `OR`, `XOR`, `NOT` oraz referencję do nazwanej selekcji.
Arbitralne lambdy, `eval` i stringowe programy nie są częścią kontraktu.

Publiczny helper `disk` obniża się do skończonego `Cylinder`. Wariant z jawną
grubością ma `height_m = thickness_m`. Wariant `through_object` wymaga obiektu,
wyznacza skończony przedział projekcji jego bounds na oś cylindra, dodaje
kanoniczną tolerancję granicy i przecina wynik z `in_object`. Zerowa grubość i
nieskończony cylinder nie są legalnym znaczeniem dysku w domenie 3D.

Publiczna granica geometrii domyślnie jest inkluzywna. Brak `boundary`
normalizuje się w kanonicznym IR do jawnego `inclusive` z wersjonowanymi
tolerancjami `absolute_tolerance_m=0.0` i `relative_tolerance=1e-12`; authored
fingerprint nie zależy od sprzętu ani lokalnych defaultów evaluatora.

Zwykłe zmiennoprzecinkowe `==` nie jest operatorem V1. Równość przybliżoną
wyraża `approx(atol, rtol)`, a przedziały `between`; wartości NaN nie wybierają
DOF i generują diagnostykę, natomiast nieskończony stan magnetyzacji jest
błędem solvera.

### Moment capture, członkostwo i epoka aktywacji

V1 przyjmuje `static` i `snapshot_at_activation`. Domyślna referencja to
`capture_current_at_activation`. Materializacja maski i przechwycenie
referencji są jedną transakcją na stabilnej rewizji stanu: po zakończeniu
poprzedniego zaakceptowanego kroku lub po przygotowaniu stanu początkowego
stage, po standardowej normalizacji/walidacji solvera, a przed pierwszą próbą
kroku z aktywnym constraintem. Constraint layer nie normalizuje referencji po
raz drugi.

Domyślne membership wynika deterministycznie z klasy AST. Selektor zawierający
wyłącznie geometrię, obiekt/region, współrzędne, stałe i operatory zbiorowe
normalizuje się do jawnego `static`. Każda zależność od magnetyzacji propaguje
`state_dependent` i normalizuje się do jawnego `snapshot_at_activation`.
Jawne `static` dla AST zależnego od stanu jest błędem; jawne
`snapshot_at_activation` jest legalne dla obu klas.

Epoka aktywacji jest maksymalnym ciągiem kolejnych wykonywanych stage'y, dla
których constraint jest aktywny. Nieciągłe wartości `stage_ids` nie mają
semantyki numerycznego zakresu: stage nieaktywny zamyka epokę, a każdy późniejszy
aktywny stage rozpoczyna nową i wykonuje wymagane snapshot/capture. Bezpośrednie
przejście między dwoma aktywnymi stage'ami zachowuje epokę bez recapture.
Checkpoint wewnątrz aktywnej epoki odtwarza jej licznik, maskę, referencję,
source revision i stage identity oraz wznawia bez recapture; checkpoint w
stanie nieaktywnym rozpoczyna nową epokę dopiero przy następnym przejściu do
aktywnego stage. Fresh rerun zaczyna licznik epok od zera.

Samoczynnie zmieniające się członkostwo nie należy do V1. Przyszła polityka
aktualizacji na zaakceptowanych krokach wymaga odrębnego kontraktu histerezy,
resetu historii algorytmu i pełnego checkpointu maszyny członkostwa.

### Materializacja FDM i FEM

FDM utrzymuje niezależne `active_mask`, jednowartościowe `region_mask` i
boolowskie `frozen_mask`; `free_mask = active_mask AND NOT frozen_mask`.
`region_mask` nigdy nie zastępuje maski constraintu.

FEM materializuje selekcję na magnetycznych true DOF. Preview uprawniony do
aktywacji używa dokładnie tego samego kompilatora true-DOF i fingerprintu co
plan. Projekcja po węzłach albo centroidach może istnieć wyłącznie jako jawnie
nieautorytatywny szybki podgląd i nie może aktywować constraintu.

Pierwsza reprezentacja runtime jest dense: maska `u8` i referencja trzech
składowych w precyzji backendu. Checkpoint i transport mogą użyć bitsetu lub
kompresji, ale hot loop nie otrzymuje obowiązkowego sparse lookup. Zmiana na
sparse wymaga profilu i osobnej decyzji.

### Kontrakt runtime

Constraint obowiązuje od początku zarówno w relaksacji, jak i dynamice. Każdy
backend musi wykonać trzy działania:

1. wyzerować pełny RHS lub gradient dopiero po złożeniu LLG, STT, SOT, termiki
   i pozostałych składników;
2. odtworzyć referencję po każdym stanie kandydującym, podkroku,
   normalizacji, retrakcji, odrzuconej próbie i zaakceptowanym kroku;
3. liczyć normy, iloczyny skalarne, estymatory błędu i kryteria stopu po
   swobodnej domenie.

Telemetry `max_rhs_all` i `max_torque_all_Apm` powstaje na $A$ z pełnego
złożonego RHS i torque przed finalnym maskowaniem, na tej samej rewizji co
odpowiednie redukcje `free` po $U$. Wartości `all` są diagnostyczne; wyłącznie
`free` steruje stopem. Dla all-frozen redukcje `free` mają wartość zero z
jawnym stop reason, a nie semantykę pustego maksimum.

Energia i pola są obliczane na pełnym stanie. Zamrożone DOF nadal są źródłem
exchange, demag, DMI i torques wpływających na swobodnych sąsiadów. W tangent
plane implicit zamrożone przyrosty są essential true DOF albo są równoważnie
eliminowane z operatora.

Gdy wszystkie aktywne DOF są zamrożone, stage kończy się bez iteracji z
`converged=true`, `executed_steps=0`, `free_dof_count=0` i
`stop_reason="all_active_dofs_frozen"`. Niezerowa metryka całej domeny pozostaje
diagnostyką, nie warunkiem stopu.

### Capability i brak fallbacku

Planner publikuje osobne capability dla wersji schematu, wariantów selektora,
polityki członkostwa, polityki referencji, dyskretyzacji, urządzenia, precyzji,
algorytmu i trybu stage. Każdy lane ma niezależny status IR, planner, runtime,
scientific, managed i browser. Brak dowodu w dowolnej osi pozostawia lane jako
`UNQUALIFIED`.

Wymuszone urządzenie, precyzja lub backend failują przed wykonaniem, jeśli
constraint nie jest obsługiwany. Tryb `auto` może rozwiązać tylko legalny lane;
requested intent, resolved execution i powód rozstrzygnięcia są zapisane w
planie i provenance. Constraint nigdy nie jest cicho pomijany.

Polityka `inactive_selection=warn_and_intersect` dotyczy wyłącznie raw authored
candidate mask: planner raportuje bity poza aktywną domeną i przecina je z nią.
Po wydaniu resolved certificate obowiązuje twardy inwariant $F\subseteq A$;
bit poza $A$ w masce runtime, cache albo checkpointu jest błędem, nie kolejnym
warningiem i nie podlega naprawczemu przecięciu.

Aktywacja wszystkich constraintów danej epoki jest atomowa także na overlap.
Resolved reference muszą być dokładnie równe na każdym wspólnym DOF po
konwersji do precyzji lane, nawet dla dwóch capture-current pochodzących z
różnych epok. Niezgodność odrzuca całą aktywację przed modyfikacją stanu; V1 nie
ma tolerancyjnego merge ani precedence.

## Konsekwencje

- Region zachowuje czystą odpowiedzialność materiałowo-meshową.
- Ten sam selektor może zasilać preview, solver, overlay i checkpoint.
- FDM CPU/GPU oraz FEM CPU/GPU implementują różne realizacje, ale nie różne
  równania, jednostki ani stop reasons.
- Produkcyjna numeryka FEM pozostaje w `backends/fem`, a produkcyjna natywna
  numeryka FDM w `backends/fdm`; runner odpowiada za plan, ABI, artefakty i
  provenance.
- API v2 publikuje cienkie, rewizjonowane zasoby constraintu i preview. Ciężka
  maska należy do binarnej data plane, nie do statusu sesji.
- Control Room używa jednego command/ribbon modelu i jednego drzewa viewportu;
  capability sterują dostępnością zamiast rozdzielać aplikację na lane'y.

Kosztem jest nowa wersja IR, wspólny kompilator selekcji, stan constraintu w
checkpointach i osobne bramki każdej ścieżki wykonawczej. Koszt jest
zamierzony: prostszy region-property lub końcowy clamp nie spełnia kontraktu
fizycznego ani restartu.

## Obowiązki implementacyjne

1. Dodać typed AST, walidację, canonicalizację, hash i migrację IR.
2. Zapewnić identyczny lowering jawnego API, convenience API regionu i eksportu
   Control Room do Python DSL.
3. Materializować maskę dopiero dla resolved gridu/mesha i zapisać certyfikat.
4. Utrzymać osobne realizacje FDM CPU, FDM CUDA, FEM CPU/MFEM i FEM GPU bez
   ukrytych transferów host/device w hot loop.
5. Dodać checkpoint maski, referencji, rewizji aktywacji i fingerprintu
   topologii; mismatch topologii failuje bez niejawnej reprojekcji.
6. Dodać resource-first API, generowane typy, resource hooks, Inspector i
   viewport overlay dopiero wraz z ich testami kontraktowymi.
7. Promować capability wyłącznie przez macierz
   `docs/validation/frozen-spins-qualification-matrix.md`.

## Migracja i rollback

Reader `0.4.0` akceptuje `0.3.0` przez addytywną migrację pustych kolekcji.
Writer zapisuje wyłącznie aktualną wersję. Reader `0.3.0` nie może obiecać
zachowania constraintu; dlatego rollback aplikacji jest bezpieczny tylko dla
problemów bez nowych kolekcji albo po jawnym usunięciu constraintów przez
narzędzie migracyjne. Nie ma downgrade'u przez ciche odrzucenie pól.

Feature może pozostać za capability/feature flag do czasu kwalifikacji. Rollback
runtime oznacza odrzucenie problemu zawierającego `frozen_spins.v1`, nie
uruchomienie go bez constraintu.

## Testy i walidacja

- deterministic serialization i migracja pustych kolekcji;
- negative tests: unknown field, brak referencji, cykl, złożoność, NaN/Inf,
  unsupported combinations, nielegalne membership, resolved bit poza aktywną
  domeną i konflikt overlap;
- default `inclusive` w canonical IR oraz deterministyczne defaulty membership
  dla geometry-only i state-dependent AST;
- epoki dla kolejnych i nieciągłych stage IDs, inactive-to-active, active resume
  bez recapture oraz topology/stage mismatch;
- identyczny fingerprint preview i resolved mask;
- bitowa niezmienność zamrożonych DOF w precyzji lane;
- zachowanie wpływu zamrożonych spinów na swobodne DOF;
- relaksacja, dynamika, wszystkie wykonywalne integratory, direct minimizers,
  TPI, STT, SOT, termika i all-frozen;
- osobne `all` i `free` z tego samego pre-constraint RHS/torque;
- restart z identyczną maską i referencją oraz fail-closed topology mismatch;
- managed/container runtime dla FEM/MFEM/CUDA/hypre/libCEED;
- browser smoke z aktualnym zasobem, widocznym overlayem, zdrowym WebGL i
  niezerowym drawing bufferem.

Na etapie tego ADR żadna ścieżka nie ma dowodu runtime frozen spins. Wszystkie
lane'y pozostają `UNQUALIFIED`; dokumentacja zamyka decyzję, ale nie kwalifikuje
implementacji.
