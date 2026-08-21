# `frozen_spins.v1`: ograniczenie magnetyzacji

- Status: zatwierdzony kontrakt implementacyjny; FDM CPU/CUDA runtime oraz FEM CPU P1 RK zweryfikowane w zarządzanych recepturach
- Wersja schematu: `frozen_spins.v1`
- Właściciel: `MagnetizationConstraintIR`
- Powiązane: ADR 0026, `docs/specs/selection-expr-v1.md`

(frozen-v1-constraint-model)=
## 1. Model i inwariant

Niech $A$ oznacza aktywne magnetyczne DOF, $F \subseteq A$ zrealizowaną maskę
zamrożoną, $U=A\setminus F$ swobodne DOF, a $\mathbf m_F^\star$ referencję.
`FrozenSpins` wymusza $\mathbf m_i(t)=\mathbf m_i^\star$ dla $i\in F$.
Zamrożone spiny pozostają częścią pełnego stanu używanego do pól i energii;
nie są usuwane ze źródeł exchange, demag, DMI, STT/SOT ani stencilów.

W direct minimizers czas fizyczny nie jest zmienną niezależną. Dla
bezwymiarowego indeksu iteracji $k\in\mathbb N_0$ ten sam inwariant ma postać
$\mathbf m_i^{(k)}=\mathbf m_i^\star$ dla $i\in F$.

(frozen-v1-energy)=
Energia ograniczona ma dokładnie semantykę
$E_\mathrm{c}(\mathbf m_U)=E(\mathbf m_U,\mathbf m_F^\star)$. Ograniczenie nie
zeruje $\mathbf H_\mathrm{eff}$ i nie usuwa zamrożonych spinów z redukcji
energii.

(frozen-v1-final-rhs)=
## 2. Final-RHS masking

Backend najpierw składa pełny RHS z LLG, STT, SOT, transportu, termiki i innych
aktywnych źródeł. Dopiero potem wykonuje `rhs[i]=0` dla $i\in F$. Maskowanie
samego klasycznego LLG albo pola przed dodaniem torque jest niezgodne ze
schematem.

(frozen-v1-candidate-restore)=
## 3. Candidate restore

Każdy stan kandydujący, podkrok jawnego RK, próba adaptacyjna, predictor/
corrector, normalizacja, retrakcja minimizatora i accepted state odtwarza
`m_candidate[F]=m_reference[F]`. Referencja używa precyzji wykonawczej lane.
Po zaakceptowaniu kroku drift powinien być bitowo zerowy w tej reprezentacji;
`frozen_reference_max_drift` pozostaje obowiązkową diagnostyką.

(frozen-v1-free-reductions)=
## 4. Free-domain reductions

Kryteria stopu, normy RHS/torque, estymatory błędu, BB $s/y$, NCG $\beta$,
iloczyny skalarne i warunki Armijo używają wyłącznie $U$. Energia trial pozostaje
energią pełnej konfiguracji. Dla pełnego złożonego, jeszcze niezamaskowanego
RHS $\mathbf R_i$ oraz momentu
$\mathbf T_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}$ obowiązuje:

```text
max_rhs_free          = max(i in U) ||R_i||_2
max_rhs_all           = max(i in A) ||R_i||_2
max_torque_free_Apm   = max(i in U) ||T_i||_2
max_torque_all_Apm    = max(i in A) ||T_i||_2
```

Wszystkie cztery wartości powstają z tego samego stanu i rewizji po wymaganym
candidate restore tego stanu oraz po złożeniu LLG, STT, SOT, termiki i
pozostałych źródeł, lecz bezpośrednio przed final-RHS masking. Wartości `all`
są diagnostyczne. Wartości `free` sterują stopem; dla $U=\varnothing$ mają
kontraktową wartość `0` wraz z `stop_reason="all_active_dofs_frozen"`, a nie
wynik pustej redukcji. Telemetria publikuje osobno:

```text
max_rhs_free
max_rhs_all
max_torque_free_Apm
max_torque_all_Apm
active_dof_count
frozen_dof_count
free_dof_count
frozen_reference_max_drift
```

(frozen-v1-tpi)=
## 5. Tangent-plane implicit

W TPI przyrost $\mathbf v_F=0$. FEM realizuje to przez essential true DOF albo
równoważną eliminację w operatorze i preconditionerze. Wyzerowanie rozwiązania
po solve nie spełnia kontraktu.

(frozen-v1-thermal-transport)=
## 6. Termika, STT i SOT

