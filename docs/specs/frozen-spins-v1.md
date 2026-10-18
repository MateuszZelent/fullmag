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
## 11. Wszystkie aktywne magnetyczne DOF zamrożone

Poniższa prerejestracja rozdziela magnetyczny no-op od ewolucji aktywnych
pól transportu. Rozszerzenie all-frozen + transport pozostaje
`planned_contract`, runtime `NOT VERIFIED`; nie rozszerza wcześniejszej
kwalifikacji samego constraintu.

### 11.1. Czysto magnetyczny all-frozen

Gdy $U=\varnothing$ i stage nie wykonuje pomocniczego transportu, zachowany
jest deterministyczny no-op magnetyczny: `executed_steps=0`,
`converged=true`, `stop_reason=all_active_dofs_frozen`. Nie uruchamia się
integratora ani minimizatora. W dynamice zegar może osiągnąć zadany endpoint
analitycznie; relaksacja/minimizator nie wytwarza czasu fizycznego. Pola/energia
mogą być odświeżone na potrzeby wymaganych outputs. Diagnostyczne
`max_torque_all_Apm` może być niezerowe; redukcje po pustym $U$ wynoszą zero.

### 11.2. Aktywny transport w TimeEvolution

All-frozen dotyczy M, nie zamraża potencjału ładunkowego ani stanu spinowego.
Aktywny transport w `TimeEvolution` wykonuje istniejący coupled integrator:
M1/M2 — obsługiwany fixed Heun; M3 — `coupled_imex_ark2`, fixed lub adaptive
zgodnie z oddzielnymi bramkami lane. Na każdym etapie pełny RHS podlega
final-mask, a każdy candidate przywraca tę samą referencję M. Nie zmienia się
fizycznego torque/obserwabli na zamrożonych targetach.

`executed_steps` oraz istniejące workflow `accepted_steps/rejected_steps`
raportują rzeczywiste próby/kroki fizycznego czasu; nie wolno podmienić ich
zerem dlatego, że M się nie zmieniło. `step_count`, `StepStats.time/dt`,
`accepted.evaluated_time_s` i historia/checkpoint opisują ten sam zaakceptowany
stan. Tylko istniejący begin-attempt/evaluate/commit/rollback promuje transport.
Błąd nie publikuje trialu ani nie zmienia accepted/cache/history. Zerowy krok,
ręczne nadanie accepted i przeskok zegara bez rozwiązanego transportu są zabronione.

Jedynym właścicielem czasu pozostaje stage i istniejący harmonogram zdarzeń.
Oceny źródeł używają rzeczywistego czasu podkroku oraz uzgodnionej authored
semantyki absolute/stage-local. Krok jest obcinany do najbliższego breakpointu
źródła, wymaganego outputu i finalnego endpointu. Stała siatka M3 nie może
pominąć zdarzenia; partial step zachowuje rzeczywiste dt i historię. Nie wolno
przepisać wyniku solve dla jednego czasu na inny `canonical_fixed_target`.

Sukces wymaga faktycznie zaakceptowanego transportu dla końcowego czasu;
`Paused`/`Cancelled` zachowuje rzeczywisty czas i spójny StageCompletionIR,
bez completed/converged ani analytical jump. All-frozen metric opisuje M,
nie stanowi dowodu zbieżności transportu. Restart odtwarza M reference oraz
właściwy accepted transport, historię i kontroler albo odmawia bez fallbacku.

### 11.3. Relaksacja i minimalizacja

`Relaxation` pozostaje konserwatywnym workflow. Aktywne niekonserwatywne
torque jest już odrzucane przez `validate_conservative_relaxation`.
Transport transient M3 w Relax jest w tej prerejestracji jawnie unsupported,
także z nieaktywnym torque: brak kanonicznego kryterium zbieżności transient
transportu w Relax. Nie dodaje się takiego kryterium ani pseudoczasu.
Direct PG-BB/NCG + dynamic transport nadal podlega istniejącej odmowie.
Nie wynika stąd nowa odmowa istniejącego statycznego grafu steady/zero-current
z wyłączonym torque; jego dotychczasowe bramki pozostają w mocy.

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

