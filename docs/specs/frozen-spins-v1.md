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

Publiczna odmowa A jest `IMPLEMENTED_SOURCE_ONLY`, `NOT_COMPILED`,
`NOT_EXECUTED`: istniejący runner support preflight odmawia checkpoint
ExactResume admission rzeczywistego CPU M1/M2/M3 workflow. API reklamuje wtedy
`RestoreClass::Unsupported` i odmawia przed odczytem common state/mutacją;
CLI przed `take()` paused state, UI restore wyłącznie dla `exact_resume`.
Nie ma automatycznego InitialConditionImport, LogicalResume ani portable
fallbacku. Pure magnetic/frozen/ABM3 bez spin workflow nie otrzymały globalnej
odmowy; GPU/FEM zachowują własnych ownerów. `Ok(())` preflight oznacza wyłącznie
brak tej odmowy, nie pozytywną kwalifikację restore.
[Dokładne symbole i granica wire](resource-first-control-room-api-v2.md#checkpoint-restore-admission).
Prywatny codec i original-stage gate B nie zastępują immutable admission,
common/primary carriers/generation, activation/spin history, original context,
committed output/CAS prefix ani atomowego restore — te gates pozostają OPEN.
Nowe OpenAPI/TS wymagają przyszłego oficjalnego managed pakietu z A; #80 nie jest
dowodem tej zmiany. Pozostały katalog API nadal ma dotychczasową klasyfikację
self-compatibility, bez nowej gwarancji current identity.

**Stan prywatnego codec v2: `IMPLEMENTED_SOURCE_ONLY`, `NOT_COMPILED`,
`NOT_EXECUTED`; publiczna obsługa codec, integracja writer/restore i ExactResume
pozostają `planned_contract`, runtime `NOT VERIFIED`.** Typ
`FdmCompositeCheckpointV2` oraz `decode_composite_m3_codec_v2` i
`FdmCompositeCheckpointV2::validate_self_contained` istnieją w
`crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs`.

Prywatny `CodecCheckedCompositeV2::validate_for_original_stage` ma status
`SOURCE_ONLY`, `NOT_COMPILED`, `NOT_EXECUTED`: sprawdza oryginalne
problem/plan/stage/outputs przekazane przez admitted ownera. Sam helper nie
dowodzi pochodzenia tych danych z immutable admission ani integracji callera.
Common state, primary carriers/generation, activation history, store/CAS prefix,
atomic restore i publiczne API pozostają OPEN; ExactResume/runtime NOT VERIFIED.

Kontrole źródłowe/parser nie wykonują codec. Nie zmienia równań, publicznego Python DSL,
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

Poniższy schema opisuje kontrakt prywatnych typów `Composite*V2`; nie jest
publicznym API ani obsługiwaną ścieżką ExactResume. Wszystkie wymienione pola są required. `T | null` oznacza
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

Bieżąca tymczasowa bramka publicznego admission odmawia ExactResume z **każdym
aktywnym transportem M1/M2/M3**. Nie usuwa istniejącej ograniczonej kontynuacji
solver-state nonfrozen M3 V1: `execute_reference_fdm_with_coupled_checkpoint`
dopuszcza wyłącznie jawny schema V1, brak resolved frozen planu i workflow
transient, nadal przez kompletne walidatory V1 oraz identity wszystkich modułów.
Istniejące Rust wrappers `resume_reference_fdm_from_coupled_checkpoint` i
`resume_reference_fdm_from_coupled_checkpoint_evidence` zachowują ten sam zakres.
Caller przekazuje niezmieniony oryginalny plan i endpoint; V1 nie utrwala
endpointu ani output cursorów/committed prefix. API/CLI/orchestrator zachowują
publiczną odmowę. Regresja final M/accepted artifact/ostatniego wiersza nie
kwalifikuje pełnego ExactResume ani frozen+M3. Poprawka i nowe negatywne
regresje mają status SOURCE_ONLY, NOT_COMPILED, NOT_EXECUTED; E11 pozostaje OPEN.

Niniejszy format ma wyłącznie owner/formułę M3;
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

Powyższe gates pozostają niewykonane; istnienie prywatnego codec źródłowego
nie daje runtime, parity, production ani scientific-order claim. Focused docs validators weryfikują
strukturę/mapowanie, nie wykonanie codec/restore.


(cd-terminal-publication-preregistration)=
## 14. Prerejestracja C+D terminal publication: semantic carriers i pełna historia

**planned_contract / niewdrożone / runtime NOT VERIFIED**. Nie zmienia §13/V2, nie odblokowuje resume i nie przywraca M1/M2. Nowe nazwy wersji są prerejestracją, nie istniejącym publicznym API.

### 14.1. Pierwszy fragment: C+D terminal publication atomowo

Wycofuję C10 jako samodzielny publikowalny etap. Rekomenduję **C+D terminal publication**, z rzeczywistym runner producerem accepted preimages i historii, API collectorem, jednym istniejącym publisherem oraz konsumowanym bounded readerem cold observation/history. W tej fazie wykonanie kończy się obecnym worker completion; nie wdrażamy PauseCheckpoint, historycznej kontynuacji, rebind generation ani restore. Rzeczywisty efekt to trwały, kompletny accepted snapshot i historia zakończonego M3 CPU stage, przydatne kolejnemu ExactResume admission. Nie jest to jeszcze checkpoint-prefix ani ExactResume.

NOWY manifest `study_output_manifest.v4` w tej fazie dopuszcza tylko `publication_kind=completed`, `historical_prefix=null`. **coverage pochodzi z rzeczywistych wyemitowanych próbek** i ustalonych final cursors; nie może być pusta, jeżeli recorder zapisał jakikolwiek scalar/field/default/initial/final output. Brak complete inventory, niespójny count/bytes/clock lub nieobsługiwany format odmawia nowej publikacji V4. Żadnego trybu best-effort „observation only, coverage empty”. Dotychczasowy V3 i jego konsumenci zachowują dotychczasowe działanie. Nowe observation_source.v2 nie jest umieszczane pod strict manifest V3.

Alternatywa tylko in-memory C validator bez trwałej publikacji byłaby mniejsza, ale nie daje pełnego durable producer–consumer kroku i nie jest rekomendowana jako następne wdrożenie. Wspólny C+D jest większy, lecz usuwa trzy wykazane luki bez helpera pozostawionego bez konsumenta. Wersje `checkpoint_prefix` i `historical_prefix!=null` w przyszłym manifest V4 wymagają następnego atomowego fragmentu lifecycle+resolver, nie są włączone przez samo istnienie enum/string w codec.

### 14.2. Dwa etapy: semantyka runnera i publikacja właściciela claimu

### Etap S — runner, bez CAS/claim/artifact IDs

Runner zna rzeczywisty accepted engine/workflow/frozen/activation bundle. Nie zna artifact catalog ownera i nie tworzy artifact_id, ownership_epoch ani CAS references. NOWY plik `solver/fdm_cpu_accepted_state_snapshot.v2.json` ma strict required fields:

`schema_version="fullmag.fdm.cpu.accepted-state-snapshot.v2", clock:ObservationClock, clock_digest:Sha256, state_digest:Sha256, magnetization_digest:Sha256, primary_carriers:Vec<SemanticCarrierV2>`.

NOWY SemanticCarrierV2 required fields: `carrier_id:String, value_digest:Sha256, codec_id:String, codec_version:String, preimage_sha256:Hex64, byte_count:u64`. Brak artifact_id/object_ref. preimage_sha256 jest opisem dokładnych bytes, nie krawędzią CAS. Lista zawiera dokładnie cztery unique sorted IDs z pierwszego draftu; identity wylicza istniejący accepted_state_digests wyłącznie z clock i par `(carrier_id,value_digest.as_bytes())`. Pozostałe metadata, preimage filename i późniejsze catalog IDs nie wchodzą do accepted hash.

Reuse istniejących preimages i wartości z pierwszego draftu: engine solver checkpoint+thermal -> istniejący transactional_state_digest; nested coupled -> istniejący complete validator/payload_sha256; required-nullable frozen child -> canonical typed FrozenPrimaryPreimageV1; dokładny historyczny FrozenSpinsActivationSet -> canonical typed hash. Wszystkie cztery pochodzą z JEDNEGO accepted bundle; outer composite i output manifest nie są carrierami. Nie rekonstruować activation history z active ids, nie wywoływać prepare_transition przy restore.

Runner zapisuje cztery dokładne raw preimages w zamkniętym mapowaniu ról (NOWE stałe producer/collector): `solver/accepted-primary/v2/engine.json`, `coupled.json`, `frozen.json`, `activation.json`. Są to nazwy jawnie zadeklarowanych output artifacts, nie dowolne ścieżki w JSON i nie wyszukiwanie katalogu. API collector używa istniejącej ochrony attempt_output_dir i jawnego bounded artifact read. Consumer cold nie rozwiązuje tych ścieżek na dysku: otrzymuje bindings descriptor i CAS bytes.

API `accepted_study_worker.rs` po powrocie runnera sprawdza semantic metadata, rzeczywiste preimage SHA/length oraz udostępniony przez runner bounded validator całego bundle (nie powiela coupled/frozen walidacji). Na podstawie immutable AcceptedWorkerStep i realnego claimu buduje AcceptedStateId z istniejącymi plan/domain digests, a generation z istniejących claim epoch/accepted_step. Runner nie dostaje uprawnień publishera. Metadata snapshot zachowuje limit 64KiB; ciężkie preimages mają checked budgets z grid/codec/admission, czytane jeden po drugim.

### Etap P — istniejący publish_study_outputs

`ObservationSourcePayloadV2` (NOWY typed variant) niesie semantic snapshot bytes, terminal M bytes, cztery typed role/raw-preimage sources oraz zweryfikowaną historię z punktu 3. Nie niesie wybranych przez caller artifact IDs. Publisher pod aktywnym durable lease ponownie sprawdza immutable source/claim i raw identity. Dopiero on zapisuje CAS i tworzy `PublishedCarrierBindingV2`:

`carrier_id, value_digest, codec_id, codec_version, preimage_sha256, byte_count, artifact_id, object_ref, content_sha256`.

Wszystkie pola semantic muszą zgadzać się z SemanticCarrierV2; object_ref==content_sha256==preimage_sha256==SHA(raw bytes). CAS może deduplikować te same bytes między próbami, lecz wpisy catalog nadal mają ODMIENNĄ tożsamość ownership. Proponowana dokładna reguła ID rozszerza obecną regułę snapshot/state:

`artifact_id="artifact-"+canonical_json_sha256({run_id,task_id,attempt_id,ownership_epoch,artifact_type:"accepted_primary_carrier",carrier_id,object_ref})`.

Nie używać samego payload sha jako artifact ID. Identyczny preimage w nowym attempt ma ten sam CAS hash, ale inny catalog ID; role rozdziela też dwie identyczne wartości wewnątrz jednej próby. Snapshot/state/manifest nadal stosują obecny owner-qualified builder. History index/page/sample IDs analogicznie włączają run/task/attempt/epoch, artifact_type, stream_id, odpowiedni page/sample ordinal i object_ref. Żadnego globalnego relabelowania entries.

NOWE `observation_source.v2` zawiera snapshot/state pola znane z V1, nowe literal adapter/snapshot version oraz `primary_carriers:Vec<PublishedCarrierBindingV2>`. Snapshot CAS bytes pozostają dokładnymi semantic bytes runnera; nie dopisujemy do nich catalog IDs. Descriptor jest jedynym trwałym mapowaniem semantic carrier -> published artifact/CAS. Cold reader sprawdza descriptor/catalog ownership, raw CAS SHA/length i exact semantic agreement, następnie rzeczywisty runner validator i istniejący accepted hash. Nie ufa samym czterem value_digest.

Nie powstaje cykl: accepted identity -> semantic wartości preimages; descriptor -> preimages i snapshot; manifest -> descriptor/index/history; przyszły checkpoint -> manifest. Żaden preimage/snapshot accepted identity nie zawiera własnego descriptor/manifest/catalog ID. session pozostaje typed metadata/CAS ownerem bez runner dependency; runtime-control ma już runner dependency i może wywołać udostępniony bounded validator. Nowe system artifact types wchodzą do obecnej immutable allow-list/freeze-list.

### 14.3. Rzeczywiste historie: source proof i wybrana droga

### Co rzeczywiście istnieje

- `runner/artifact_pipeline.rs::ArtifactRecorder::{record_scalar,record_field_snapshot}` przekazuje ScalarRow(StepStats) i FieldSnapshot do istniejącego writer thread; streaming nie zatrzymuje Vec wszystkich historycznych M. Reference CPU używa faktycznych funkcji record_due_outputs/record_final_outputs w `fdm/cpu/reference.rs` (odczytany plik `reference/outputs.rs` nie ma w tym aktualnym reference.rs mod/import — nie przypisywać mu wywołań).
- `ArtifactPipeline::finish` wysyła Shutdown i join; `runner/lib.rs` sprawdza pipeline_summary po wykonaniu przed końcowym zapisem artifacts. Writer kończy scalars flush i frames_index.finish. To obecna bariera drain, nie dowód per-step fsync/commit.
- CPU domyślnie zapisuje istniejące `fields/<quantity>/step_NNNNNN.json` przez artifacts.rs::write_canonical_field_snapshot_file. Payload zawiera observable,unit,step,time,solver_dt,component_count,component_order,location,scope,revision,layout,provenance,values. To NIE final m_final.json: nie ma wymaganego przez final decoder state_identity, a generic quantities nie są wyłącznie m/unit1.
- `scalars.csv` pochodzi z write_scalars_csv_header/write_scalar_row; zawiera obecnych 19 kolumn StepStats. Czas/wartości są zapisane {:.15e}, więc CSV nie odtwarza bitowo wszystkich f64 źródłowego StepStats.
- frames_index.rs::FramesIndexWriter ogranicza index do 100000 wpisów i ustawia truncated, może scalać kilka quantities w jedną frame/path. Jest bounded narzędziem listowania, NIE kompletnym durable prefix proof ani listą CAS.
- ZarrFieldSeriesWriter w artifact_pipeline jest cfg CUDA/FEM-GPU; sam CPU build z FieldArtifactStorage::Zarr odmawia. Nie otwieramy GPU ani nie traktujemy tej ścieżki jako aktualnego CPU rozwiązania.
- `autosave_zarr.rs::ZarrAutosaveWriter` zapisuje rzeczywiste uncompressed little-endian f64 chunks [sample,width] i continuous references_only index pod target.zarr. `autosave_storage.rs::AutosaveTargetState` posiada stage/target cursors, lecz są to mutowalne filesystem paths, opcjonalny authored autosave, nie automatyczna CAS publication całego domyślnego scalar/field outputu. Nie zastępują current output coverage ani lease catalog.
- session `TensorDescriptor`/`TensorChunk` mają prawdziwe checked shape/chunk coverage i CAS length verification w solution_tensor_source.rs. Obecny runtime-control/study_field_tensor.rs materializuje wyłącznie typed FEM H1/P1 terminalny M. study_dataset.rs tworzy dataset z takich istniejących tensorów i zachowuje pierwszą opublikowaną rewizję. Nie ma tu gotowego FDM CPU time-series importer/recorder.

### Rekomendacja minimalna

Reuse obecnych CPU snapshot JSON i scalar CSV bytes jako **pojedynczych, immutable sample leaves**. Dodaj cienki, stronicowany typed history index, bez inline Vec<field_json>, bez nowego formatu wszystkich M i bez wymuszania autosave/Zarr/tensor materializacji. Engine/solver nie zapisuje CAS. Istniejący artifact writer emituje bounded metadata o faktycznie zapisanych jobs; po drain/seal collector i publisher przenoszą rzeczywiste final bytes sample po sample. Tensor/Zarr pozostają późniejszym adapterem pod tą samą granicą właściciela, po wykazaniu istniejącego importer/consumer; nie projektować drugiego numerical data store.

NOWY semantic sidecar writer inventory `solver/output-history.v1.json` + bounded pages: żadnych values ani CAS/claim IDs. Wpis wskazuje zamkniętą producer-relative ścieżkę/range, codec roli, checked byte length/SHA oraz exact step/time/solver_dt z istniejącego job. Przy scalar row zakres wskazuje dokładne bytes jednej istniejącej linii CSV, header ma osobny stały producer contract; nie renderujemy ponownie numeric bytes ze StepStats. Przy field wskazuje dokładny istniejący JSON file. Seal hashe czyta final bytes po wszystkich provenance updates/drain, sekwencyjnie, nie ufa wcześniejszemu hash przed możliwym rewrite.

Writer metadata musi ponadto zachować rzeczywiste przyczyny próbkowania z istniejących callsite: `causes:Vec<SampleCauseV1>`; cause jest strict tagowanym enum `initial`, `final`, `default_scalar`, `scheduled {output_index:u64,schedule_index:u64}`. Jedna wyemitowana próbka może mieć kilka causes, nie kilka skopiowanych payloadów. Indeksy są pozycjami istniejącego resolved list. To przekazanie faktu z dotychczasowej decyzji schedule, nie drugi scheduler rekonstruujący decyzję z rounded CSV. In-memory execution bez writer inventory nie publikuje nowego V4; nie wytwarza fałszywej empty coverage.

### Dokładny proposed durable thin index

Nowy system root codec `fullmag.study.output_history_index/v1`, strict schema `study_output_history_index.v1`, required fields:

`schema_version,stream_id:String,collection:enum(scalar,field),quantity_id:String,unit:String,sample_count:u64,pages:Vec<HistoryPageBindingV1>`.

HistoryPageBindingV1: `first_ordinal:u64,sample_count:u64,artifact_id:Id,object_ref:Hex64,content_sha256:Hex64,byte_count:u64`. Page ordinals zaczynają się od0 i są contiguous; suma count dokładnie root.sample_count. Nie truncated=true i nie silently retained prefix.

Nowy page schema `study_output_history_page.v1`, required `schema_version,stream_id,first_ordinal,samples:Vec<HistorySampleV1>`.

HistorySampleV1: `ordinal:u64,step:u64,time_s:f64,solver_dt_s:f64,causes:Vec<SampleCauseV1>,payload_codec_id:String,payload_codec_version:String,artifact_id:Id,object_ref:Hex64,content_sha256:Hex64,byte_count:u64`.

Field leaf codec **NOWY reader istniejącego formatu** `fullmag.runner.field_snapshot_json/v1`: exact current bytes z write_canonical_field_snapshot_file, bez konwersji do final state. Nowy bounded decoder waliduje exact closed producer shape, finite values, component/order/location/scope/revision, quantity/unit/catalog, admitted FDM grid/layout oraz step/time/solver_dt vs index. Duplicate keys i unknown ref-like fields w nieprzejrzystych layout/provenance są odrzucane lub przechodzą istniejący strict scan; nie deklarować numerical leaf jako CAS-complete przy nieznanej embedded ref. Final m_final codec nadal osobny i bez zmian.

Scalar leaf codec **NOWY reader istniejących raw row bytes** `fullmag.runner.scalar_csv_row/v1`: dokładna jedna zakończona newline linia 19 kolumn obecnego write_scalar_row; nazwy/kolumny header z pinned producer schema. Ograniczenie proposed max4096 bytes/row, exact count, finite parsing, step token zgodny, time i solver_dt token == istniejące formatowanie {:.15e} exact clock z sidecar. Nie przyrównywać bitów czasu parsowanego z CSV do exact sidecar. Clock używany dla cursor/accepted crosschecks pochodzi z exact job metadata. Row zawiera aktualne skalary; shared payload może być wskazany przez kilka scalar quantity projections, nie kopiować całej historii per quantity. Units/column projection mapowane do istniejącego quantity ownera, bez zmiany znaczenia StepStats.

Proposed checked budgets: root <=4MiB, page <=4MiB i <=8192 entries, <=16384 pages/root; row <=4096 bytes; każdy field frame ograniczony checked admitted grid/component count oraz istniejącym admission storage budget, nie samym deklarowanym byte_count. Sumy page/sample/raw bytes i count używają checked_add/mul, wraz z całym admitted output/storage budget; zero fallback na overflow. Czytelnik/publisher trzyma jedną stronę i najwyżej jeden sample payload, zwalnia sample przed następnym. Katalog/publisher może zachować bounded metadata entries, ale nie all-frame M. Nadmiar odmawia nowego V4, nie obcina historii. Wartości te są NOWYM proponowanym limitem tego indexu, a nie twierdzeniem, że current tensor validator już obsługuje nowy schema.

Właściciel history index/page jest bieżącą próbą. Każdy leaf to catalog Published entry tej samej próby, artifact_type output_history_sample; page/index mają własne typy output_history_page/output_history_index. Immutable manifest freeze-list obejmuje wszystkie trzy oraz accepted_primary_carrier. Przy identycznych bytes CAS dedup legalny; owner-qualified ID unika kolizji attemptów.

### 14.4. V4 actual completion i oba CAS walkers

Względem pierwszego draftu manifest V4 dodaje required `histories:Vec<HistoryIndexBindingV1>`. HistoryIndexBindingV1 zawiera `stream_id,artifact_id,object_ref,content_sha256,byte_count`. Pozostałe obowiązkowe pola: schema_version,run/task/step/attempt/epoch,accepted_state_ref,observation_source.v2,outputs,publication_kind,required-nullable historical_prefix,coverage. W pierwszej fazie completed/null, a outputs pozostają pełnym bieżącym zestawem istniejących declared study outputs. Historie obejmują również default/implicit outputs, nie tworzą fikcyjnych authored portów. Każdy coverage stream wskazuje odpowiedni index/quantity projection oraz count/clocks/causes; final cursors/flags zachowują istniejący schedule owner. Count/hash bez pełnego decode referenced bytes nie oznacza completed coverage.

W tej rewizji dokładne `coverage` required fields to: `schema_version="study_output_coverage.v1",origin_s:f64,configuration_sha256:Hex64,scalar_schedules:Vec<CompositeOutputCursorV2>,field_schedules:Vec<CompositeOutputCursorV2>,default_scalar_last_sampled_time_s:f64|null,initial_sample_committed:bool,final_sample_committed:bool,streams:Vec<HistoryCoverageV1>`. HistoryCoverageV1 required fields: `collection:enum(scalar,field,default_scalar),output_index:u64|null,schedule_index:u64|null,name:String,history_stream_id:String,projection:HistoryProjectionV1,sample_count:u64,first_sample_time_s:f64|null,last_sample_time_s:f64|null`. HistoryProjectionV1 to strict tagged enum `field` albo `scalar_column {column_index:u64,column_name:String}`. Zastępuje poprzednie luźne artifact_ids. Field projection musi wskazywać index tego samego observable/unit, scalar_column dokładną istniejącą kolumnę CSV i zgodną jednostkę quantity. Unikatowy coverage key to collection/index/index/name; history_stream_id rozwiązuje dokładnie jeden manifest.histories index. Cause zapisana przy emisji rozstrzyga, do których harmonogramów zalicza się współdzielona próbka; nie mnożyć payloadów ani count przez liczbę causes. Zero count ma null/null i odpowiada pustemu streamowi, nie usuwa wyemitowanego streamu. Final cursors/flags muszą pochodzić z istniejącego wykonania i sprawdzić się z actual causes oraz sample endpoints, a nie z wymyślonego defaultu.
Actual producer: reference.rs obecne recordery -> ArtifactPipeline drain/seal inventory -> API explicit collector -> publish_study_outputs. Actual consumers do wdrożenia atomowo: validate_study_task_completion, load_study_observation_runtime (nowy descriptor variant i carriers), oraz runtime-control cold history iterator używany przez completion coverage validation i późniejszy resume gate. Public Results mogą dostać adapter dopiero po realnym wymaganiu; nie tworzyć niezależnego endpointu/store. W tej fazie sam istniejący completion validator jest realnym history consumerem, brak jego wywołania blokuje publikację V4/completion.

Publisher najpierw weryfikuje semantic package i realne sample bytes w bounded pass, potem CAS/catalog pod tym samym existing lease. Jedyny publisher buduje leaf/page/index/snapshot/descriptor i manifest, żaden drugi receipt. Catalog commit pozostaje dotychczasowym ownerem; published allow-list zamyka próbę. Po CAS failure bez final catalog/manifest nie ma qualified tokena.

Session typed inspection i store ORAZ archive walker mają jawny versioned dispatch: V4 manifest -> observation snapshot/M/four carriers + history roots -> pages -> leaves. Dla każdego edge existing catalog ownership/status/byte count/SHA, metadata bounded BEFORE parse, raw leaf verified hash/length. Nie dodajemy runner dependency do session i nie nazywamy tej krawędzi physics codec proof. unknown refs/format/partial page odmawiają kompletności; raw leaf format musi mieć potwierdzony brak ukrytych CAS refs, a nie założenie „JSON numerical, więc inline”. Nie kierować V4 do starego helpera V2 i nie zmieniać jego equality. Istniejący publish_study_outputs wywołuje solution_set::publish_open_study_solution: ten consumer odczytuje manifest/observation_source i obecnie nadaje manifest artifact schema stałą v3. Musi mieć jawny V4 descriptor/schema dispatch w tym samym atomie. Może zachować root/index jako Diagnostic/Other pod istniejącym SolutionSet ownerem, bez nowego dataset store. Nie przypisywać końcowego AcceptedStateId wszystkim wcześniejszym history frames: index ma exact sample clocks, ale bez historycznych czterech carriers nie dowodzi AcceptedStateId każdej próbki.


(cd-terminal-accepted-bundle-hook)=
### 14.7. Terminal-only accepted bundle po rzeczywistym writer drain

Status całego rozdziału: **planned_contract; implementacja i runtime NOT VERIFIED**.
Bieżący reference.rs wylicza końcowy accepted snapshot w ogonie wykonania, lecz lib.rs
wywołuje ArtifactPipeline::finish dopiero po powrocie reference i drop engine/workflow.
Obecnie NIE istnieje hook jednocześnie po tym join i przed drop stanu. Actual accepted worker wywołuje run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root -> run_planned_problem_with_live_preview_artifact_context, którego finish jest obecnie przy4230. CLI headless callback prowadzi przez run_planned_problem_with_callback_artifact_context (finish przy3671); plain wrapper ma odrębny finish przy3058. Wdrożenie musi podłączyć ten sam terminal contract do wszystkich trzech realnych callerów, nie tylko pierwszego wyszukanego finish. Numery są wyłącznie wskazówką source-read, stabilną tożsamością są te funkcje.
Nie rozwiązuje się tego serializacją raw preimages przy każdym StepStats/callback.

Planowany jeden internal terminal barrier callback jest przekazywany do CPU reference
z run_planned_problem_* ownera. Reference po ostatnim record_final_outputs,
final provenance ACK i ArtifactRecorder::finish, gdy nie wykona już enqueue, wywołuje
callback dokładnie raz. Callback wywołuje ISTNIEJĄCY ArtifactPipeline::finish
(Shutdown, flush, frames_index.finish, autosave finish i join), sprawdza błąd oraz
zachowuje rzeczywisty ArtifactPipelineSummary w callerze. Reference dopiero po sukcesie
bariery materializuje jeden terminal bundle z nadal żywych problem/state/workflow
oraz otrzymanego pełnego stage lifecycle context. Bez dodatkowego solve, kopii w
per-step hooku lub serializacji czterech raw preimages w pętli. Lib nie wywołuje
ponownie finish ani nie zastępuje zachowanego summary pustym defaultem.
Przy wcześniejszym błędzie solvera istniejący caller nadal wykonuje cleanup finish
i zachowuje oba błędy. Brak stream writer/drain w nowej ścieżce oznacza brak publikacji
V4, nie fikcyjną empty coverage.

W obecnym artifacts::write_artifacts scalars nie są ponownie zapisane, jeżeli summary
ma scalar_rows_written>0, a streaming field_snapshots nie zawierają wszystkich M.
Collector hash/seal sprawdza final raw bytes po końcowym write_artifacts, przed
publikacją; nie traktuje wcześniejszej wartości hash jako ważnej po provenance rewrite.
Terminal bundle i output inventory muszą zgadzać się co do accepted clock/cursors,
ale serializacja preimages wykonuje się raz, a walidacja IO może czytać kolejno samples.
Planned hook nie zmienia żadnego dotychczasowego trial/accepted callback contract.

(cd-headless-frozen-lineage)=
### 14.8. Jawny właściciel historycznego FrozenActivationSet w headless

Actual owner istnieje w InteractiveRuntime i interactive_runtime_host, gdzie mapa
przechodzi przez rebuild/stage transition. CLI headless stage loop i accepted worker
uruchamiają świeże reference wykonania. AcceptedWorkerStep, ResolvedTaskInput,
RunResult i ExecutedRun nie niosą pełnej mapy nieaktywnych constraintów. Sam frozen child
bieżącego planu lub obecne active IDs nie dowodzą historii. W związku z tym C+D dla
frozen across stages wymaga JAWNEGO rozszerzenia ownera, nie eksportu pustego setu.

Planowany stage-lifecycle owner jest częścią istniejącego runtime-control admission
oraz CLI stage orchestration, nie engine ani publishera. Jego wejście jest lineage
konkretnego fizycznego state-input, nie globalny mutable set całego runu/DAG. Dwa
odgałęzienia tej samej źródłowej magnetyzacji dziedziczą ten sam historyczny set i
rozwijają go niezależnie; sprzeczne multiple state-input lineages odmawiają tej ścieżki,
zamiast scalać mapy epok lub zgadywać kolejność z task IDs.

NOWY proposed metadata binding FrozenStageContextRefV1 w ordinary ResolvedTaskInput.v5:

| Pole | Typ | Default | SI | Warunek i właściciel |
|---|---|---|---|---|
| schema_version | literal frozen_stage_context_ref.v1 | required | $1$ | strict version |
| run_id, stage_id, case_id | String | required | $1$ | exact admitted lineage, stage istniejący validator |
| entry_kind | enum fresh_authored_root, continued_stage | required | $1$ | actual stage entry; exact resume pozostaje osobnym przyszłym dispatch |
| context_object_ref | Hex64 | required | $1$ | CAS raw strict context; immutable Prepare/admission owner |
| context_sha256 | Hex64 | required | $1$ | równe SHA bytes i CAS ref |
| context_byte_count | u64 | required | $1$ | bounded actual length |
| source_manifest | existing manifest binding or null | required-nullable | $1$ | null WYŁĄCZNIE dowiedziony fresh authored root |

Raw context nie tworzy drugiego modelu epok: jest strict rekordem
`schema_version=frozen_stage_context.v1, entry_kind, previous_activation_set:existing FrozenSpinsActivationSet,
prepared_activation_set:existing FrozenSpinsActivationSet, previous_frozen_child:existing FrozenSpinsCheckpointV1|null,
source_stage_id:String|null, target_stage_id:String`. Każdy klucz required, nullable jawne;
SI wszystkich identyfikatorów/revisions/epochs to $1$. Child null legalny tylko bez
aktywnego planu w źródłowym etapie; previous set pozostaje pełny nawet wtedy.
Source previous child/activation bytes pochodzą z właściwego opublikowanego snapshot V2
manifestu fizycznego state-input, ze sprawdzeniem prób/epoch/raw SHA/carriers, nie
z aktualnego display/preview albo listowania katalogu. Original source problem/plan
pochodzi z immutable accepted study, nie jest zastępowany target planem.

Dla fresh authored root owner dowodzi braku wcześniejszej physical continuation
przez immutable study binding i jawnie inicjuje pustą historię. Jest to jedyne legalne
utworzenie początkowego setu, nie fallback missing source. Na rzeczywistym NOWYM
stage-entry owner stosuje istniejące FrozenSpinsActivationSet::prepare_transition
lub jawne prepare_reactivation dokładnie raz i zapisuje prepared context razem z
immutable Prepare/admission snapshot. Replay/retry czyta utrwalone przygotowanie,
nie zwiększa rewizji ponownie. ExactRestore, terminal producer i cold reader NIE
wywołują prepare_transition/default. Dla niezmienionego aktywnego zestawu policy
rewizji musi odpowiadać istniejącemu ownerowi przejścia, nie arbitralnemu każdemu getterowi.

Headless reference otrzymuje jawny typed context obok planu i korzysta z istniejącego
FrozenSpinsState/ExchangeLlgProblem stage transition, aby zachować reference stale
aktywnych DOF. Kontrola samej mapy epok nie wystarcza: previous child jest potrzebny
dla reference na overlap. Obecny transition_at_activation już zachowuje reference
na części wspólnej masek; deactivate zachowuje historię, a re-entry tworzy nową epokę.
Prepared activation set musi być zgodny z rzeczywiście zainstalowanym engine frozen
state przed pierwszym solve. W przypadku inactive->active nowo captured reference
wiąże się z prepared pełną mapą przez istniejący strict from_checkpoint_with_activation_set
oraz restore owner, bez redefiniowania semantyki capture. Brak geometry/topology/source
zgodności odmawia stage continuation, bez silent recapture lub portable import.

CLI posiada jawny process-local lifecycle value przy swojej faktycznej pętli stages;
odczytuje terminal accepted package poprzedniego etapu i przekazuje context następnemu
w ramach tej samej state continuation. Zapisane state/activation pochodzą z solvera,
nie z optional preview runtime. Cold CLI restart wymaga tego samego immutable source
bindingu; brak niego odmawia, nie startuje mapy od epoch1.

Runtime-control posiada ten sam lifecycle przy resolve/admission: binding jest
utrwalony w ResolvedTaskInput.v5/immutable Prepare i istniejącym
commit_task_admission_with_inputs. Raw context CAS jest INPUT artifact osiągalnym
z admission snapshot; nie wymaga drugiego output publishera. Typed inspection i oba
walkers muszą utrzymać tę krawędź oraz source manifest/child; unknown refs fail closed.
Obecne capture_admission_inputs serializuje wyłącznie BTreeMap<String,ResolvedInput> w resolved_inputs_snapshot.v1 i nie
posiada tej semantyki: to planowana konsumowana zmiana, nie aktualne API.

Planowana ordinary ResolvedTaskInput.v5 ma required frozen_stage_context:FrozenStageContextRefV1 dla nowego C+D M3, również gdy frozen aktualnie nieaktywne. Nie ukrywamy context w reserved authored input map. Existing resolved_inputs_snapshot.v1 hashuje samą mapę inputs i pozostaje bez zmian. NOWY resolved_inputs_snapshot.v2 required fields: schema_version literal, inputs:existing bounded map, frozen_stage_context:FrozenStageContextRefV1, content_sha256:Hex64. Hash to canonical_json_sha256 typed obiektu {inputs,frozen_stage_context}; snapshot ma dotychczasowy metadata budget128KiB i entry bound256 dla authored inputs. Przy commit_task_admission_with_inputs owner zachowuje ten V2 snapshot i dokładne raw context CAS bytes; to istniejący admission transaction owner, nie osobny równoległy receipt. Replay porównuje cały prepared context binding, a load_accepted_worker_step/publish_accepted_task_prepare konsumują ten sam snapshot. Obecny input/protocol v4 closed-loop pozostaje nietknięty; v5 wymaga jawnego version dispatch bez PauseCheckpoint na tym terminal-only etapie.
Proposed scope rozszerza terminal C+D15 co najmniej o runner/types.rs,
runner/constraints/activation.rs (typed context i istniejący lifecycle contract),
application/execution.rs (ordinary input/protocol v5 binding), runtime-control/claim.rs,
runtime-control/frozen_stage_lifecycle.rs (nowy moduł konsumowany przez study/admission)
i cli/orchestrator.rs (headless stage owner). Razem proposed21 ścieżek, do review przed
kodem. Session existing admission types/inspection/walkers należą już do C+D15.
Engine public strict restore/transition API pozostaje reuse; ewentualna potrzeba
wąskiego instalatora jest osobnym jawnym review scope, nie ukrytym nowym Context.
Nie przycinamy celu frozen across stages; bez tego ownera nie kwalifikujemy C+D frozen.

(cd-terminal-wire-parameters)=
### 14.9. Wspólne typy, jednostki i niezmienność

| Typ/pole | Znaczenie | SI | Domyślność i walidacja |
|---|---|---|---|
| time_s, solver_dt_s, origin_s, last_sampled_time, next_time | physical clock/cadence | $\mathrm{s}$ | required finite; dt>0 dla accepted kroku, initial sample może używać obecnego initial convention |
| clock/digest, state_digest, magnetization_digest | istniejące canonical identity | $1$ | required; existing accepted_state_digests, bez zmiany V1 hash |
| magnetization i frozen reference | znormalizowany kierunek | $1$ | dokładne accepted bits; bez normalize przy restore |
| quantity_id, unit, projection | katalog obserwowalnych i jednostka danego pola | zgodnie z istniejącym quantity catalog | required exact actual producer; nie przypisywać jednej jednostki wszystkim kolumnom scalar row |
| row/count/index/epoch/revision/byte_count/offset | liczby próbek, tożsamość i rozmiar | $1$ | required checked u64/usize; bez overflow/truncation |
| Hex64, Sha256, artifact_id, carrier_id | digest/storage labels | $1$ | bare64 albo sha256:64 jak w polu, dokładny owner/codec |

Wszystkie NOWE metadata rekordy strict deny_unknown_fields i raw duplicate-key reject;
required-nullable bez serde defaults/skip. Ciężkie raw payloads mają istniejący
producer format i typed bounded decoder, nie inline Vec historii. Snapshot semantic
metadata max64KiB; root/page max4MiB, page<=8192 samples i root<=16384 pages, raw scalar
row<=4096B; admitted checked sum/output/grid budgets obowiązują dodatkowo. Limity są
propozycją dla nowego codec, nie twierdzeniem o obecnym readerze. Source-only status
nie zmienia execution/capability, Python DSL, ProblemIR ani wcześniejszych dowodów.

### 14.10. Pełne tabele nowych wymaganych rekordów C+D

Wszystkie poniższe pola są required; required-nullable zaznaczono jawnie. Brak implicit default. Wspólne zagnieżdżone typy reuse §13/istniejących canonical ownerów, bez ponownej definicji fizyki. Identyfikatory, hashe, metadata i liczby mają jednostkę $1$; physical time/dt $\mathrm{s}$. Wartości sample mają jednostkę istniejącego quantity catalog.

#### SemanticCarrierV2 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `carrier_id` | String: dokładny jeden z czterech ID | required | $1$ |
| `value_digest` | Sha256: existing semantic hash | required | $1$ |
| `codec_id, codec_version` | String: closed role codec | required | $1$ |
| `preimage_sha256` | Hex64: raw preimage bytes SHA | required | $1$ |
| `byte_count` | u64: exact raw preimage bytes | required | $1$ |

#### FdmCpuAcceptedStateSnapshotV2 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal fullmag.fdm.cpu.accepted-state-snapshot.v2 | required | $1$ |
| `clock` | existing ObservationClock | required | time/dt $\mathrm{s}$, krok $1$ |
| `clock_digest, state_digest, magnetization_digest` | Sha256: existing clock/carriers/M algorithms | required | $1$ |
| `primary_carriers` | Vec<SemanticCarrierV2>: exactly4 unique sorted | required | $1$ |

#### PublishedCarrierBindingV2 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `semantic fields` | wszystkie required SemanticCarrierV2 bez zmiany wartości | required | $1$ |
| `artifact_id` | Id: publisher owner-qualified | required | $1$ |
| `object_ref, content_sha256` | Hex64: równe preimage_sha256 i verified CAS SHA | required | $1$ |

#### ObservationSourceV2 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version, adapter_id, snapshot_schema_version` | literals observation_source.v2, fdm_cpu_observation.v2, fullmag.fdm.cpu.accepted-state-snapshot.v2 | required | $1$ |
| `accepted_state_ref` | existing AcceptedStateRef: actual publisher claim generation | required | $1$ |
| `snapshot_artifact_id, snapshot_object_ref` | Id, Hex64: exact semantic snapshot bytes | required | $1$ |
| `state_codec_id, state_codec_version` | existing fullmag.runner.field_json/v1 | required | $1$ |
| `state_artifact_id, state_object_ref` | Id, Hex64: final state bytes | required | $1$ |
| `grid_cells, quantity_ids` | existing [u32;3], [m] | required | $1$ |
| `primary_carriers` | Vec<PublishedCarrierBindingV2>: exact semantic agreement | required | $1$ |

#### HistoryIndexV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal study_output_history_index.v1 | required | $1$ |
| `stream_id, quantity_id, unit` | String: exact producer/canonical quantity projection | required | $1$ |
| `collection` | enum scalar,field | required | $1$ |
| `sample_count` | u64: complete count, checked sum pages | required | $1$ |
| `pages` | Vec<HistoryPageBindingV1>: contiguous ordinal coverage | required | $1$ |

#### HistoryPageBindingV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `first_ordinal, sample_count` | u64: contiguous page range | required | $1$ |
| `artifact_id` | Id: same attempt page owner | required | $1$ |
| `object_ref, content_sha256` | Hex64: exact verified page SHA | required | $1$ |
| `byte_count` | u64: actual bounded bytes | required | $1$ |

#### HistoryPageV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal study_output_history_page.v1 | required | $1$ |
| `stream_id` | String: same index stream | required | $1$ |
| `first_ordinal` | u64: same page binding | required | $1$ |
| `samples` | Vec<HistorySampleV1>: bounded <=8192 | required | $1$ |

#### HistorySampleV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `ordinal, step` | u64: contiguous index, actual accepted sample step | required | $1$ |
| `time_s, solver_dt_s` | finite f64: exact writer job clock | required | $\mathrm{s}$ |
| `causes` | Vec<SampleCauseV1>: unique actual emission causes | required | $1$ |
| `payload_codec_id, payload_codec_version` | closed current-byte codec + v1 | required | $1$ |
| `artifact_id` | Id: owner-qualified leaf, same attempt | required | $1$ |
| `object_ref, content_sha256` | Hex64: exact raw leaf bytes SHA | required | $1$ |
| `byte_count` | u64: exact bounded leaf bytes | required | $1$ |

#### SampleCauseV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `tag` | enum initial,final,default_scalar,scheduled | required | $1$ |
| `scheduled.output_index, scheduled.schedule_index` | u64: exact resolved schedule indices; absent in other variants | required | $1$ |

#### HistoryIndexBindingV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `stream_id` | String: unique manifest history root | required | $1$ |
| `artifact_id` | Id: same attempt index owner | required | $1$ |
| `object_ref, content_sha256` | Hex64: exact raw index SHA | required | $1$ |
| `byte_count` | u64: bounded root bytes | required | $1$ |

#### HistoryCoverageV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `collection` | enum scalar,field,default_scalar | required | $1$ |
| `output_index, schedule_index` | u64 or null: required-nullable; null only default | required nullable | $1$ |
| `name, history_stream_id` | String: exact schedule and manifest history root | required | $1$ |
| `projection` | tagged field or scalar_column {column_index:u64,column_name:String} | required | $1$ |
| `sample_count` | u64: actual cause-filtered referenced samples | required | $1$ |
| `first_sample_time_s, last_sample_time_s` | f64 or null: required-nullable; both null only zero count | required nullable | $\mathrm{s}$ |

#### OutputCoverageV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal study_output_coverage.v1 | required | $1$ |
| `origin_s` | finite f64: original stage schedule origin | required | $\mathrm{s}$ |
| `configuration_sha256` | Hex64: exact resolved outputs | required | $1$ |
| `scalar_schedules, field_schedules` | existing Vec<CompositeOutputCursorV2> | required | $1$ |
| `default_scalar_last_sampled_time_s` | f64 or null: required-nullable actual last default sample | required nullable | $\mathrm{s}$ |
| `initial_sample_committed, final_sample_committed` | bool: actual emitted sample facts | required | $1$ |
| `streams` | Vec<HistoryCoverageV1>: unique complete stream keys | required | $1$ |

#### StudyOutputManifestV4 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal study_output_manifest.v4 | required | $1$ |
| `run_id, task_id, step_id, attempt_id` | existing String IDs with same owner validators | required | $1$ |
| `ownership_epoch` | u64 >0 actual publishing claim | required | $1$ |
| `accepted_state_ref` | existing AcceptedStateRef, required non-null | required | $1$ |
| `observation_source` | ObservationSourceV2, required non-null | required | $1$ |
| `outputs` | Vec<existing FmsStudyOutputManifestEntry>: complete declared terminal outputs | required | $1$ |
| `publication_kind` | completed only in first C+D atom; checkpoint_prefix deferred | required | $1$ |
| `historical_prefix` | required null in first C+D atom; historical binding deferred | required | $1$ |
| `coverage` | OutputCoverageV1: actual emitted outputs; never empty substitute | required | $1$ |
| `histories` | Vec<HistoryIndexBindingV1>: complete emitted implicit/default/explicit history | required | $1$ |

#### FrozenStageContextV1 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal frozen_stage_context.v1 | required | $1$ |
| `entry_kind` | enum fresh_authored_root,continued_stage | required | $1$ |
| `previous_activation_set, prepared_activation_set` | existing strict FrozenSpinsActivationSet: full historical and exactly prepared set | required | $1$ |
| `previous_frozen_child` | existing FrozenSpinsCheckpointV1 or null: required-nullable iff source inactive | required nullable | $1$ |
| `source_stage_id` | String or null: required-nullable iff fresh root | required nullable | $1$ |
| `target_stage_id` | String: actual admitted target stage | required | $1$ |

#### ResolvedInputsSnapshotV2 — planned_contract

| Pole | Typ / walidacja i semantyka | Default | SI |
|---|---|---|---|
| `schema_version` | literal resolved_inputs_snapshot.v2 | required | $1$ |
| `inputs` | existing bounded authored input map; no reserved lifecycle key | required | $1$ |
| `frozen_stage_context` | FrozenStageContextRefV1: required non-null C+D lifecycle binding | required | $1$ |
| `content_sha256` | Hex64: canonical {inputs,frozen_stage_context} hash | required | $1$ |

(frozen-v1-output-lifecycle-bridge)=
## 14.11. Jawny most state-output z pełną historią frozen — prerejestracja

Status: `planned_contract`, kandydat źródłowy bez kwalifikacji wykonania. Ten most
jest wymaganym wejściem Relax → M3 oraz etapów z czasowo nieaktywnymi ograniczeniami.
Nie zastępuje checkpointu M3, nie przywraca ExactResume i nie zmienia hash identity V1.
Nie dodaje fizyki, publicznych parametrów Python ani pól `ProblemIR`.

W istniejącym manifeście outputów V3 wolno zarejestrować wyłącznie jawny tuple
`state|initial_state` + `fullmag.runner.frozen_state_json` + `v1`. Stary
`fullmag.runner.field_json@v1` pozostaje bez zmian; brak nowego tuple nigdy nie
uruchamia domyślnej rekonstrukcji historii. C+D z observation V2 nadal wymaga
atomowej publikacji manifestu V4 z rzeczywistym pokryciem serii i oboma czytnikami.
Most V3 nie może publikować fałszywej observation V2 ani pustej coverage.

| Pole envelope | Typ / wymaganie | Jednostka SI | Owner / kontrola |
|---|---|---|---|
| `schema_version` | required string, dokładnie `fullmag.frozen_state_output.v1` | $1$ | strict application decoder |
| `state` | required obiekt w istniejącej reprezentacji `fullmag.runner.field_json@v1` | $1$; `values` $1$, czas/dt $\mathrm{s}$ | istniejący decoder M, space/layout/finite/count |
| `frozen_spins` | required-nullable `FrozenSpinsCheckpointV1` | jednostki istniejącego codec; M/reference $1$, czas/dt $\mathrm{s}$ | runner validate_for_plan, exact M/clock i source plan |
| `frozen_activation_set` | required strict `FrozenSpinsActivationSet`, również gdy child null | $1$ | pełna historyczna mapa epoch/revision oraz active IDs |

Envelope ma dokładnie te cztery pola, `deny_unknown_fields` i odrzucanie
zduplikowanych kluczy. `state` jest osadzonym obiektem JSON istniejącego codec,
nie osobnym byte blobem ani osobnym CAS ref. Producer może przekazać sprawdzony
fragment przez `RawValue`, lecz kontrakt nie obiecuje zachowania jego osobnych
bytes po parse/serialize. Raw SHA-256 oraz byte count publishera obejmują cały
opublikowany envelope. Tożsamość nested M jest walidowana semantycznie przez
istniejący decoder, space/layout oraz dokładne wartości i clock; ewentualny digest
accepted M używa istniejącego semantic ownera, nie hasha ponownie wyrenderowanego
nested JSON. Nie zawiera CAS references. Brak child jest legalny tylko
przy rzeczywiście nieaktywnym planie i pustym active set; mapa historyczna nie
może być null, zgadywana z active IDs, zerowana ani zastąpiona defaultem.
Wszystkie wielkości, epoch i rewizje zachowują definicje V1; nie ma nowego modelu
aktywacji. Nowy root authored może zainicjować pustą mapę dopiero po wykazaniu
braku fizycznego poprzednika. Historia poprzednika pochodzi z opublikowanego
state-output tego samego accepted source stage/port/case, pod istniejącym
katalogiem, zakończonym claimem i manifestem. Sam legacy M-only nie dowodzi braku
historycznych nieaktywnych ograniczeń i nie może być takim poprzednikiem.

Istniejący publisher lease-owned publikuje envelope jak inne state bytes: raw
SHA-256, byte budget i powiązanie artifact ID z run/task/attempt/epoch. Silnik
nie zna CAS ani claimu. `FrozenOutputLifecycleV1` zostaje odczytany jednokrotnie
na terminalnej granicy etapu, po normalnym drain writera i przed drop żywego
problem/state/workflow. Child musi pochodzić z bieżącego stanu terminalnego,
nie starego cache sprzed Relax. Pure-frozen emituje tylko lifecycle; cztery
semantic preimages należą wyłącznie do aktywnego M3. Hooks StepStats i per-step
accepted snapshot nie eksportują pełnej historii.

Jedynym ownerem wyznaczenia docelowych epoch i rewizji jest admission:
wywołuje istniejące `prepare_transition` wyłącznie dla rzeczywistego nowego
wejścia w etap i utrwala wynik w `FrozenStageContextV1` razem z source manifest
binding oraz fizycznymi wejściami. Recovery i ponowienie Prepare dekodują oraz
walidują ten sam zapis; nie przygotowują kolejnej transition ani nie podbijają
epoch. Przed pierwszym solve nowy lokalny runner przywraca poprzedni child i
oryginalny source reference. Istniejący engine stage-transition realizuje na tym
poprzednim stanie dokładnie przejście już wyznaczone przez admission; wynikowa
pełna mapa musi być identyczna z utrwalonym `prepared_activation_set`. Nie jest
to kolejny bump od mapy prepared. Overlap/reference i target mask są sprawdzane
przed solve. Nieudane/retry odtworzenie zaczyna od tych samych poprzednich bytes,
bez zmiany utrwalonej docelowej rewizji. Zmiana etapu nie jest ExactResume.

Odczyt wymaga dwóch jawnych granic: application decoder zwraca odrębny typ
`FrozenMagnetizationState`; runtime-control z runnerem waliduje fizyczny child,
pełną historię i źródłowy plan przed materializacją M. Niezaktualizowani importerzy
odmawiają odrębnego typu; nie traktują go jako zwykłego M ani FEM state.
Typed inspection i oba CAS walkers muszą rozpoznać strict envelope bez refs i
fail closed dla nieznanych embedded references; brak ref nie znosi budżetu bytes.

FDM CPU: planowane, source-only, bez runtime qualification. FDM GPU, FEM CPU,
FEM GPU: poza mostem, odmowa, bez fallbacku. Publiczny ExactResume pozostaje
Unsupported; szersze wymagania M1/M2 i atomowego composite restore są otwarte.

Wymagane bramki: parser/strict schema, missing-null-unknown/duplicate kluczy,
source owner/port/case/hash/count, aktywna i nieaktywna historia, overlap reference
przed solve, jeden drain/terminal hook, bounded decode, oba CAS walkers, cold
reopen oraz rzeczywiste Relax → M3 i deactivate → reactivate. Kontrole statyczne
nie są wykonaniem Rust ani dowodem zachowania fizyki.


(cd-terminal-completion-receipt-clock)=
## 14.12. Aneks prerejestracji: completed receipt V2 i rzeczywisty clock mostu

Status: `planned_contract`; źródła istnieją wyłącznie jako kandydat storage.
Brak Rust compile, wykonania producer/cold reader, HTTP i kwalifikacji. Nie jest
to włączenie ExactResume. M1/M2, GPU, ABM3 oraz publiczne guardy pozostają bez zmian.
Nie ma nowego publicznego parametru Python ani pola `ProblemIR`.

Istniejący jedyny completed-receipt owner zachowuje plik
`worker_execution_completed.v1.json`; jawny `schema_version` wybiera wire.
Historyczny `fullmag.accepted_worker_execution.v1` pozostaje odrębnym strict
rekordem ze starym closed set, serialization i accepted identity. Nowy wariant
nie jest drugim store/receiptem, nie ma fallbacku do V1 i nie uruchamia solve
przy brakujących danych. Required fields nowego strict rekordu:

| Pole V2 | Typ / walidacja | Default | Jednostka SI / znaczenie |
|---|---|---|---|
| `schema_version` | literal `fullmag.accepted_worker_execution.v2` | brak; required | $1$ |
| `identity` | istniejący strict `WorkerExecutionReceiptIdentity`, łącznie z rzeczywistym claim/start/case/plan fingerprint | brak; required | $1$; stara tożsamość polecenia |
| `status` | istniejący `RunStatus`, wyłącznie `Completed` | brak; required | $1$ |
| `completed_step_count` | istniejący licznik runnera `usize`, dodatni | brak; required | $1$; nie zastępuje accepted step |
| `outputs` | `Vec<WorkerExecutionOutputReference>`, complete declared ports, exact raw SHA/count i jawne rzeczywiste codec tuple | brak; required | $1$; byte count to liczba bajtów |
| `accepted_state_ref` | istniejący strict `AcceptedStateRef`, równy manifestowi | brak; required non-null | $1$; hash domain V1 niezmieniony |
| `terminal_publication` | `PreparedTerminalPublicationV4` poniżej | brak; required non-null | $1$ |

| Pole prepared publication | Typ / walidacja | Default | Jednostka SI |
|---|---|---|---|
| `manifest` | strict istniejący w tej prerejestracji `FmsStudyOutputManifestV4`, `completed`, `historical_prefix=null`, rzeczywiste historie | brak; required | $1$; czasy i dt w $\mathrm{s}$ |
| `entries` | `Vec<FmsArtifactCatalogEntry>`, dokładny zamknięty inventory wszystkich declared roles, jeden run/task/attempt/epoch | brak; required | $1$ |

To przygotowane katalogowe metadata pozostaje w istniejącym completed receipt.
Publisher wcześniej zapisuje raw CAS bytes pod rzeczywistym claimem, lecz token
published powstaje dopiero przez istniejący atomic lease-fenced catalog append.
Recovery ponownie sprawdza faktyczne raw bytes, ownera, accepted pakiet i historie,
nie ufa samym digestom/licznikom ani staremu lokalnemu katalogowi. Każdy nowy
system artifact type należy do istniejącej immutable manifest allow-list.
Brak lub null `frozen_stage_context` w nowych ordinary input V5/admission V2
odmawia; historyczne payloady bez pola zachowują dotychczasową reprezentację.

Kontrola historii cold korzysta z tego samego schedule/quantity/layout ownera:
pełny zbiór scalar/field/default logical streams, bounded index/page/leaf reads,
rzeczywiste scalar CSV tokens i field shape/finite/clock, cause-derived coverage.
Końcowe cursory są odtwarzane przez istniejące `advance_due_schedules`, nie nowy
timer. Replay ma jawny budżet operacji wyprowadzony z admitted memory; jego
przekroczenie odmawia dekodowania, nie zmienia cadence ani fizyki.
Metadata snapshot zachowuje $64\,\mathrm{KiB}$, index/page $4\,\mathrm{MiB}$,
a katalog/completed receipt istniejący control-document limit $16\,\mathrm{MiB}$.
Raw leaf/preimage ma dodatkowy limit $64\,\mathrm{MiB}$, aggregate raw count nie
przekracza rzeczywistego admitted storage budget, field leaf również memory/8.
Są to granice tej niekwalifikowanej implementacji; większy plan odmawia publikacji.
Nie wolno przedstawiać ich jako dowodu pełnego paramsetu lub resume.

Istniejący final-state V3 może pochodzić z coalesced scalar clock, np. all-frozen
TimeEvolution bez kroku RHS. **Nie wolno nadpisywać timestampa solvera ani pliku
legacy `m_final.json`.** W nowym envelope wolno materializować tę samą istniejącą
reprezentację nested state, z tym samym exact M/layout/provenance/state_identity,
a `step`, `time`, `solver_dt` z rzeczywistego terminalnego frozen child po
niezależnym sprawdzeniu exact M; sampled step musi być nie większy od
rzeczywistego accepted step. Dawny sampled time
musi być identyczny lub spełniać istniejące `same_time`; brak tego dowodu odmawia.
Ten sam jawny adapter `materialize_study_state_at_terminal_clock` dotyczy
observation raw M: clock pochodzi z aktualnego snapshot V2, a jego exact M/layout
jest następnie porównywane z niezależnym engine/coupled primary. Terminalny port
State musi użyć jawnego lifecycle envelope oraz mieć ten sam M/clock/child/full
activation set co observation; InitialState pozostaje osobnym historycznym wejściem.
Nie renormalizować M, nie zmieniać dense values i nie wyprowadzać clock z
`steps.last()`. `state_identity.v1` wiąże backend/layout/count i pozostaje bez
zmian. Hash/count obejmuje cały nowy envelope; nie obiecuje osobnej raw identity
nested JSON. Gdy child null, nie zgadujemy clock/history z aktywnych IDs ani
prepared defaults. M3 observation V2 nadal przechodzi raw-four terminal validator,
a relacja outer accepted dt do wewnętrznej historii ARS zachowuje §13.

Source owners (kandydat; `planned_contract`):

- `crates/fullmag-api/src/accepted_study_worker.rs` + `WorkerExecutionCompletedReceiptV2`, `collect_terminal_study_publication`, `recover_completed_worker_execution`.
- `crates/fullmag-runtime-control/src/study_output_history.rs` + `prepare_terminal_study_publication`, `validate_committed_history`, `load_study_observation_runtime_v2`.
- `crates/fullmag-runtime-control/src/study.rs` + `publish_terminal_study_outputs` i dotychczasowy lease publisher.
- `crates/fullmag-session/src/typed_documents.rs` + `inspect_terminal_publication`, `inspect_admitted_frozen_context`; oba istniejące walkery w `reachability.rs`.
- `crates/fullmag-application/src/study_artifact.rs` + `encode_frozen_study_state`; `crates/fullmag-runner/src/lib.rs` + `terminal_output_advance_existing_cursor`.

Przed przyjęciem: pełny source review, parser/source controls, następnie nowa
immutable capsule, rzeczywisty Rust compile i fault/cold/HTTP/CLI evidence.
Żaden modelowy przykład JSON/Python nie jest wykonaniem Rust ani kwalifikacją.

Identyfikatory nowej publikacji są sprawdzane cold tą samą formułą
`terminal_publication_artifact_id` co publisher: claim + artifact type + rola +
raw object SHA. Manifest, snapshot, raw state, cztery carriers, indeksy, strony
oraz fizyczne sample mają odrębne jawne role. Projekcje scalar columns celowo
współdzielą fizyczny `scalar-row` o tym samym ordinal; State port zachowuje
istniejącą formułę logical-output ID. Nie zmienia to AcceptedStateId V1.

Kompletność przed publikacją pochodzi z rzeczywistego zakończonego writer
inventory: każda projekcja musi zachować dokładny seal count; final lease append
wiąże powstałe indeksy/strony/leaves do jednego manifestu CAS. Cold reader sprawdza
integralność tego konkretnego grafu, ciągłe ordinale, faktyczne leaves i cause/cursor
zgodność. Nie jest to niezależne ponowne wykonanie solvera ani dowód liczby kroków
wyprowadzony z okresu: istniejące `is_due` ma tolerancję i może przeskoczyć wiele
terminów. `initial_sample_committed` pozostaje faktem globalnym; existing default
scalar initial branch nie zapisuje Initial osobno dla każdego pola. Nie wolno
wymusić fikcyjnego initial sample ani obiecywać ExactResume przez ten terminalny
kontrakt. Zmiana wszystkich stron, rootów i katalogu oznacza inną publikację,
nie zachowanie identity pierwotnego immutable manifestu.