V1 utrzymuje deterministyczne mapowanie RNG na globalny DOF. Backend może
obliczyć losowość na całej domenie, ale maskuje finalny RHS; nie wolno przesunąć
strumienia swobodnych DOF wskutek zmiany liczności $F$. Zamrożony spin może być
sąsiadem stencila STT/exchange/DMI i wpływać na swobodny spin, lecz jego finalna
pochodna pozostaje zerowa. SOT oraz pozostałe direct torques podlegają temu
samemu finalnemu maskowaniu.

(frozen-v1-capture)=
## 7. Capture i membership

`capture_current_at_activation` zachodzi atomowo po ustaleniu stabilnego,
standardowo zwalidowanego i znormalizowanego stanu stage, a przed jego pierwszą
próbą kroku. Maska zależna od magnetyzacji oraz referencja używają tej samej
`source_state_revision`. Constraint nie wykonuje dodatkowej normalizacji.

V1 wspiera `static` i `snapshot_at_activation`. Default jest wyprowadzany z
klasy AST przez kanoniczną analizę `selection_expr.v1`: `geometry_only`
normalizuje się do jawnego `{"kind":"static"}`, a `state_dependent` do jawnego
`{"kind":"snapshot_at_activation"}`. Jawne `static` jest legalne wyłącznie
dla `geometry_only`; na `state_dependent` daje typed error
`frozen_membership_static_state_dependent`. Jawne `snapshot_at_activation`
jest legalne dla obu klas i wymusza materializację na początku każdej nowej
epoki. Kanoniczny IR zawsze zawiera znormalizowane pole `membership`.

Epoka aktywacji jest maksymalnym ciągiem kolejnych **wykonywanych** stage'y, w
których `enabled=true` i activation scope zawiera bieżący stabilny stage ID.
Kolejność wykonania, nie leksykalna ani numeryczna ciągłość ID, określa
sąsiedztwo. Maszyna stanu constraintu działa następująco:

1. run zaczyna w `inactive` z licznikiem epok równym `0`;
2. wejście z `inactive` do aktywnego stage atomowo zwiększa licznik, tworzy
   nową epokę, materializuje wymagany snapshot i rozwiązuje referencję;
3. przejście bezpośrednio do następnego wykonywanego aktywnego stage zachowuje
   tę samą epokę, maskę i referencję bez recapture;
4. dowolny wykonywany stage nieaktywny zamyka epokę; późniejszy aktywny stage,
   także o nieciągłym ID z tej samej listy `stage_ids`, rozpoczyna nową epokę;
5. retry, podkrok, line search, accepted step ani pauza w stage nie tworzą
   epoki.

Na początku każdej nowej epoki `snapshot_at_activation` jest materializowane
ponownie, a `capture_current_at_activation` zawsze przechwytuje nową referencję
z tej samej `source_state_revision`. Maska `static` może zostać użyta ponownie
tylko przy identycznym topology fingerprint, lecz nadal otrzymuje certyfikat
nowej epoki; `initial_state` i `explicit_field_asset` zachowują swoje źródło.
Aktualizacja membership w podkroku, line search lub accepted step nie należy do
tego schematu.