(frozen-v2-composite-checkpoint)=
## 13. Composite checkpoint v2: frozen + transient M3 ExactResume

**Stan: `planned_contract`; codec v2, integracja writer/restore i runtime
`NOT VERIFIED`.** To prerejestracja formatu do kolejnej implementacji, nie
obsługiwana dziś wersja checkpointu. Nie zmienia równań, publicznego Python DSL,
`ProblemIR`, solvera, schedulera ani wcześniejszych kwalifikacji V1.
Właścicielem złożenia jest istniejący M3 owner
`crates/fullmag-runner/src/fdm/cpu/spin_transport.rs::FdmSpinTransportWorkflow`.
Zagnieżdżone stany zachowują dotychczasowe codecs i ich walidatory.

| Solver | Device | Composite v2 ExactResume |
|---|---|---|
| FDM | CPU | Planowany wyłącznie reference FP64, M3 ARS, fixed/adaptive; brak dowodu runtime |
| FDM | GPU | Unsupported w tej wersji; brak zgodnego ownera composite, bez fallbacku |
| FEM | CPU | Unsupported w tej wersji; inne DOF/runtime i brak zgodnego composite |
| FEM | GPU | Unsupported w tej wersji; bez dziedziczenia kwalifikacji constraintu |

### 13.1. Dokładne pola i typy

Poniższe nazwy typów `Composite*V2` są **nową prerejestracją**, nie symbolami
istniejącego API. Wszystkie wymienione pola są required. `T | null` oznacza
obecne pole z jawnym null, nigdy pole pominięte. `Hex64` to dokładnie 64 małe
znaki `[0-9a-f]`; `Sha256Ref` ma postać `sha256:` + `Hex64`. `Id` jest niepustym
ID walidowanym przez istniejącego ownera, nie ścieżką pliku. `f64` jest finite;
liczniki i indeksy mają dokładny typ `u64`, bez konwersji przez `f64`.

```text
CompositeM3CheckpointV2 = {
  schema: "fullmag.fdm.coupled_m3_checkpoint.v2",
  payload_sha256: Hex64,
  coupled: FdmCoupledCheckpoint,                 // schema fullmag.fdm.coupled_m3_checkpoint.v1
  frozen_spins: FrozenSpinsCheckpointV1 | null,
  frozen_activation_set: FrozenSpinsActivationSet,
  stage_frame: CompositeStageFrameV2,
  accepted_frame: CompositeAcceptedFrameV2,
  output_frame: CompositeOutputFrameV2
}
CompositeStageFrameV2 = {
  run_id: Id, stage_id: Id, stage_index: u64,
  stage_kind: "time_evolution",
  problem_ir_sha256: Hex64,
  original_fdm_plan_sha256: Sha256Ref,
  stage_definition_sha256: Hex64,
  original_stage_start_s: f64, original_stage_end_s: f64,
  waveform_origin_s: f64,
  stepping: {kind:"fixed", nominal_grid_origin_s:f64, nominal_dt_s:f64}
          | {kind:"adaptive", controller_policy_sha256:Hex64}
}
CompositeAcceptedFrameV2 = {
  state_ref: AcceptedStateRef,
  step: u64, time_s: f64, last_dt_s: f64,
  last_step: {kind:"single_ars", start_time_s:f64, inner_dt_s:f64}
           | {kind:"two_half_ars", start_time_s:f64, split_time_s:f64,
              first_inner_dt_s:f64, second_inner_dt_s:f64}
}
CompositeOutputFrameV2 = {
  origin_s: f64, configuration_sha256: Hex64,
  scalar_schedules: Vec<CompositeOutputCursorV2>,
  field_schedules: Vec<CompositeOutputCursorV2>,
  default_scalar_last_sampled_time_s: f64 | null,
  initial_sample_committed: bool, final_sample_committed: bool,
  committed_manifest: CompositeOutputManifestBindingV2 | null
}
CompositeOutputCursorV2 = {
  output_index: u64, schedule_index: u64, name: String,
  every_seconds: f64, next_time: f64, last_sampled_time: f64 | null
}
CompositeOutputManifestBindingV2 = {
  catalog_revision: u64, artifact_id: Id,
  object_ref: Hex64, content_sha256: Hex64
}
```

