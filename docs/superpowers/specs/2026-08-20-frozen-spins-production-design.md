# Produkcyjny projekt frozen spins

## Status i zakres

Dokument definiuje zatwierdzony projekt produkcyjnego `frozen spins` w Fullmag. Implementacja obejmuje pełny pion semantyczny i wykonawczy:

- publikacyjny kontrakt fizyczny;
- publiczny Python DSL;
- typed `ProblemIR`;
- walidację, normalizację, planner i capability matrix;
- FDM CPU oraz CUDA;
- FEM CPU/MFEM oraz kwalifikowane ścieżki GPU;
- relaksację, dynamikę, bezpośrednie minimizatory i obsługiwane integratory;
- checkpointy, provenance i telemetrię;
- API v2;
- Control Room: ribbon, Explorer, dedykowany Inspector i overlay maski.

Zakres będzie realizowany etapami, ale etapowanie nie zmniejsza końcowego kontraktu produkcyjnego V1.

## Cel użytkownika

Podstawowy przepływ ma być analogiczny do MuMax3: użytkownik definiuje region ferromagnetyka i przypisuje mu zamrożenie spinów. Fullmag zachowuje tę ergonomię w Pythonie i UI, jednocześnie utrzymując poprawne rozdzielenie semantyki materiałowej od ograniczeń solvera.

Przykładowy Python DSL:

```python
pinning = magnet.add_region(
    region_id="pinned_edge",
    shape=fm.Box(...),
)

pinning.freeze_spins()
```

Równoważna jawna postać:

```python
frozen = fm.FrozenSpins(
    id="pinned_edge_frozen",
    selector=fm.select.in_region(magnet, pinning),
    reference="capture_current_at_activation",
    membership="snapshot_at_activation",
)

relaxation = fm.Relaxation(
    constraints=[frozen],
)
```

Obie postacie muszą obniżać się do identycznego kanonicznego `ProblemIR`.

## Kontrakt fizyczny

Niech `A` oznacza aktywne magnetyczne stopnie swobody, `F` zbiór zamrożony, `U = A \\ F` zbiór swobodny, a `m*` zapisaną referencję. Dla każdego `i` należącego do `F` obowiązuje:

```text
m_i(t) = m_i*
```

Zamrożone spiny:

- nie zmieniają magnetyzacji w relaksacji ani dynamice;
- nadal uczestniczą w energii i wszystkich oddziaływaniach;
- nadal są źródłem exchange, demag, DMI i pozostałych pól;
- mogą wpływać na swobodne DOF jako sąsiedzi stencila;
- nie uczestniczą w normach sterujących krokiem i warunkiem stopu.

Ograniczenie musi działać przez trzy współdziałające mechanizmy:

1. wyzerowanie pełnego, już złożonego RHS lub gradientu na `F`;
2. twarde odtworzenie `m*` po każdym stanie kandydującym, podkroku, normalizacji, retrakcji i zaakceptowanym kroku;
3. redukcje, normy i iloczyny skalarne wykonywane wyłącznie po `U`.

Maskowanie wyłącznie klasycznego członu LLG jest niedopuszczalne, ponieważ później mogą zostać dodane STT, SOT, termika lub inne źródła momentu.

Jeżeli wszystkie aktywne DOF są zamrożone, etap kończy się deterministycznie bez iteracji z `stop_reason = "all_active_dofs_frozen"`.

## Model semantyczny

### Rozdzielenie regionu i constraintu

`ObjectRegionIR` pozostaje właścicielem geometrii regionu, materiału, polityki meshu i nadpisań parametrów. Nie otrzymuje backendowej semantyki solvera.

`FrozenSpins` jest osobnym `MagnetizationConstraintIR`. Może wskazywać region przez typed selektor `InRegion`, lecz nie staje się parametrem materiałowym regionu.

Takie rozdzielenie umożliwia:

- kilka niezależnych constraintów obejmujących ten sam region;
- selektory obejmujące cały obiekt, kilka regionów lub niezależną geometrię;
- aktywację constraintu tylko w wybranych etapach;
- stabilne identyfikatory, provenance i checkpointy;
- rozwój selektorów bez zmiany semantyki materiałowej.

### ProblemIR

`ProblemIR` otrzymuje dwa typed zasoby:

```rust
pub struct ProblemIR {
    // istniejące pola
    pub selections: Vec<SelectionDefinitionIR>,
    pub magnetization_constraints: Vec<MagnetizationConstraintIR>,
}
```