(frozen-v1-problem-ir)=
## 8. Kanoniczny payload

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
  "reference": {"kind": "capture_current_at_activation"},
  "membership": {"kind": "static"},
  "activation": {"kind": "stage_ids", "stage_ids": ["relax"]},
  "empty_selection": "error",
  "inactive_selection": "warn_and_intersect"
}
```

Definitions żyją w `ProblemIR.magnetization_constraints[]`; `selector` może być
inline albo `ref` do `ProblemIR.selections[]`. Aktywacja wskazuje `all_stages`
lub niepustą listę stabilnych stage IDs. Unknown fields i nieznane wersje są
odrzucane.

Dozwolone reference policies V1:

- `capture_current_at_activation` — domyślna;
- `initial_state` — kanoniczny stan początkowy solvera;
- `explicit_field_asset(asset_id)` — tylko po sprawdzeniu domeny, liczby
  składowych, jednostki $1$, normy i topology fingerprintu.

(frozen-v1-overlap)=
## 9. Overlap i aktywna domena

Resolved mask jest sumą OR aktywnych constraintów po przecięciu każdej selekcji
z aktywną domeną magnetyczną zgodnie z authored `inactive_selection` policy.
Raw candidate bits poza aktywną domeną mogą zostać ostrzeżone i przecięte;
resolved/runtime/checkpoint mask z takim bitem jest twardym błędem inwariantu,
nie kandydatem do naprawy.

Przed atomowym committem nowej epoki runtime porównuje wartości resolved
reference każdego aktywnego constraintu na każdym wspólnym DOF po konwersji do
precyzji lane. Muszą być dokładnie równe w tej reprezentacji, niezależnie od
policy, assetu i numeru epoki. Dotyczy to również dwóch
`capture_current_at_activation`, które powstały w różnych epokach. Pierwsza
niezgodność odrzuca całą aktywację atomowo, pozostawia poprzedni stan epoki bez
zmian i zwraca typed conflict z IDs, count, przykładowymi indeksami i maksymalną
różnicą. Overlap nie ma tolerancyjnego merge ani reguły pierwszeństwa.

(frozen-v1-runtime-representation)=
## 10. Runtime, checkpoint i provenance

Referencyjna reprezentacja V1 to dense `u8 frozen_mask` oraz dense
`m_reference` w precyzji backendu, z osobnym no-mask fast path. FDM przechowuje
maskę niezależnie od `active_mask` i `region_mask`. FEM przechowuje maskę na
magnetycznych true DOF; GPU utrzymuje maskę i referencję device-resident bez
obowiązkowych kopii hostowych w hot loop.

Checkpoint zapisuje schema version, authored selector AST/fingerprint,
resolved mask fingerprint, skompresowaną maskę wymaganą do dokładnego restartu,
referencję, activation epoch, source revision, counts, topology fingerprint,
backend, device i precision. Restart z inną topologią failuje; V1 nie
reprojektuje ani nie resampluje selektora zależnego od stanu.

Checkpoint zapisany wewnątrz aktywnej epoki odtwarza stan `active`, dokładny
licznik epoki, maskę, resolved reference, `source_state_revision` i bieżący
stage. Resume kontynuuje tę samą epokę bez materializacji lub recapture.
Checkpoint na granicy po zamknięciu epoki odtwarza `inactive`; jeśli następny
wykonywany stage jest aktywny, rozpoczyna zwykłą nową epokę. Mismatch stage
identity, mask/reference fingerprintu, precyzji albo topologii failuje przed
wykonaniem. Fresh rerun nie jest resume: zaczyna licznik od `0`.

Provenance zachowuje requested intent i resolved execution, constraint IDs,
capability IDs, backend realization, mask/reference fingerprints, counts,
precision i diagnostykę driftu.

(frozen-v1-all-frozen)=
## 11. Wszystkie aktywne DOF zamrożone

Gdy $U=\varnothing$, stage jest deterministycznym no-op:

```json
{
  "converged": true,
  "stop_reason": "all_active_dofs_frozen",
  "executed_steps": 0,
  "active_dof_count": 128,
  "free_dof_count": 0
}
```

Pola/energia mogą zostać odświeżone raz na potrzeby wymaganych outputs. Nie
wykonuje się integratora ani minimizatora. `max_torque_all_Apm` może być
niezerowe i jest diagnostyczne; stop metric po $U$ ma wartość zerową z jawnym
powodem zakończenia, a nie wynik pustej redukcji NaN.

(frozen-v1-capabilities)=
## 12. Capability vocabulary i failure semantics

```text
constraint.frozen_spins.v1
constraint.frozen_spins.reference.capture_current_at_activation.v1
constraint.frozen_spins.reference.initial_state.v1
constraint.frozen_spins.reference.explicit_field_asset.v1
constraint.frozen_spins.membership.static.v1
constraint.frozen_spins.membership.snapshot_at_activation.v1
constraint.frozen_spins.relaxation.v1
constraint.frozen_spins.dynamics.v1
constraint.frozen_spins.final_rhs_mask.v1
constraint.frozen_spins.candidate_restore.v1
constraint.frozen_spins.free_reductions.v1
constraint.frozen_spins.checkpoint.v1
constraint.frozen_spins.telemetry_free_all.v1
```

Capability jest raportowane z ograniczeniami discretization/device/precision/
algorithm/integrator. Missing lub false capability powoduje typed planner
rejection. Forced GPU/CPU, precision i backend nie są zmieniane. Tryb `auto`
może rozwiązać tylko lane legalny dla wszystkich aktywnych capability i zapisuje
powód wyboru. Nie ma trybu pominięcia constraintu.

Wymagane błędy obejmują nieznany selector/stage/asset, pustą selekcję,
niezgodny overlap, nielegalne `static` dla state-dependent AST, unsupported
membership/reference/algorithm, zły rozmiar maski, resolved frozen DOF poza
aktywną domeną, stale revision, activation-epoch mismatch, topology mismatch i
drift powyżej kontraktu lane.

Authoring Python, typed IR oraz plannerowe kompilatory FDM/FEM implementują
schemat selekcji, dense maskę i certyfikat resolved plan. Kompilator przyjmuje
referencję jako zwalidowane wejście transakcji; backendy nie konsumują jeszcze
tego planu i nie realizują constraintu. Status każdego lane pozostaje
`UNQUALIFIED` do czasu przejścia macierzy
`docs/validation/frozen-spins-qualification-matrix.md`.