`FdmCoupledCheckpoint`, `FrozenSpinsCheckpointV1`, `FrozenSpinsActivationSet`
i `AcceptedStateRef` są **obecnymi typami**, odpowiednio z
`fdm/cpu/spin_transport.rs`, `constraints/checkpoint.rs`,
`constraints/activation.rs` i `fullmag-quantities/src/accepted_state.rs`.
V2 nie przedefiniowuje ich pól ani semantyki. Required nested schema są dokładnie
`fullmag.fdm.coupled_m3_checkpoint.v1` oraz, dla obecnego frozen child,
`fullmag.frozen_spins.checkpoint.v1`; activation set nie dostaje nowego schematu.
`coupled` zachowuje cały v1:
M/previous M, accepted fields, transient histories, controller, source/cache/
operator identities, counters, thermal RNG i własny `payload_sha256`.
Frozen child zachowuje packed mask, reference, hashes, topology, source revision,
counts, lane, M/time/dt/step i pełne mapy epok. Activation set zachowuje epoki
również dla historycznych, obecnie nieaktywnych constraintów.

| Pole / grupa | Wymaganie i jednostka SI |
|---|---|
| `schema`, identyfikatory, hashe, `state_ref` | Wersja/tożsamość/integralność, $1$; nie dowód poprawności fizyki |
| `step`, `stage_index`, `output_index`, `schedule_index`, rewizje i epoki | Dokładne liczniki $1$; indeksy od zera, bez inferencji ID z indeksu |
| Wszystkie `*_s`, `every_seconds`, `next_time`, `last_sampled_time` | Czas fizyczny $\mathrm{s}$; finite, okresy i dt dodatnie |
| `coupled.magnetization`, `previous_magnetization`, frozen reference/M | Zredukowana magnetyzacja $1$ w istniejącym układzie FP64 AoS XYZ |
| `coupled.transient_states[].spin_potential_v` i historia | Istniejące potencjały spinowe $\mathrm{V}$; bez reinterpretacji jednostek |
| `frozen_spins`, `committed_manifest`, sampled-time null | Jawna nieobecność określona poniżej; nie serde default ani downgrade |

`stage_index` wskazuje oryginalną kolejność authored stages, a `stage_id`
wskazuje jego stabilną tożsamość. Wymagane są zgodne oryginalne
`TimeStageContextIR` i `StudyIR::TimeEvolution`; brak stabilnego ID nie jest
naprawiany przez nazwę, indeks ani UUID utworzony przy Resume. W tej wersji
writer publikuje checkpoint wewnątrz jednego stage, przed jego transition.
Capture po final outputs może mieć `time_s=original_stage_end_s`, ale oznacza
wciąż ten sam stage i jawnie zapisaną fazę outputs.

`problem_ir_sha256` obejmuje kompletny oryginalny authored `ProblemIR`,
`stage_definition_sha256` obejmuje obiekt z dokładnie dwoma polami
`study` (oryginalne ProblemIR.study) i `time_stage` (oryginalne FdmPlanIR.time_stage)
oryginalnego stage. Oba hashe używają kanonizacji §13.2.
`original_fdm_plan_sha256` używa istniejącej funkcji
`fdm_abm3_plan_sha256` nad oryginalnym `FdmPlanIR`, łącznie z jej prefiksem;
nie jest hashem przepisanym po przesunięciu początku segmentu Resume.
`controller_policy_sha256` obejmuje kompletną oryginalną resolved
`adaptive_timestep` tej lane, nie zmienny stan kontrolera z nested checkpointu.