Minimalny kanoniczny constraint regionu:

```json
{
  "kind": "frozen_spins",
  "schema_version": "frozen_spins.v1",
  "id": "pinned_edge_frozen",
  "name": "Pinned edge",
  "enabled": true,
  "selector": {
    "kind": "in_region",
    "object_id": "magnet",
    "region_id": "pinned_edge"
  },
  "reference": {
    "kind": "capture_current_at_activation"
  },
  "membership": {
    "kind": "snapshot_at_activation"
  },
  "activation": {
    "kind": "stages",
    "stage_ids": ["relax"]
  }
}
```

Dozwolone selektory V1:

- cały aktywny obszar magnetyczny;
- obiekt;
- `ObjectRegion`;
- typed predykat geometryczny;
- porównanie współrzędnej lub magnetyzacji;
- `AND`, `OR`, `XOR`, `NOT`;
- referencja do nazwanej selekcji.

Dowolne lambdy Python, `eval` i stringowy język wyrażeń są zabronione.

### Członkostwo i referencja

V1 wspiera:

- statyczne członkostwo;
- `snapshot_at_activation` dla selektorów zależnych od stanu;
- `capture_current_at_activation` jako domyślną referencję;
- referencję stanu początkowego;
- jawny asset pola referencyjnego, jeżeli przejdzie pełną walidację domeny.

Samoczynnie zmieniające się członkostwo w podkroku pozostaje poza V1. Przyszłe `live_accepted_step_membership` wymaga osobnego kontraktu histerezy, restartu historii integratora i checkpointu maszyny członkostwa.

## Kanoniczny kompilator selekcji

Solver i UI muszą korzystać z tej samej semantyki selekcji. Powstaje jeden kompilator, który:

1. rozwiązuje referencje obiektów, regionów i nazwanych selekcji;
2. normalizuje typed AST;
3. waliduje frame, transformacje, jednostki, tolerancje i złożoność;
4. materializuje maskę dla konkretnego gridu FDM lub przestrzeni true DOF FEM;
5. przecina wynik z aktywną domeną magnetyczną;
6. przechwytuje referencję w atomowym momencie aktywacji;
7. generuje certyfikat, fingerprint i diagnostykę;
8. zasila zarówno resolved plan, jak i preview API.

FDM utrzymuje niezależne maski:

```text
active_mask
region_mask
frozen_mask
free_mask = active_mask AND NOT frozen_mask
```

`region_mask` nie może pełnić funkcji `frozen_mask`, ponieważ jest jednowartościową klasyfikacją materiałową, a constrainty mają prawdziwą algebrę zbiorów i mogą się nakładać.

FEM materializuje constraint na magnetycznych true DOF. Preview węzłów lub centroidów nie jest autorytatywną maską solvera.

## Planner i capability matrix

Planner:

- waliduje unikalność identyfikatorów i referencje;
- wiąże constrainty z etapami;
- odrzuca nieobsługiwane warianty w strict mode;
- materializuje maskę i referencję dopiero dla rozwiązanego gridu/meshu;
- zapisuje requested intent i resolved execution reality;
- emituje jawne capability dla selektorów, polityk członkostwa, backendów i algorytmów.

Brak obsługi w wybranym backendzie nie może prowadzić do cichego pominięcia constraintu ani fallbacku CPU/GPU.

## Runtime i backendy

### Wspólny kontrakt

Każdy backend implementuje te same operacje semantyczne:

- `mask_final_rhs`;
- `restore_frozen_reference`;
- `reduce_over_free_dofs`;
- `validate_frozen_invariant`;
- `checkpoint_constraint_state`.

Równania, znaki, jednostki i observables są backend-neutralne. CPU i GPU posiadają osobne realizacje wykonawcze.

### FDM

FDM CPU/reference jest pierwszym oraclem implementacyjnym. Następnie kontrakt przechodzi do CUDA FP64, CUDA FP32 i multilayer.

Maskowanie obejmuje:

- finalny RHS po LLG, STT, SOT, termice i innych źródłach;
- wszystkie stany kandydatów integratorów;
- line search i retrakcje minimizatorów;
- redukcje BB/NCG i warunki stopu;
- ścieżki kopiowania i normalizacji.

ABI CUDA zmienia się addytywnie i wersjonowanie musi zapobiegać połączeniu niezgodnego runnera z runtime.

### FEM