(frozen-v2-composite-hash)=
### 13.2. Strict decode i serializacja hash

Nowe struktury i tagged variants mają `serde(deny_unknown_fields)`, bez
`flatten` i bez `serde(default)`. Required-nullable pola wymagają jawnego
sprawdzenia obecności klucza **przed** deserializacją do `Option<T>`: zwykłe
serde `Option` samo nie odróżnia brakującego klucza od null. Reader odrzuca
powtórzone klucze JSON na dowolnym poziomie, NaN/Inf, zły integer range,
nieznany wariant i trailing data; nie przepuszcza dokumentu przez parser
last-key-wins przed strict ingress validation.

Nested standalone v1 codecs nie zmieniają legacy zachowania. W ingress v2
surowe zagnieżdżone obiekty muszą mieć dokładnie rekursywne zestawy kluczy
kanonicznej serializacji do ich obecnych typów; brakujące defaultowane pola
v1 i ignorowane unknown keys nie mogą zniknąć przy typed projection.
Dotyczy to też nested Options: serializer istniejącego v1 określa, czy dany
null jest emitowany czy pomijany. W szczególności `rollback_count` i nested
`payload_sha256`, frozen `problem_sha256`, `constraint_activation_epochs`,
`active_constraint_ids` i `resolved_constraint_set_revision` muszą być jawne.
Dodatkowo canonical_json_bytes(raw_child) musi być identyczne z
canonical_json_bytes(serde_json::to_value(decoded_child)); porównanie to
odrzuca także zmianę długości/kolejności zbiorów po typed decode. V2 nie
uruchamia historycznych `effective_*` defaults, aby dorobić brakujące epoki. Kolejność zbiorów/BTreeSet i map jest kanoniczna; tablice stanów oraz
kolejność modułów i OutputIR nie są sortowane lub poprawiane przy odczycie.

Outer digest jest zdefiniowany dokładnie: zwalidowany payload jako JSON Value,
zmienić **wyłącznie top-level** `payload_sha256` na pusty string, policzyć
`fullmag_session::types::canonical_json_sha256` i porównać `Hex64`.
`canonical_json_bytes` rekursywnie sortuje klucze obiektów leksykograficznie,
zachowuje kolejność tablic i koduje skalary przez `serde_json::to_vec`, bez
spacji. Repozytoryjny `float_roundtrip` zachowuje finite FP64. Nie normalizować
liczb, znaku zera, kolejności tablic ani stringów przed sprawdzeniem hash;
writer i reader używają tej samej kanonicznej serializacji typed FP64 danych.
To istniejący owner kanonizacji, nie nowy format własnego JSON lub RFC-JCS.

Nested `coupled.payload_sha256` **nie** jest czyszczony. Jest oddzielnie
sprawdzany przez istniejący `coupled_checkpoint_payload_sha256` oraz
`validate_complete_coupled_checkpoint`; używa własnej dotychczasowej
serializacji typed v1. Frozen mask/reference hashe także zachowują dotychczasowe
funkcje. Nie naprawiać żadnego błędnego nested hasha i nie zastępować go nowym.
Outer hash obejmuje każde dziecko, activation set, clock, origin, cursor,
manifest binding i accepted identity. Żaden hash nie zastępuje zgodności
aktualnego planu, source/operator/material/grid i rzeczywiście trwałych outputs.

(frozen-v2-composite-accepted-history)=
### 13.3. Jeden accepted stan i rzeczywista historia ARS

`original_stage_start_s>=0`, `original_stage_end_s>original_stage_start_s`
i accepted time należy do tego domkniętego przedziału. Waveform origin jest
odrębnym finite czasem; nominal fixed dt oraz actual inner/outer dt są dodatnie.
Capture jest dozwolony wyłącznie po accepted commit, z zerową liczbą aktywnych
trialów, candidates i attempt snapshots. Wszystkie poniższe porównania wspólnego
stanu są bitowe w lane FP64, również dla signed zero; niedokładność nie jest
naprawiana przepisaniem timestampu, normalizacją M ani clampingiem reference:

- `accepted_frame.time_s`, `coupled.time_s`,
  `coupled.accepted.evaluated_time_s`, wszystkie transient `time_s`,
  frozen `time_s` (gdy obecny) i persisted common-state time są identyczne;
- `accepted_frame.step = coupled.accepted_steps = frozen.step = common.step`
  dla obecnego child; `state_ref.id.accepted_step` ma tę samą wartość;
- `accepted_frame.last_dt_s = coupled.previous_dt_s = frozen.dt = common.dt`;
  jest to rzeczywisty ostatni **outer accepted dt**, nie nominalny grid dt
  i nie `error_controller.next_dt_s`;
- bieżące `coupled.magnetization`, frozen `magnetization` i common primary M
  mają identyczne bity, rozmiar, layout i topology. Frozen DOF są już równe
  zapisanej reference; błąd nie pozwala na clamp przed restore transportu;
- `state_ref` jest istniejącym `AcceptedStateRef`; `run_id`, niepusty stage ID,
  clock/state/domain/plan digests i generation muszą przejść istniejącego ownera
  `accepted_state_digests`/`AcceptedStateId::from_canonical_state` oraz zgodność
  z zachowanym original frame. Nie utożsamiać source state revision epoki z
  bieżącym accepted step; obie rewizje mają osobne role.

Fixed M3 zapisuje `last_step.kind=single_ars`, `inner_dt_s=last_dt_s` i czas
outer start. Nested `TransientSpinState.previous_dt_s` to ten sam inner dt,
a `previous_spin_potential_v` pochodzi z outer start. `previous_magnetization`
z nested M3 również pochodzi z outer start, nie z nowego stanu.

Adaptive ARS zapisuje **zaakceptowane rozwiązanie dwóch podkroków**,
`last_step.kind=two_half_ars`. `first_inner_dt_s` jest faktycznym pierwszym
krokiem FP64 `0.5*last_dt_s`, `split_time_s` jego endpointem, `second_inner_dt_s` faktycznym drugim
krokiem. Outer trial endpoint ustala się przed solve jako FP64
`start_time_s + last_dt_s`. Pierwszy podkrok zaczyna się w `start_time_s`,
a drugi w `split_time_s`; ich obliczone endpointy muszą bitowo zgadzać się
odpowiednio ze split i accepted time. Drugi dt jest residualem
`outer_endpoint - split_time_s`; roundoff może odróżniać go od pierwszego.
Nie wymaga się `2*second_inner_dt_s == last_dt_s` ani równości obu inner dt.
Każdy dt jest finite, dodatni i daje reprezentowalny postęp czasu.

W nested historii adaptive
`coupled.transient_states[*].previous_dt_s = second_inner_dt_s`, a
`previous_spin_potential_v` opisuje stan split; nie wolno podmienić ich na
outer dt/start, nawet przy stałym M. Nested `previous_magnetization` nadal
jest M z początku outer trial, zgodnie z dotychczasowym writerem. Outer
`accepted_steps` rośnie o jeden, nie o dwa; telemetry/revision/refresh/history
zachowują rzeczywisty właścicielski stan po dwóch commitach, bez wyprowadzania
ich z `accepted_steps`. Istniejący nested validator pozostaje obowiązkowy.
Full-step trial służy estimatorowi, nie zastępuje zaakceptowanego two-half stanu.
To prerejestracja spójności checkpointu; nie jest dowodem rzędu ARS lub
poprawności przez skok impulsu. Zmiany residual-endpoint w source wymagają
osobnego runtime gate; v2 nie sankcjonuje dopisywania czasu po solve.

### 13.4. Frozen child i historyczna activation set