FEM CPU/MFEM materializuje magnetyczne true DOF i stosuje constraint w runtime. Dla tangent-plane implicit zamrożone przyrosty są essential true DOF albo równoważnie eliminowane z operatora; samo wyzerowanie wyniku po solve jest błędne.

Ścieżki GPU utrzymują maskę oraz referencję device-resident i przechodzą osobną kwalifikację parity. Hostowe kopie nie mogą wejść do hot loop.

### Energia, metryki i telemetry

Energia zawsze obejmuje pełny stan `m_U, m_F*`. Autorytatywne metryki stopu obejmują wyłącznie `U`. Telemetria rozróżnia co najmniej:

- `max_rhs_free`;
- `max_rhs_all`;
- `max_torque_free_Apm`;
- `max_torque_all_Apm`;
- `frozen_dof_count`;
- `free_dof_count`;
- `frozen_reference_max_drift`.

## Checkpoint, restart i provenance

Checkpoint zapisuje:

- wersję schematu constraintu;
- kanoniczny selector AST i fingerprint;
- resolved mask fingerprint oraz skompresowaną maskę, gdy jest wymagana do dokładnego restartu;
- referencję magnetyzacji;
- activation epoch i membership policy;
- liczby frozen/free DOF;
- backend, precyzję i topologię, dla których constraint został zrealizowany.

Restart nie może po cichu ponownie próbkować selektora zależnego od stanu. Zmiana topologii wymaga jawnego odrzucenia albo osobnej, zadeklarowanej polityki reprojekcji.

## API v2

API pozostaje resource-first. Wymagane zasoby obejmują:

- listę i szczegóły constraintów;
- preview selekcji;
- resolved selection dla aktywnego runu;
- skompresowaną maskę dla viewportu;
- diagnostykę, capability i revision.

Preview request zawiera selector AST, target object/stage i oczekiwaną revision. Odpowiedź zawiera liczbę DOF, udział procentowy, bounds, fingerprint, ostrzeżenia i referencję do binarnej maski. Preview i solver muszą używać tego samego kompilatora.

Status sesji pozostaje cienki; ciężka maska nie może zostać osadzona w status JSON.

## Control Room

### Ribbon

Ribbon udostępnia polecenie `Frozen Spins` dla zaznaczonego ferromagnetyka lub jego regionu. Polecenie tworzy constraint z selektorem odpowiednio `InObject` albo `InRegion`.

Command availability pochodzi z capability i bieżącej selekcji. UI nie tworzy nielegalnego stanu, którego planner nie potrafi wykonać.

### Explorer

Constraint jest top-level zasobem semantycznym, lecz Explorer przedstawia go kontekstowo pod właścicielem:

```text
Ferromagnet
└── Regions
    └── pinned_edge
        └── Frozen Spins
```

Dla selektora całego obiektu:

```text
Ferromagnet
└── Frozen Spins
```

Węzeł przechowuje stabilny `constraint_id`; nie duplikuje constraintu w modelu. Usunięcie regionu z aktywnym constraintem wymaga jawnej obsługi referencji, nie cichego orphaningu.

### Dedykowany Inspector

Każdy węzeł `Frozen Spins` otwiera dedykowany Inspector zawierający:

- nazwę, `id` i stan aktywności;
- cel: obiekt, region albo selektor zaawansowany;
- builder typed selektora;
- frame, transformację, sampling i politykę granicy;
- etapy aktywacji;
- membership policy;
- reference policy;
- empty/inactive selection policy;
- preview maski, liczbę i udział DOF;
- bounds, fingerprint, warnings i capability;
- resolved diagnostykę aktywnego runu.

Inspector używa field-scoped pending state. Aktualizacja jednego pola nie blokuje ani nie przyciemnia innych kontrolek, nie remountuje panelu i zachowuje focus, scroll oraz drafty.

### Viewport

Viewport renderuje osobny overlay frozen mask. Overlay:

- nie zmienia reprezentacji materiału ani aktywnej geometrii;
- ma jawne on/off, legendę i liczbę próbek;
- używa resolved/preview mask resource;
- jest zgodny dla FDM i FEM;
- nie obniża domyślnej jakości istniejących warstw.

## Obsługa błędów

Walidacja odrzuca między innymi:

- brakujący obiekt, region, etap lub selection reference;
- cykl referencji selektorów;
- pusty selector bez jawnej polityki;
- nieobsługiwany wariant dla wybranego backendu;
- nieskończone lub niepoprawne parametry geometrii;
- nieodwracalną transformację;
- maskę o złym rozmiarze;
- frozen DOF poza aktywną domeną;
- checkpoint o innym fingerprint topologii;
- dryf zamrożonej referencji powyżej kontraktu backendu.