`frozen_spins:null` jest legalne dokładnie przy braku aktywnego resolved frozen
planu dla tego stage; authored, ale nieaktywny constraint nie aktywuje się
przez samą obecność w historii. `frozen_activation_set` pozostaje zawsze
required, także wtedy. Puste mapy i revision zero są legalne tylko wtedy,
gdy są rzeczywistym stanem właściciela przed pierwszą zmianą aktywnego zbioru;
nie są fallbackiem, gdy zabrakło historycznych danych.

Gdy child jest obecny, jego `constraint_activation_epochs`,
`active_constraint_ids` i `resolved_constraint_set_revision` są bitowo/
strukturalnie identyczne z `frozen_activation_set`; aktywne IDs zgadzają się
z bieżącym resolved planem, a mapa zachowuje także nieaktywne historyczne IDs.
`activation.epoch`, source revision, mask/reference i topology przechodzą
`validate_structure`, `validate_problem_sha256` i `validate_for_plan`.
Frozen `problem_sha256` zgadza się z `original_fdm_plan_sha256`, nie z
przepisanym planem segmentowym. Null child wymaga pustego active set i zgodności
jego nieaktywnych historycznych counters z faktycznym ownerem.

Obecny międzyetapowy owner to
`interactive/runtime.rs::InteractiveRuntime::frozen_spins_activation_set`;
`interactive_runtime_host.rs::ensure_interactive_preview_runtime` pobiera
poprzedni set przed zmianą runtime i przekazuje go przez istniejący lifecycle
constructor, a orchestrator `run_script_mode` uruchamia ten host dla stage.
Nowy writer musi pobrać ten sam accepted revision z tego ownera i z engine
FrozenSpinsState w jednej transakcji capture, nie z UI statusu. Dla headless
ścieżki bez rzeczywistej historycznej activation set wymagany jest osobny
work item podłączenia tego samego ownera; do tego czasu odmowa
`composite_frozen_activation_history_unavailable`. Resume nie wywołuje
`prepare_transition`, `prepare_reactivation`, selektora ani recapture, aby
odtworzyć zapisany bieżący stage. Zwykłe przejście do przyszłego stage nastąpi
później przez dotychczasowy owner i zwiększy epokę dokładnie raz.

(frozen-v2-composite-output-commit)=
### 13.5. Output phase, tożsamość i trwały prefix

`output_frame.configuration_sha256` hashuje przez §13.2 obiekt
`{"outputs": <pełna uporządkowana lista resolved OutputIR>}`. Implicit default
scalar trace pozostaje deterministycznie wyprowadzona przez obecny owner
(`scalar_schedules.is_empty()`), nie przez nową opcję. `output_index` to indeks
tej listy, `schedule_index` indeks odpowiedniej istniejącej kolekcji scalar/
field; `name` jest dokładnie nazwą ownera (w tym qualified Snapshot component).
Wszystkie wymagane cursory występują dokładnie raz; nie scalać powtórzonych
nazw w różnych outputach. `every_seconds` jest dodatnie i bitowo zgodne z
resolved OutputIR. `next_time` pochodzi z `OutputSchedule`, nie z checkpoint time.
`last_sampled_time` jest null tylko gdy ten output naprawdę nie wyemitował próbki.

Original `origin_s`, waveform origin i nominal grid origin są odrębnymi
zapisanymi rolami, także gdy mają tę samą wartość. Fixed grid zachowuje swój
original start i nominal dt; event clipping nie przesuwa siatki po off-grid
pauzie. Resume odtwarza istniejące schedule cursory. Walidacja fazy sprawdza
reprezentowalny dodatni okres, monotoniczny next deadline po accepted time,
last-sampled nie po accepted time i zgodność periodic origin według istniejących
`schedules.rs::same_time`/`OUTPUT_TIME_TOLERANCE`. Niereprezentowalna/niejednoznaczna
faza jest błędem, nie resetem do zera ani do resumed segment start. Schedules
pozostają jednym ownerem next-time, a time_events ownerem clippingu.
`default_scalar_last_sampled_time_s` jest cursorem już wyemitowanego default
trace, a dwa booleany identyfikują faktycznie committed initial/final boundary
samples. Capture przed endpointem wymaga `final_sample_committed=false`.
Brak initial/final duplikatu po Resume musi wynikać z tych samych trwałych
próbek, nie tylko z flag zadeklarowanych przez caller.

`committed_manifest` jest **nowym bindingiem do istniejącego dokumentu**, nie
nowym receiptem. Wskazuje obecny CAS-backed `FmsStudyOutputManifest` przez
`FmsArtifactCatalogEntry` o `artifact_type="study_output_manifest"`,
`status=published`, zgodnych `artifact_id`, `object_ref`, `content_sha256`
i katalogu o co najmniej przypiętym `catalog_revision>0`.
`object_ref=content_sha256`; entry i manifest pozostają immutable nawet gdy
katalog ma nowszą rewizję. Weryfikuje się istniejące run/task/step/attempt/
ownership_epoch, accepted-state reference oraz wszystkie output entries przez
ich obecne codecs. Manifest musi pokrywać cały committed scalar/field/default/
boundary prefix wskazany cursorami i dokładnie ten accepted frame; nie może
odsyłać do innego stage lub przyszłych niezaakceptowanych danych.
Null binding jest legalny tylko przy faktycznym braku jakiejkolwiek wykonanej
próbki; nie służy do pomijania default trace.

Obecny `ArtifactRecorder::record_scalar/record_field_snapshot` może tylko
zakolejkować output. To **nie** potwierdza trwałości ani zgodności prefixu.
`SessionStore::commit_checkpoint` zapisuje common state i sprawdza kompletny
graf przed atomowym markerem checkpoint.json pod writer lease; capture zapisuje
backend_state wcześniej przez tego samego store ownera. Wymagana integracja
ma użyć tej transakcji i faktycznie istniejących published manifest/CAS edges,
bez nowego per-step fsync, osobnego receiptu lub drugiego output timera.
Dotychczasowy immutable manifest jest allow-list całego attemptu; nie wolno
nadpisywać go kolejnym prefixem lub wymyślić rewizji manifestu. Work item:
istniejący output publication owner musi związać dopuszczony historyczny prefix
i jego kontynuację zgodnie z dotychczasowym attempt/lease kontraktem, a
reachability checkpointu musi retainować wskazane już committed edges.
Dopóki ten związek nie istnieje, dany checkpoint otrzymuje
`composite_outputs_not_committed` i **nie** klasyfikuje się jako ExactResume,
nawet przy poprawnych cursorach, hashach i count. To jawny brak implementacji.

(frozen-v2-composite-atomic-restore)=
### 13.6. Atomowy capture i restore

Writer: po accepted M3/frozen commit i wykonaniu due outputs pobrać jeden
spójny accepted snapshot, historyczną activation set, original frames oraz
rzeczywisty committed output binding. Zweryfikować dzieci i cross-checks,
nadać outer hash, a dopiero potem publikować backend state przez istniejący
checkpoint store. StepUpdate i authoritative artifact dla M3 używają jednego
v2 payloadu; audytowe child artifacts mogą pozostać, ale selector CLI/API nie
może zastąpić composite przez pure frozen child. Błąd przed commit markerem
nie promuje połowy grafu do kompletnego checkpointu.

Reader: strict ingress/presence → outer hash → pełny nested M3 hash/complete
validator i source/operator identities → frozen structure/problem/plan i
activation set → common M/time/step/dt → original stage/output identity oraz
rzeczywiście committed prefix. Dopiero po powodzeniu **wszystkich** sprawdzeń
odtworzyć przygotowane lokalne workflow, FrozenSpinsState, istniejący activation
owner i cursory, a następnie atomowo zastąpić active state przez istniejącego
restore ownera. Jakikolwiek błąd pozostawia stare M, accepted transport,
controller, histories, epochs, RNG, cursory i opublikowany checkpoint bez zmian.
Wywołanie kolejno dwóch mutujących restore na aktywnych obiektach nie jest
transakcją. Nie tworzyć nowego Context ani schedulera; staging jest lokalnym
stanem istniejących właścicieli.