Błędy są typed, wskazują ścieżkę `ProblemIR` i są prezentowane przez API/UI bez zamiany na ogólny komunikat.

## Strategia testów i bramki

### Kontrakt i IR

- round-trip jawnego oraz ergonomicznego Python API;
- deterministic serialization;
- migracja poprzedniej wersji IR z pustymi kolekcjami;
- negatywne testy referencji, cykli, wersji i nieznanych pól;
- export UI do kanonicznego Python DSL.

### Selekcja

- property tests prymitywów, CSG i transformacji;
- corpus punktów granicznych;
- identyczny fingerprint preview i resolved solver mask;
- FDM cell-center oraz FEM true-DOF materialization;
- selektory zależne od stanu przechwytywane atomowo.

### Numeryka

- bitowa niezmienność zamrożonych DOF w precyzji backendu;
- zachowanie wpływu frozen spinów na swobodne DOF;
- relaksacja i dynamika;
- wszystkie wykonywalne integratory jawne;
- projected-gradient BB, nonlinear CG i tangent-plane implicit;
- STT, SOT i termika;
- all-frozen no-op;
- restart z identyczną maską i referencją;
- parity FDM CPU/CUDA oraz FEM CPU/GPU.

### UI i API

- command availability w ribbonie;
- utworzenie dla obiektu i regionu;
- stabilny Explorer node oraz dedykowany Inspector;
- brak remount, utraty focus/scroll i blokowania niezależnych pól;
- revision-safe preview;
- overlay z niezerowym zasobem i prawidłowymi bounds;
- rzeczywisty browser smoke z widocznym canvas, zdrowym WebGL i niezerowym drawing buffer.

### Autorytatywne wykonanie

Zmiany FEM/MFEM/CUDA/hypre/libCEED są budowane i kwalifikowane przez container-backed receptury repozytorium `just`. Hostowe kompilacje są wyłącznie diagnostyczne.

## Kolejność realizacji

1. ADR oraz publikacyjny kontrakt fizyczny.
2. Kanoniczny evaluator predykatów geometrycznych.
3. Python geometry parity i convenience `disk`.
4. `SelectionExprIR` i Python selection DSL.
5. `MagnetizationConstraintIR`, ergonomiczne API regionu i stage activation.
6. Planner compilation i resolved selection plan.
7. API preview oraz resource revisions.
8. FDM CPU LLG i integratory.
9. FDM CPU direct minimizers i multilayer.
10. FDM CUDA ABI, LLG, minimizatory i multilayer.
11. FEM true-DOF materialization.
12. FEM CPU constraint.
13. FEM GPU constraint.
14. State predicates, checkpoint/restart, telemetry i provenance.
15. Control Room: ribbon, Explorer, Inspector i overlay.
16. Pełna kwalifikacja, dokumentacja capability i gradacja feature flag.

Każdy etap ma własne testy regresyjne. Etap nie otrzymuje statusu produkcyjnego na podstawie samej obecności kodu albo wąskiego testu źródłowego.

## Kryteria ukończenia

Funkcja jest ukończona dopiero wtedy, gdy:

- ergonomiczne API regionu i jawne API constraintu round-tripują do jednego `ProblemIR`;
- preview i solver materializują tę samą maskę;
- każdy wykonywalny backend utrzymuje frozen invariant;
- unsupported paths fail closed;
- checkpoint zachowuje maskę i referencję;
- API publikuje wersjonowane zasoby;
- ribbon tworzy constraint dla obiektu/regionu;
- Explorer pokazuje podgałąź pod właściwym ferromagnetykiem lub regionem;
- dedykowany Inspector jest stabilny podczas mutacji;
- overlay przechodzi rzeczywistą kwalifikację przeglądarkową;
- testy naukowe i managed runtime gates przechodzą dla deklarowanych capability.

## Świadomie odłożone poza V1

- dowolne lambdy i stringowe wyrażenia użytkownika;
- zmiana członkostwa w podkrokach lub line search;
- częściowe zamrożenie pojedynczych składowych magnetyzacji;
- niekwalifikowane selektory imported CAD;
- automatyczne remeshing w celu utworzenia maski;
- niejawna reprojekcja constraintu po zmianie topologii.