Expected identity pochodzi z oryginalnego admitted authored problemu/stage,
nie z samego żądania Resume. Segment wykonawczy może mieć current position,
lecz nie zmienia original start/grid/output origin/end ani hash definitions.
`until` inny niż authored endpoint to odrębny continuation contract i jest w
ExactResume v2 odrzucany jako `composite_stage_endpoint_mismatch`. Nie usuwać
pól planu z hasha, aby zamaskować różnicę. Implementacja odbiorców ma objąć
`ResumeJson`, orchestrator paused/final artifact selection i API persistence
wewnątrz obecnych endpointów oraz compatibility ownerów.

(frozen-v2-composite-legacy)=
### 13.7. Zgodność legacy i przyszłe bramki odbioru

Standalone Frozen V1 zachowuje dotychczasową pure-frozen obsługę; nested M3 V1
zachowuje swoją dotychczasową, ograniczoną obsługę tam, gdzie istnieje.
Żaden z nich nie dowodzi frozen+M3/history/output-phase ExactResume.
Brak dowolnego required pola v2 daje odmowę, bez inferencji origin z waveform,
current time lub step*dt, bez tworzenia epoki i bez v1→v2 upgrade w readerze.
Tymczasowa odmowa legacy transport resume w aktualnie naprawianej ścieżce jest
osobnym fail-closed zabezpieczeniem; ta prerejestracja jej nie usuwa.
PortableStateImport pozostaje jawnym, odrębnym workflow, bez automatic downgrade.

Bieżąca tymczasowa bramka runnera odmawia checkpoint/resume z **każdym
aktywnym transportem M1/M2/M3**. Niniejszy format ma wyłącznie owner/formułę M3;
nie przywraca frozen + steady M1/M2 ani ich current/output ExactResume.
Domknięcie tej części wymaga osobnego work itemu w tej samej kanonicznej
architekturze checkpointów, bez opakowywania steady stanu w pozorny payload
M3. Nie projektuje się tutaj kolejnego formatu lub publicznego enumu.
Przyjęcie implementacji M3 v2 nie pozwoli automatycznie usunąć szerszej bramki;
E11 pozostaje otwarte aż do jawnych kontraktów i dowodów wszystkich jej lane.

Planowane gate IDs, obecnie niewykonane:

- `composite_v2_strict_codec`: unknown/duplicate/missing/defaulted keys,
  required-null versus missing, nested/outer hash, bitwise M/time/dt mismatch;
- `composite_v2_ars_history`: fixed single i adaptive residual two-half,
  nonzero start, endpoint rounding, off-grid pause, inner != outer dt,
  controller/counters/RNG i interrupted-versus-full accepted states;
- `composite_v2_frozen_epochs`: active/inactive/active stage chain, pełna
  historical map, overlap/reference, brak recapture i brak defaultów;
- `composite_v2_outputs_atomicity`: trwały prefix, brak phase reset/duplikatów,
  initial/final/default rows, late output/IO failure bez nowego markeru;
- `composite_v2_cli_api_roundtrip`: ten sam payload i compatibility przez CLI,
  API, pause/final artifact replay; brak child-only override;
- `composite_v2_resume_transaction`: późna odmowa dowolnego dziecka lub output
  binding nie zmienia aktywnego drugiego dziecka, clocks ani cursorów.

Wszystkie powyższe to prerejestracja do implementacji, bez runtime, parity,
production ani scientific-order claim. Focused docs validators weryfikują
strukturę/mapowanie, nie wykonanie codec/restore.
