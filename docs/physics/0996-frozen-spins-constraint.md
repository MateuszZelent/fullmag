# Frozen spins: ograniczenie magnetyzacji

- Status: zatwierdzony kontrakt fizyczny; authoring, typed IR, kompilacja planu, FDM CPU/CUDA runtime oraz FEM CPU P1 RK zaimplementowane i zweryfikowane w zarządzanych recepturach
- Właściciele: Fullmag physics, planner i backend teams
- Ostatnia aktualizacja: 2026-09-16
- Powiązane ADR: `docs/adr/0026-frozen-spins-constraint-and-selection-model.md`
- Powiązane specyfikacje: `docs/specs/selection-expr-v1.md`, `docs/specs/frozen-spins-v1.md`

(frozen-spins-problem-statement)=
## 1. Problem fizyczny

Frozen spins jest holonomicznym ograniczeniem magnetyzacji: wybrane aktywne
magnetyczne stopnie swobody zachowują zapisaną wartość, ale nadal uczestniczą w
pełnej konfiguracji magnetycznej. Mogą generować exchange, demag, DMI i inne
pola oraz wpływać na swobodne sąsiedztwo. Nie wolno modelować tego przez
`alpha=0`, wyzerowanie $\mathbf H_\mathrm{eff}$, usunięcie z energii ani
końcowy clamp wykonywany tylko po zaakceptowanym kroku.

Kontrakt obejmuje relaksację i dynamikę od pierwszej wersji schematu. Bieżący
kod zawiera typed `SelectionExprIR`, publiczny `fullmag.select`,
`MagnetizationConstraintIR::FrozenSpins`, top-level lowering oraz stage
activation. Planner zawiera dense resolved mask i certyfikat dla FDM cell
centers oraz FEM magnetic true DOF. FDM CPU/reference oraz FDM CUDA runtime
konsumują resolved plan i utrzymują final-RHS/candidate-restore invariant
(potwierdzone przez `fullmag.frozen_spins.cuda.runtime.evidence.v1`); natywny
FEM CPU P1 RK konsumuje deskryptor i zeruje RHS oraz rzutuje stan w stepperach
(zweryfikowane przez `fem_frozen_spins_contract`). Poniższe równania pozostają
zatwierdzonym kontraktem runtime.

(frozen-spins-governing-equations)=
## 2. Równania rządzące

Niech $A$ będzie zbiorem aktywnych magnetycznych DOF, $F$ zbiorem zamrożonym,
a $U$ zbiorem swobodnym:

```{math}
:label: eq-frozen-active-partition
F \subseteq A, \qquad U = A \setminus F.
```

Referencyjna magnetyzacja jest twardym ograniczeniem:

```{math}
:label: eq-frozen-constraint
\mathbf m_i(t)=\mathbf m_i^\star,
\qquad i\in F.
```

W dynamice $t$ jest czasem fizycznym w sekundach. Direct minimizers nie
wprowadzają pseudoczasu: PG-BB i NCG używają bezwymiarowego indeksu iteracji
$k\in\mathbb N_0$ i spełniają osobny zapis tego samego inwariantu:

```{math}
:label: eq-frozen-minimizer-constraint
\mathbf m_i^{(k)}=\mathbf m_i^\star,
\qquad i\in F.
```

Energia pozostaje energią pełnej konfiguracji z ustalonymi współrzędnymi
zamrożonymi:

```{math}
:label: eq-frozen-constrained-energy
E_{\mathrm c}(\mathbf m_U)
=E(\mathbf m_U,\mathbf m_F^\star).
```

Backend składa pełną dynamikę przed nałożeniem maski:

```{math}
:label: eq-frozen-assembled-rhs
\mathbf R_i
=\mathbf R_{\mathrm{LLG},i}
+\mathbf R_{\mathrm{STT},i}
+\mathbf R_{\mathrm{SOT},i}
+\mathbf R_{\mathrm{thermal},i}
+\mathbf R_{\mathrm{other},i}.
```

Final-RHS masking jest projekcją po złożeniu wszystkich członów:

```{math}
:label: eq-frozen-final-rhs
\dot{\mathbf m}_i=
\begin{cases}
\mathbf 0, & i\in F,\\
\mathbf R_i, & i\in U.
\end{cases}
```

Każdy stan kandydujący odtwarza referencję:

```{math}
:label: eq-frozen-candidate-restore
\mathbf m^{\mathrm{candidate}}_i \leftarrow \mathbf m_i^\star,
\qquad i\in F.
```

Autorytatywne metryki są redukcjami po $U$. Dla RHS i momentu stopu:

```{math}
:label: eq-frozen-free-reductions
r_{\max,U}=\max_{i\in U}\lVert\mathbf R_i\rVert_2,
\qquad
\tau_{\max,U}=\max_{i\in U}
\lVert\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\rVert_2.
```

Diagnostyczne odpowiedniki po całej aktywnej domenie są liczone przed
nałożeniem constraintu:

```{math}
:label: eq-frozen-all-reductions
r_{\max,A}=\max_{i\in A}\lVert\mathbf R_i\rVert_2,
\qquad
\tau_{\max,A}=\max_{i\in A}
\lVert\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\rVert_2.
```

`max_rhs_all` oznacza $r_{\max,A}$, a `max_torque_all_Apm` oznacza
$\tau_{\max,A}$. Obie redukcje oraz odpowiadające im `free` powstają z tego
samego stanu i rewizji: po wymaganym candidate restore tego stanu i złożeniu
pełnego $\mathbf R_i$, bezpośrednio przed final-RHS masking. Wartości po $A$
są wyłącznie diagnostyczne; wartości po $U$ sterują stoppingiem. Dla
$U=\varnothing$ metryki `free` mają kontraktową wartość zero wraz z jawnym
all-frozen stop reason, zamiast niezdefiniowanego maksimum pustego zbioru.

W tangent-plane implicit zamrożony przyrost jest essential constraintem:

```{math}
:label: eq-frozen-tpi
\mathbf v_i=\mathbf 0,
\qquad i\in F.
```

Termika nie zmienia reguły. Losowe pole może zostać wygenerowane na całym
$A$, ale $\mathbf R_{\mathrm{thermal},i}$ jest częścią pełnego $\mathbf R_i$ i
ulega finalnemu maskowaniu. Numeracja RNG swobodnych DOF nie może zależeć od
liczności $F$. STT i SOT są maskowane dopiero po ich dodaniu; frozen spin może
pozostać źródłem wartości sąsiada w stencilach swobodnych DOF.

(frozen-spins-symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $A$ | Aktywne magnetyczne stopnie swobody | $1$ |
| $F$ | Zamrożone aktywne stopnie swobody | $1$ |
| $U$ | Swobodne aktywne stopnie swobody | $1$ |
| $i$ | Indeks magnetycznego DOF | $1$ |
| $t$ | Czas fizyczny wyłącznie w stage dynamiki | $\mathrm{s}$ |
| $k$ | Indeks iteracji direct minimizer, nie czas | $1$ |
| $\mathbf m_i$ | Zredukowana magnetyzacja DOF | $1$ |
| $\mathbf m_i^{(k)}$ | Zredukowana magnetyzacja DOF w iteracji minimizatora k | $1$ |
| $\mathbf m_i^\star$ | Referencyjna zredukowana magnetyzacja zamrożonego DOF | $1$ |
| $\dot{\mathbf m}_i$ | Fizyczna pochodna magnetyzacji po czasie w dynamice | $\mathrm{s^{-1}}$ |
| $\mathbf m_i^{\mathrm{candidate}}$ | Stan kandydujący przed przywróceniem zamrożonej referencji | $1$ |
| $\mathbf m_U$ | Stan magnetyzacji na swobodnej domenie | $1$ |
| $\mathbf m_F^\star$ | Referencyjny stan magnetyzacji na zamrożonej domenie | $1$ |
| $R$ | Zadany promień tekstury bimeronu | $\mathrm{m}$ |
| $F_R$ | Maska frozen spins dla zadanego promienia tekstury | $1$ |
| $U_R$ | Swobodne DOF poza maską frozen spins | $1$ |
| $R_\mathrm{area}$ | Promień z pola wybranej składowej odwróconej magnetyzacji | $\mathrm{m}$ |
| $R_\mathrm{core}$ | Pomocniczy promień wyznaczony z położeń rdzeni | $\mathrm{m}$ |
| $m_x$ | Składowa x zredukowanej magnetyzacji | $1$ |
| $b$ | Znak tła magnetyzacji, równy +1 lub -1 | $1$ |
| $C$ | Wybrana składowa obszaru odwróconej magnetyzacji | $\mathrm{m^2}$ |
| $\operatorname{area}$ | Pole geometryczne obszaru w płaszczyźnie | $\mathrm{m^2}$ |
| $\pi$ | Stała koła | $1$ |
| $E$ | Pełna energia mikromagnetyczna | $\mathrm{J}$ |
| $E_{\mathrm c}$ | Energia ograniczona jako funkcja swobodnego stanu | $\mathrm{J}$ |
| $E_\mathrm{bg}$ | Energia zbieżnego, niezależnego tła o zadanym znaku | $\mathrm{J}$ |
| $\Delta E$ | Energia nadmiarowa względem tła | $\mathrm{J}$ |
| $T_f$ | Maksymalny moment po free DOF przeliczony na T | $\mathrm{T}$ |
| $\mu_0$ | Przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $\epsilon_E$ | Względny rozrzut energii w końcowym oknie | $1$ |
| $\epsilon_{\Delta E}$ | Rozrzut okna względem skali energii nadmiarowej | $1$ |
| $E_j$ | Energia próbki końcowego okna | $\mathrm{J}$ |
| $E_\mathrm{floor}$ | Minimalna skala używana w mianowniku kryterium nadwyżki energii | $\mathrm{J}$ |
| $j$ | Indeks próbki końcowego okna | $1$ |
| $\mathbf R_i$ | Pełny złożony RHS magnetyzacji | $\mathrm{s^{-1}}$ |
| $\mathbf R_{\mathrm{LLG},i}$ | Składnik RHS LLG | $\mathrm{s^{-1}}$ |
| $\mathbf R_{\mathrm{STT},i}$ | Składnik RHS STT | $\mathrm{s^{-1}}$ |
| $\mathbf R_{\mathrm{SOT},i}$ | Składnik RHS SOT | $\mathrm{s^{-1}}$ |
| $\mathbf R_{\mathrm{thermal},i}$ | Składnik RHS wynikający z termiki | $\mathrm{s^{-1}}$ |
| $\mathbf R_{\mathrm{other},i}$ | Inny aktywny składnik RHS | $\mathrm{s^{-1}}$ |
| $r_{\max,U}$ | Maksymalna norma RHS po swobodnych DOF | $\mathrm{s^{-1}}$ |
| $r_{\max,A}$ | Maksymalna norma pełnego pre-constraint RHS po aktywnych DOF (`max_rhs_all`) | $\mathrm{s^{-1}}$ |
| $\mathbf H_{\mathrm{eff},i}$ | Efektywne pole magnetyczne | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max,U}$ | Maksymalny moment $\lVert\mathbf m\times\mathbf H_\mathrm{eff}\rVert$ po swobodnych DOF | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\max,A}$ | Maksymalny pre-constraint moment po aktywnych DOF (`max_torque_all_Apm`) | $\mathrm{A\,m^{-1}}$ |
| $\mathbf v_i$ | Prędkość tangent-plane | $\mathrm{s^{-1}}$ |

(frozen-spins-assumptions-and-validity)=
## 4. Założenia, przybliżenia i zakres ważności

1. $F$ jest podzbiorem aktywnej domeny magnetycznej. Raw authored selection
   poza nią podlega `inactive_selection`: może zostać ostrzeżona i przecięta z
   $A$ albo odrzucona. Resolved/runtime/checkpoint mask z bitem poza $A$ jest
   zawsze twardym błędem inwariantu.
2. V1 wspiera członkostwo `static` oraz `snapshot_at_activation`. Geometry-only
   AST domyślnie normalizuje się do `static`, a każde AST zależne od stanu do
   `snapshot_at_activation`. Jawne `static` dla state-dependent AST jest
   nielegalne; jawne `snapshot_at_activation` jest legalne dla obu klas.
   Predykaty zależne od magnetyzacji są oceniane atomowo przy początku epoki i
   nie zmieniają członkostwa w jej trakcie.
3. Domyślna referencja `capture_current_at_activation` przechwytuje kanoniczny
   stan solvera po jego zwykłej normalizacji i walidacji. Constraint nie
   wykonuje drugiej, niezależnej normalizacji.
4. Magnetyzacja jest pełnym trójskładnikowym constraintem. Częściowe
   zamrożenie jednej składowej nie należy do V1.
5. `disk` w domenie 3D jest skończonym cylindrem o jawnej grubości albo
   skończoną ekstruzją przez bounds obiektu. Idealny okrąg 2D o zerowej
   grubości nie wybiera objętościowych DOF.
6. Zwykłe float `==` nie należy do V1; wymagane są `approx` lub `between`.
7. Imported CAD jest unsupported combinations w strict mode do czasu osobnej
   kwalifikacji point-in-solid.
8. Zmiana topologii unieważnia resolved mask. V1 nie wykonuje niejawnej
   reprojekcji przy restarcie.
9. Direct minimizers PG-BB i NCG są indeksowane przez bezwymiarowe $k$; ich
   iteracji nie wolno raportować jako czasu ani pseudoczasu w sekundach.

(frozen-spins-auxiliary-transport-time)=
### 4.1. All-frozen z aktywnym transportem — prerejestracja

**Stan: `planned_contract`, runtime `NOT VERIFIED`.** Ograniczenie
$\mathbf m_F=\mathbf m_F^\star$ nie zamraża niemagnetycznych pól transportu.
Czysto magnetyczny all-frozen zachowuje no-op oraz zero wykonanych kroków;
TimeEvolution z aktywnym transportem wymaga istniejących fizycznych kroków
coupled przy dokładnie odtwarzanym M. Dotyczy to także stałego benchmarku:
nie wolno deklarować accepted transport na podstawie samego skoku zegara.

Dla M1/M2 transport jest quasistatic względem aktualnego napędu, nie stały
w czasie; M3 zachowuje niezależną historię spinową. Wspólny kontrakt błędu
na free torque-target scope, w tym pusty support, należy do
`0970-spin-hall-drift-diffusion-transport.md` →
`spin-transport-frozen-free-error-support`. Nadal oblicza się pełne fizyczne
pola, torque i bilanse; projekcja dotyczy wpływu błędu na swobodne M.

Nie zmienia się API ani schematu: `FrozenSpins` i `constraints` etapu
obniżają się do `magnetization_constraints` oraz resolved mask/reference;
`StudyStagesBuilder.add_run` zachowuje `StudyIR::TimeEvolution`,
`DynamicsIR::Llg`, `TimeStageContextIR` i istniejące solver policies.
Requested intent i resolved execution muszą zachować te same identyfikatory
stage/constraint/transport oraz lane. Validation errors/unsupported combinations
nie mogą zamieniać M3 na steady, CPU na GPU ani Relax na TimeEvolution.

| Solver | Device | Rozszerzenie all-frozen + transport |
|---|---|---|
| FDM | CPU | Prerejestrowane FP64: fixed Heun M1/M2 i ARS M3; wymagane osobne runtime gates, `NOT VERIFIED` |
| FDM | GPU | Brak kwalifikacji tej kombinacji; brak dziedziczenia kwalifikacji samego constraintu |
| FEM | CPU | Brak kwalifikacji tej kombinacji; brak dziedziczenia kwalifikacji samego constraintu |
| FEM | GPU | Brak kwalifikacji tej kombinacji; brak fallbacku |

Istniejące `accepted_steps/rejected_steps`, `step_count`, `StepStats.time/dt`
i accepted snapshot wskazują prawdziwe fizyczne kroki, nie liczbę zmienionych
magnetycznych DOF. Stage/harmonogram pozostaje jednym właścicielem czasu:
source breakpoints, outputs, partial endpoint, pause/cancel oraz checkpoint
muszą wskazywać ten sam zaakceptowany stan. Dokładne reguły są zapisane w
`docs/specs/frozen-spins-v1.md::frozen-v1-all-frozen`.

Relax z aktywnym niekonserwatywnym torque pozostaje odrzucony. Relax+M3,
także bez torque, jest w tej prerejestracji unsupported do czasu osobnego
kontraktu zbieżności transportu; zero free magnetic torque nie jest takim
kryterium. Nie dodaje się minimizatorowi czasu ani nowego transport solvera.

Wymagane dowody przed kwalifikacją: exact-fixed M we wszystkich candidates;
accepted V/J/mu/Q i bilanse dla aktualnego źródła; M2 zero/partial free support;
M3 spin-history i full/two-half LTE; pulse/PWL source/output event oraz
niecałkowity endpoint/dt; late-failure/rollback; pause/cancel; restart maski,
reference i historii. Osobno zachować regression no-transport all-frozen.

(frozen-spins-composite-resume-v2)=
### 4.2. Composite checkpoint v2 i ExactResume — prerejestracja

**Publiczna odmowa A: `IMPLEMENTED_SOURCE_ONLY`, `NOT_COMPILED`,
`NOT_EXECUTED`.** Wspólny runner-owned
`validate_fdm_transport_checkpoint_resume_support` odmawia publicznego
ExactResume rzeczywistego CPU workflow M1/M2/M3, również z frozen spins. Jego
`Ok(())` oznacza tylko brak tej konkretnej odmowy, nie pozytywny admission
formatu lub tożsamości. API klasyfikuje te checkpointy jako `RestoreClass::Unsupported`
(`unsupported`) i odmawia restore przed odczytem common state oraz mutacją;
CLI odmawia przed pobraniem paused state przez `take()`, a UI dopuszcza restore
wyłącznie dla `exact_resume`. Nie ma automatycznego downgrade do
InitialConditionImport, LogicalResume ani portable importu.

Istniejąca, ograniczona kontynuacja stanu solvera nonfrozen M3 V1 pozostaje
w `execute_reference_fdm_with_coupled_checkpoint` oraz istniejących Rust
`resume_reference_fdm_from_coupled_checkpoint` i
`resume_reference_fdm_from_coupled_checkpoint_evidence`. Wyjątek wymaga schematu
`fullmag.fdm.coupled_m3_checkpoint.v1`, braku resolved frozen planu i workflow
transient. Pełny walidator V1 oraz porównanie kompletnej identity/module history
pozostają obowiązkowe przed zmianą lokalnego workflow. Caller przekazuje
niezmieniony oryginalny plan i endpoint; V1 sam nie utrwala endpointu ani
committed output prefix/cursorów. To zachowanie solvera nie jest publicznym
ExactResume. API, CLI i orchestrator zachowują powyższą odmowę. Pozytywna
regresja porównuje final M, accepted artifact i ostatni wiersz; nie kwalifikuje
pełnej historii wyjść ani frozen+M3. Bieżąca poprawka kompatybilności jest
`IMPLEMENTED_SOURCE_ONLY`; nowe regresje są `NOT_COMPILED`, `NOT_EXECUTED`.
Pełne E11/composite restore pozostaje OPEN.

Nie dodano globalnej odmowy pure-magnetic/frozen/ABM3 bez spin workflow;
GPU/FEM zachowują własnych ownerów i bramki. Pozostała klasyfikacja katalogu
API nadal korzysta z dotychczasowego self-compatibility; A nie naprawia jej
zgodności z aktualną identity. Prywatny codec i original-stage gate B nie są
pozytywnym admission. Full v2 carriers/generation, activation/spin history,
immutable original context, committed outputs/CAS prefix i atomowy restore
pozostają OPEN. Dokładna granica publiczna jest w
[specyfikacji API](../specs/resource-first-control-room-api-v2.md#checkpoint-restore-admission).
Nowy wariant wire wymaga oficjalnej generacji OpenAPI/TS z przyszłego managed
pakietu z pinami A; pakiet #80 nie zawiera tej zmiany i jej nie weryfikuje.

**Prywatny codec: IMPLEMENTED_SOURCE_ONLY, NOT_COMPILED, NOT_EXECUTED;
publiczna obsługa codec i integracja ExactResume: planned_contract,
runtime NOT VERIFIED.** Dokładny
format nowych pól, strict ingress, hash, original frames i atomowy restore
ma jednego właściciela w [§13 frozen spec](../specs/frozen-spins-v1.md#frozen-v2-composite-checkpoint).
Prywatne `FdmCompositeCheckpointV2`, `decode_composite_m3_codec_v2` i
`FdmCompositeCheckpointV2::validate_self_contained` istnieją w
`crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs`.
Plan/source/common/carriers/generation oraz rzeczywisty committed output CAS
pozostają contextual gate. Kontrakt nie zmienia publicznego FrozenSpins/constraints i ich
Python→ProblemIR lowering, bez nowej fizyki, Context lub schedulera.

Prywatny `CodecCheckedCompositeV2::validate_for_original_stage` ma status
`SOURCE_ONLY`, `NOT_COMPILED`, `NOT_EXECUTED`: sprawdza oryginalne
problem/plan/stage/outputs przekazane przez admitted ownera. Sam helper nie
dowodzi pochodzenia tych danych z immutable admission ani integracji callera.
Common state, primary carriers/generation, activation history, store/CAS prefix,
atomic restore i publiczne API pozostają OPEN; ExactResume/runtime NOT VERIFIED.

| Solver | Device | Composite v2 ExactResume |
|---|---|---|
| FDM | CPU | Planned reference FP64 M3 ARS fixed/adaptive; runtime NOT VERIFIED |
| FDM | GPU | Unsupported tutaj: brak zgodnego composite ownera, bez fallbacku |
| FEM | CPU | Unsupported tutaj: inne DOF/runtime, brak codec composite |
| FEM | GPU | Unsupported tutaj: brak kwalifikacji tej kombinacji |

Existing FrozenSpinsCheckpointV1 pozostaje ownerem packed mask/reference,
source/topology, lane, M/time/dt/step i ich walidatorów. Nowy wrapper dodatkowo
wymaga istniejącego FrozenSpinsActivationSet: historyczne epoki muszą przeżyć
checkpoint z nieaktywnym stage. Nullable frozen child oznacza wyłącznie brak
aktywnego resolved planu; nie oznacza braku historycznej activation set.
Obecny runtime owner frozen_spins_activation_set oraz międzyetapowy
ensure_interactive_preview_runtime przekazują ten set przy przebudowie runtime.
Capture musi pobrać tę samą accepted rewizję co engine FrozenSpinsState;
brak rzeczywistej historii, również w headless, daje odmowę ExactResume.

Gdy child jest obecny, jego epoki/active IDs/set revision muszą być identyczne
z top-level activation set. M, accepted time, step i rzeczywisty outer dt
zgadzają się z M3/common state bitowo w FP64. Nie naprawia się mismatchu przez
clamp, recapture, ponowną selekcję lub historyczne effective defaults.
prepare_transition nie służy do odtworzenia bieżącego stage; dopiero przyszłe
zwykłe przejście zwiększa epokę przez istniejącego ownera.

Accepted spin history adaptive dotyczy drugiego rzeczywistego podkroku ARS,
nie outer dt; szczegóły i output durability należą do specyfikacji oraz
[noty transportu](0970-spin-hall-drift-diffusion-transport.md#spin-transport-composite-resume-v2).
Same hash/count/cursory nie dowodzą committed prefixu. Brak dowodu daje
composite_outputs_not_committed. Restore przygotowuje wszystkie istniejące
stany lokalnie i publikuje je dopiero po walidacji całości; późna odmowa nie
zmienia drugiego dziecka ani epok. Nie wznawia się tylko pure-frozen child,
gdy transport wymaga composite.

Przyszłe niewykonane gates: composite_v2_frozen_epochs,
composite_v2_resume_transaction i pozostała macierz §13.7. Standalone V1
zachowuje wcześniejsze przyjęcia i dowody; tymczasowa odmowa legacy transport
resume pozostaje w mocy. Docs validation nie jest runtime/parity proof.

(frozen-spins-python-api)=
## 5. Python API

### 5.1. Aktualna granica authoringu

Publiczne `fullmag` udostępnia `fm.FrozenSpins`,
`ObjectRegion.freeze_spins(...)`, `Ferromagnet.freeze_spins(...)`, jawne
`object_id`, typed `fullmag.select` oraz `constraints=[...]` w etapach relax/run.
Wszystkie te ścieżki obniżają constraint do jednej top-level definicji. Jest to
wykonywalny authoring i walidacja IR, ale nie solverowa realizacja constraintu.

```python
# %%
import fullmag as fm

# %%
constraint = fm.FrozenSpins(
    id="pinned_free_layer",
    selector=fm.select.in_object("free_layer"),
    stage_ids=["relax"],
)
print(constraint.to_ir())
```

Repozytoryjny scenariusz `test_frozen_spins_contract.py` potwierdza jawne API,
convenience regionu/obiektu i agregację activation do stage IDs. Brak capability
runtime oznacza, że tego payloadu nie wolno jeszcze wykonać jako frozen spins.

### 5.2. Zaimplementowana granica typed selection

`fm.Selection`, `fm.SelectionScalar`, `fm.SelectionDefinition` oraz typ
`fullmag.model.selection.SelectionGeometry` udostępniają strict `from_ir()` i
copy-safe `to_ir()`.
`fm.select.in_object`, `fm.select.in_region`, `fm.select.inside`,
`fm.select.between` oraz `fm.select.m` budują ten sam AST. Publiczny
`fm.select.canonical_selection_sha256` najpierw typed-parsuje, waliduje i
canonicalizuje cały osiągalny graf definicji; unknown fields, cykle, brakujące
referencje, przekroczenie limitów `64/4096/1024` i niekwalifikowany
`imported_solid` failują przed hashowaniem. Jest to authoring/IR, nie
materializacja ani capability runtime.

### 5.3. Zaimplementowane parametry publiczne constraintu

| Python | Typ | Domyślna wartość | Jednostka SI | Walidacja | Znaczenie | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.FrozenSpins.id` | `str` | required | $1$ | non-empty unique | Stabilna tożsamość constraintu | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].id` |
| `fm.FrozenSpins.name` | `str` | derived from id | $1$ | non-empty | Nazwa użytkowa | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].name` |
| `fm.FrozenSpins.enabled` | `bool` | `True` | $1$ | boolean | Czy constraint jest authored-active | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].enabled` |
| `fm.FrozenSpins.selector` | `SelectionExpr` | required | $1$ | valid selection_expr.v1 | Wybór magnetycznych DOF | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].selector` |
| `fm.FrozenSpins.reference` | `FrozenReferencePolicy` | capture_current_at_activation | $1$ | supported reference policy | Źródło magnetyzacji referencyjnej | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].reference` |
| `fm.FrozenSpins.membership` | `SelectionMembershipPolicy` | geometry-only -> static; state-dependent -> snapshot_at_activation | $1$ | static only for geometry-only; snapshot_at_activation for both AST classes | Czas materializacji członkostwa | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].membership` |
| `fm.FrozenSpins.activation` | `ConstraintActivation` | all stages passed by sugar | $1$ | existing non-empty stage IDs | Zakres stage aktywacji | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].activation` |
| `fm.FrozenSpins.empty_selection` | `str` | error | $1$ | error or allow_noop | Polityka pustej finalnej maski | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].empty_selection` |
| `fm.FrozenSpins.inactive_selection` | `str` | warn_and_intersect | $1$ | warn_and_intersect or error | Polityka raw selection poza aktywną domeną | planned: FDM/FEM CPU/GPU | `magnetization_constraints[].inactive_selection` |

Convenience `ObjectRegion.freeze_spins()` przyjmuje stabilne
constraint ID/name, reference, membership i activation, po czym zbudować
`selector=in_region(owner_object, region_id)`. Nie zapisuje właściwości
materiałowej w regionie.

(frozen-spins-problem-ir)=
## 6. `ProblemIR`, normalizacja i planner

Typed `ProblemIRV04` dodaje top-level `selections[]` oraz
`magnetization_constraints[]`, a przejściowy publiczny writer `0.3.0` zapisuje
te same addytywne kolekcje do czasu atomowego cutover całego stosu. Kanoniczny
payload constraintu jest
zdefiniowany w `docs/specs/frozen-spins-v1.md` pod
`DOC-ANCHOR:frozen-v1-problem-ir`. Python explicit API, convenience API i stage
sugar produkują ten sam top-level JSON.

Python stage sugar i Control Room tworzą tę samą top-level definicję z
`activation.stage_ids`. Normalizacja wypełnia jawne defaulty, normalizuje typed
selector AST, zapisuje brak `boundary` jako jawne `inclusive` z wersjonowanymi
tolerancjami, wyprowadza jawne membership z klasy zależności AST, odrzuca
unknown fields i zachowuje stabilny authored fingerprint.
Planner materializuje maskę dopiero dla resolved gridu/mesha, przecina ją z
aktywną domeną, atomowo przechwytuje referencję i publikuje resolved certificate.

Constraint przechodzi `inactive -> active` na początku pierwszego wykonywanego
stage należącego do scope i wtedy rozpoczyna epokę. Kolejne bezpośrednio
wykonywane aktywne stage'e zachowują epokę; stage nieaktywny ją zamyka, a
późniejszy aktywny stage rozpoczyna nową niezależnie od ciągłości jego ID.
Resume checkpointu z aktywnej epoki przywraca maskę/referencję i nie wykonuje
recapture; resume stanu nieaktywnego uruchamia nową epokę dopiero przy kolejnym
przejściu do active.

Requested intent obejmuje selector, reference, membership, activation oraz
backend/device/precision. Resolved execution obejmuje konkretną topologię,
mask/reference fingerprint, counts, realization ID i capability evidence.
Jedno nie zastępuje drugiego.

(frozen-spins-round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka błędów

Python DSL i UI muszą round-tripować do tego samego `ProblemIR`; script export
nie może rekonstruować constraintu z wyglądu overlayu ani nazwy regionu.
`requested intent` pozostaje w authored IR i provenance, a `resolved execution`
pozostaje w planie, runtime resources, checkpointach i artefaktach.

`validation errors` są typed, zawierają ścieżkę IR i stabilny reason code.
`unsupported combinations` failują przed wykonaniem. Wymuszony backend,
urządzenie lub precyzja nie może spaść na inny lane; `auto` może wybrać jedynie
lane legalny dla wszystkich wariantów i musi zapisać powód rozstrzygnięcia.
Brak capability nigdy nie oznacza pominięcia constraintu.

Wymagane odrzucenia obejmują brakujący object/region/stage/selection/asset,
cykl, nadmierną złożoność, nieodwracalną transformację, pustą maskę bez jawnej
polityki, `static` na state-dependent AST, niezgodny overlap resolved
referencji, stale revision, zły rozmiar maski, resolved frozen DOF poza $A$,
activation-epoch mismatch, topology mismatch i drift referencji ponad kontrakt
lane. Na overlap każda para resolved reference musi być dokładnie równa w
precyzji lane na każdym wspólnym DOF; konflikt odrzuca całą aktywację atomowo,
także gdy dwie referencje capture-current pochodzą z różnych epok.

(frozen-spins-discrete-realization)=
## 8. Realizacje dyskretne i backendy

| Solver | Device | Target realization | Status kwalifikacji |
|---|---|---|---|
| FDM | CPU | cell-center bool mask; osobny Rust reference oracle i natywny właściciel backendu | `QUALIFIED` (FP64 reference) |
| FDM | GPU | device-resident dense mask/reference; osobne FP64 i FP32 gates | `QUALIFIED` (FP64 Heun/RK4), `UNQUALIFIED` (FP32 fail-closed) |
| FEM | CPU | magnetic true-DOF mask; MFEM/hypre; explicit P1 RK stepper | `QUALIFIED` (P1 explicit RK), `UNQUALIFIED` (direct minimizers fail-closed) |
| FEM | GPU | MFEM/hypre/libCEED/CUDA, mask/reference device-resident | `UNQUALIFIED` (fail-closed) |

FDM utrzymuje oddzielne `active_mask`, `region_mask`, `frozen_mask` i logiczny
`free_mask`. `region_mask` jest klasyfikacją materiałową, nie constraintem.

FEM nie używa listy wierzchołków ani centroidów jako maski solvera. Dla
wyższego rzędu, współdzielonych węzłów i parallel MFEM authoritative mapping
dotyczy true DOF przestrzeni magnetyzacji. Airbox i niemagnetyczne DOF są
wykluczane.

CPU/GPU mają osobne realizacje runtime tego samego kontraktu. Produkcyjna
numeryka FEM należy do `backends/fem`, natywna FDM do `backends/fdm`, a Rust
runner posiada orkiestrację, ABI, artefakty i provenance. Source presence,
kompilacja, runtime i scientific qualification są oddzielnymi dowodami.

(frozen-spins-implementation-mapping)=
## 9. Mapowanie implementacyjne i obecne luki

Aktualne źródła dowodzą authoringu, typed IR i kompilacji planu, ale nie
realizacji runtime:

- publiczny writer `ProblemIR` pozostaje przejściowo na wersji `0.3.0`, lecz
  zawiera addytywne top-level kolekcje selekcji i constraintów; osobny typed
  `ProblemIRV04` oraz migracja `0.3.0 -> 0.4.0` zachowują te kolekcje;
- `SelectionExprIR`, strict validation, canonical hash i publiczny Python
  selection DSL są zaimplementowane jako samodzielny kontrakt authoringowy;
- `ResolvedFrozenSpinsPlanIR`, `SelectionCertificateIR` oraz kompilatory
  `compile_fdm_frozen_spins` i `compile_fem_frozen_spins` materializują dense
  maskę, counts, bounds, hash i rewizję bez podłączenia do runtime;
- `ObjectRegion` jest publicznym właścicielem geometrii, materiału i polityki
  realizacji regionu;
- `FdmPlanIR` zachowuje `active_mask` i jednowartościowe `region_mask`, a
  niezależny resolved frozen-spins plan zachowuje `frozen_mask`;
- co najmniej dwa istniejące evaluatory geometrii mają różne zakresy wariantów;
- FEM mesh membership może publikować node/centroid preview, które nie jest
  solverowym true-DOF constraintem;
- publiczny builder posiada authoring frozen spins i agreguje jedną definicję
  do jawnych `activation.stage_ids`.

Te fakty nie dowodzą działania constraintu. Równania runtime są zakotwiczone w
`docs/specs/frozen-spins-v1.md` jako `planned_contract`; wpisy source index dla
IR i kompilatorów mają osobny status planner-implemented/runtime-unqualified.

(cd-headless-activation-publication)=
### 9.CD. Prerejestracja pełnego headless lifecycle dla terminal C+D

Status: **planned_contract; niewdrożone; runtime NOT VERIFIED**. Dokładne pola i owners
w [specyfikacji §14.8](../specs/frozen-spins-v1.md#cd-headless-frozen-lineage).
InteractiveRuntime już posiada pełny FrozenSpinsActivationSet, lecz fresh headless
reference/stage worker nie przenosi jego pełnej historii. Nie można publikować pustego
setu, child-only ani rekonstruować historii z obecnych active IDs.

Planowany jawny input lifecycle binding pobiera poprzedni set i child z immutable
manifestu fizycznego state-input. Ownerem jest admission/stage orchestration konkretnej
lineage, nie globalna mapa runu/DAG ani optional preview runtime. Fresh authored root musi
udowodnić brak wcześniejszej continuation; tylko tam wolno inicjować pustą historię.
Na NOWYM stage entry istniejący prepare_transition/reactivation jest wywołany raz u ownera
i wynik utrwalony w ordinary input/protocol v5 i existing admission snapshot. Terminal
producer, replay/retry i exact restore NIE wykonują prepare_transition/default.

Ciągle aktywne reference na overlap przechodzą przez istniejący engine stage transition;
nie wystarczy poprawić mapy epok po recapture całego reference. Inactive child pozostaje
null tylko bez active resolved planu, ale historyczny activation set nadal jest pełny.
Brak source set/child/topology zgodności odmawia, bez silent recapture lub epoch1 fallback.
Nie zmienia to constraint equation, parametrów Python ani ProblemIR.

| Pole kontraktu | Typ / default | SI | Walidacja / owner |
|---|---|---|---|
| previous_activation_set | existing strict FrozenSpinsActivationSet / required | $1$ | exact historical map active+inactive; source manifest |
| prepared_activation_set | ten sam existing type / required | $1$ | rzeczywisty jednorazowy stage entry; immutable admission |
| previous_frozen_child | FrozenSpinsCheckpointV1 or null / required-nullable | reference $1$, clock $\mathrm{s}$ | source plan/geometry/epoch/reference; null nie usuwa setu |
| source_manifest | existing binding or null / required-nullable | $1$ | null wyłącznie proven fresh authored root |
| terminal bundle | jeden accepted snapshot / required | M $1$, clock $\mathrm{s}$ | po normalnym writer drain, przed drop, once per stage |
| lineage | run/stage/case + physical state-input / required | $1$ | branching histories oddzielne; ambiguous merge odmawia |

| Lane nowego kontraktu | Stan |
|---|---|
| FDM CPU double frozen+M3 | planned_contract; pełny headless owner do implementacji, unqualified |
| FDM GPU | brak nowego execution/ExactResume claim |
| FEM CPU | existing lifecycle bez zmiany; nowy C+D FDM codec nie dotyczy |
| FEM GPU | existing lifecycle bez zmiany; nowy C+D FDM codec nie dotyczy |

Wymagane gates: active/inactive/re-entry + branching lineages, stale/missing history,
same-clock hidden history różny accepted ID, preserved overlap reference, retry bez
nowej epoki, terminal once-after-drain, cold store/archive input closure. Nie wykonano ich.
Legacy pure-frozen/ABM3/V1 i composite V2 zachowują swoje granice; C+D nie usuwa szerszego
transport Unsupported ani nie kwalifikuje M1/M2. Requested intent, resolved execution,
validation errors i unsupported combinations pozostają własnością bieżącego publicznego
kontraktu. Prerejestracja wymaga aktualizacji source maps i runtime evidence przed claim.

(frozen-spins-validation)=
## 10. Strategia walidacji

### 10.1. Kontrakt i IR

- round-trip jawnego API, convenience regionu i eksportu UI;
- deterministic serialization, migracja `0.3.0 -> 0.4.0` i unknown-field
  rejection;
- property tests AST, CSG, affine, granic i fingerprintów;
- default `inclusive` obecny jawnie w canonical IR oraz default membership
  zależny od klasy AST;
- identyczny fingerprint authoritative preview i planu.

### 10.2. Inwariant naukowy

- bitowa równość accepted $\mathbf m_F$ z referencją w precyzji lane;
- test dwóch spinów: frozen spin nie porusza się, ale wpływa exchange na
  swobodny spin;
- pełna energia zgadza się z energią nieusuniętej konfiguracji;
- final-RHS masking po LLG, STT, SOT i termice;
- candidate restore po każdym podkroku, odrzuconej próbie, normalizacji i line
  search;
- free-domain metryki PG-BB, NCG, adaptacyjnych RK i warunków stopu;
- `max_rhs_all` i `max_torque_all_Apm` z pełnego pre-constraint RHS/torque oraz
  odpowiadające redukcje `free` z tej samej rewizji;
- TPI z essential true DOF;
- czysto magnetyczny all-frozen no-op bez NaN i z dokładnym stop reason;
- all-frozen + transport: osobne gates `frozen-spins-auxiliary-transport-time`, bez przenoszenia kwalifikacji constraintu;
- restart odtwarza tę samą maskę, referencję i epokę bez recapture;
- nieciągłe stage IDs oraz inactive-to-active tworzą nową epokę;
- overlap referencji z różnych epok jest zgodny dokładnie albo aktywacja failuje
  atomowo.

### 10.3. Lane i produkt

FDM CPU/reference jest pierwszym oraclem. Następnie wymagane są parity CUDA
FP64, osobna kwalifikacja FP32 i multilayer, FEM CPU/MFEM oraz FEM GPU. Native
FEM/MFEM/CUDA/hypre/libCEED proof używa container-backed `just` recipes; host
build nie kwalifikuje runtime. API wymaga source-of-truth HTTP v2, generowanych
typów i binarnej maski poza cienkim statusem. Browser gate wymaga aktualnej
rewizji zasobu, widocznego overlayu, zdrowego WebGL i niezerowego drawing
buffera.

### 10.4. Profil energii bimeronu z ograniczeniem frozen spins

Profil rozmiaru bimeronu jest eksperymentem na rodzinie ograniczonych zadań,
a nie powtórzeniem swobodnej relaksacji dla każdego zadanego promienia. Dla
każdego $R$ najpierw budowana jest niezależna tekstura początkowa
$\mathbf m^{(0)}(R)$, następnie przechwytywana jest referencja
$\mathbf m_F^\star(R)$ na jawnej masce $F_R$. Etapy
`constrained_relax` i `constrained_hold` rozwiązują

```{math}
:label: eq-frozen-bimeron-profile-energy
E_c(R;F_R)=E\!\left(\mathbf m_U(R),\mathbf m_F^\star(R)\right),
\qquad U_R=A\setminus F_R,
```

czyli pełną energię układu z ustalonymi spinami, wraz z ich wkładem do pól
exchange, demag i DMI. Profil raportuje energię z tego samego etapu co stan,
z którego wyznaczono $R_\mathrm{area}$; stan po opcjonalnym `release` jest
osobnym pomiarem stabilności i nie zastępuje energii ograniczonej.

Rozmiar główny definiujemy przez pole obszaru odwróconej magnetyzacji:

```{math}
:label: eq-frozen-bimeron-profile-radius
R_\mathrm{area}=\sqrt{\frac{\operatorname{area}(C)}{\pi}},
\qquad C\subset\{b m_x<0\},
```

a $C$ jest pojedynczą wybraną składową spójną, a $b$ znakiem tła.
Pole wyznacza interpolacja liniowa na trójkątach siatki środków komórek;
wyspy poza wybraną teksturą nie powiększają promienia.
$R_\mathrm{core}$ oznacza połowę najkrótszej odległości pomiędzy lokalnymi
ekstremami $m_z$ z uwzględnieniem periodycznego kierunku x. Obie wielkości
mają jednostkę m (w raportach mogą być prezentowane w nm). Dla jednorazowej
kontroli materiału $P0$ można zmierzyć swobodny stan równowagowy, ale nie
traktujemy jego energii jako energii tła. Referencja do energii nadmiarowej
pochodzi z niezależnej relaksacji jednorodnego tła o znaku $b$ i wymaga
własnej zbieżności oraz zgodności parametrów fizycznych.

Dla protokołów P2/P3 zamrożony dysk kontroluje przede wszystkim położenie
rdzeni, dlatego współrzędną akceptacji jest $R_\mathrm{core}$. Odchylenie
$R_\mathrm{area}$ od celu pozostaje jawną diagnostyką `pin_bias` i nie jest
mieszane z główną gałęzią P-ring. Dla P-ring współrzędną profilu pozostaje
$R_\mathrm{area}$.

Jeżeli tło jest zbieżne, energia nadmiarowa wynosi

```{math}
:label: eq-frozen-bimeron-profile-excess
\Delta E(R)=E_c(R;F_R)-E_\mathrm{bg},
```

w J. Przy niezbieżnym lub brakującym tle $\Delta E$ ma wartość nieznaną i
pozostaje pusta w artefaktach; skończona energia terminalna tła sama nie jest
referencją fizyczną.

Kryterium relaksacji jest liczone po swobodnych DOF. Raportowany moment w T
jest przeliczeniem redukcji po $U_R$:

```{math}
:label: eq-frozen-bimeron-profile-free-torque
T_{f}=\mu_0\max_{i\in U_R}
\left\lVert\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\right\rVert_2.
```

Polityka surowa `thresholds.v1.json` zachowuje próg $10^{-5}$ T.
Osobna polityka `thresholds.working.v2.json` używa roboczego progu
$5\times10^{-3}$ T, a kontrola dłuższej relaksacji używa $10^{-3}$ T.
Identyfikator i hash polityki są zapisywane w receipt; zmiana polityki nie
przepisuje historycznej oceny. Zbieżność wymaga również stabilności energii i
rozmiaru w końcowym oknie; status `max_steps` lub `max_physical_time` pozostaje
`not_converged`.

Dla okna energii definiujemy bezwymiarowy rozrzut

```{math}
:label: eq-frozen-bimeron-profile-energy-window
\epsilon_E=\frac{\max_j E_j-\min_j E_j}{\left|\operatorname{mean}_j E_j\right|},
\qquad
\epsilon_{\Delta E}=\frac{\max_j E_j-\min_j E_j}
{\max\!\left(|\Delta E|,E_\mathrm{floor}\right)}.
```

Robocze progi pilota to $\epsilon_E\le 10^{-3}$ jako kontrola oczywistej
niestabilności oraz $\epsilon_{\Delta E}\le 5\times10^{-2}$ przy
$E_\mathrm{floor}=10^{-21}$ J. Są to progi stabilności jednego punktu, nie
tolerancja zgodności energii pomiędzy różnymi maskami. P2, P3 i pierścień
nakładają różne ograniczenia, więc ich rozrzut jest raportowany jako bias
protokołu i nie jest bramką akceptacji jednej krzywej $E(R)$.

Mały rozrzut końcowego okna nie jest oszacowaniem błędu względem równowagi.
Kontrola porównuje energię po dłuższej relaksacji, przy tej samej masce,
oraz oddzielnie bada szerokość i radialne przesunięcie pierścienia. Pełne
wektory przejęte z presetu narzucają więcej niż sam rozmiar; minimum profilu
jest warunkowe względem maski i ściany początkowej. Zmiana liczby frozen
cells nie służy wymuszaniu gładkości. Skala połowy komórki w pomiarze
promienia jest wskaźnikiem rozdzielczości, nie przedziałem ufności.
Test parowany zamraża fragment rzeczywistego stanu P0 i porównuje pełne
pole oraz energię przed i po relaksacji; dokładny transfer pliku sam nie
dowodzi zachowania równowagi. Nowe kontrole runtime pozostają `NOT VERIFIED`.
Nie zmienia się publiczny DSL ani ProblemIR; są to ograniczenia istniejącego
eksperymentu FDM GPU. Pozostałe trzy realizacje nie otrzymują kwalifikacji
na podstawie tego profilu.

W tej realizacji główną ścieżką jest FDM GPU FP64 strict z `llg_overdamped`.
CUDA emituje kontrolną redukcję free torque na urządzeniu, a pełne redukcje
energii są pobierane tylko w zaplanowanych snapshotach. `projected_gradient_bb`
pozostaje kandydatem do osobnej kwalifikacji: dopóki natywna pętla prób nie
udowodni przywracania referencji przy każdej retrakcji/Armijo i nie ma nowego
receiptu strict, wyników BB nie wolno mieszać z zaakceptowanym profilem.

Scenariusz nie dodaje nowej publicznej klasy Python ani nowego pola
`ProblemIR`; wykorzystuje istniejący `FrozenSpins`, resolved mask/reference,
stage IDs i certyfikaty hash. `run_sweep.py`, `analyze.py`, `verify.py` i
`report.py` zapisują razem target $R$, zmierzone promienie, pełną energię,
ewentualne $\Delta E$, torque po free DOF, status stopu, maskę i referencję.
FEM CPU/GPU pozostają osobnymi torami walidacji i nie są wnioskiem z profilu
FDM.

Szczegółowy ledger i wszystkie początkowe statusy `UNQUALIFIED` znajdują się w
`docs/validation/frozen-spins-qualification-matrix.md`.

(frozen-spins-limitations)=
## 11. Ograniczenia i prace odłożone

- Typed selection, top-level frozen-spins authoring/IR oraz plannerowa dense
  maska z certyfikatem są zaimplementowane, ale backendy, checkpoint i runtime
  lifecycle nie konsumują planu; nota nie nadaje capability.
- `live_accepted_step_membership` wymaga osobnego schematu V2 z histerezą,
  restartem historii i checkpointem maszyny członkostwa.
- Częściowe zamrożenie składowych magnetyzacji nie należy do V1.
- Imported CAD pozostaje fail-closed bez kwalifikowanego occupancy engine.
- V1 nie wykonuje automatycznego remeshingu ani reprojekcji po zmianie
  topologii.
- Sparse runtime mask/reference i kompresja hot-loop nie są częścią V1; dense
  jest bezpieczną reprezentacją referencyjną do czasu profilowania.
- Profil $E(R)$ pozostaje warunkowy na protokole kotwienia, siatce, szerokości
  ściany i zbieżnym tle. Obecny pilot jest diagnostyczny; zaakceptowana krzywa
  wymaga zbieżnych punktów po obu stronach minimum oraz osobnej kontroli wpływu
  wielkości pinu i siatki.

(frozen-spins-state-output-bridge)=
### Planowany most state-output z pełnym historycznym frozen lifecycle

Status `planned_contract`, runtime NOT VERIFIED. [Spec §14.11](../specs/frozen-spins-v1.md#frozen-v1-output-lifecycle-bridge)
definiuje jawny tuple `state|initial_state` + `fullmag.runner.frozen_state_json@v1`
w istniejącym output manifest V3. Strict `fullmag.frozen_state_output.v1` wymaga
`schema_version`, istniejącego raw `state`, required-nullable `frozen_spins`
FrozenCheckpointV1 i required pełnego strict `frozen_activation_set`.
M/reference mają $1$, czas i dt $\mathrm{s}$, epoch/revision $1$; pełne typy,
jednostki i walidacja są w tabeli spec. Bez nowych parametrów Python/IR lub równań.
Child null dopuszcza wyłącznie inactive plan i active set pusty; historyczna mapa
pozostaje kompletna. Legacy M-only nie dowodzi braku nieaktywnych aktywacji.

Jeden terminalny hook po drain i przed drop pobiera rzeczywisty child także po
Relax. Pure-frozen nie emituje czterech nośników M3. Observation V2 wymaga
atomowego C+D manifest V4 z rzeczywistym coverage i oboma czytnikami. Admission
utrwala kontekst; recovery nie wywołuje prepare_transition. Source plan, M/clock,
pełna mapa i istniejący overlap reference są sprawdzane przed solve. Publisher
pozostaje lease-owned, owner-qualified ID i raw SHA/count; envelope nie ma CAS
refs. Osobny FrozenMagnetizationState wymaga jawnego runner gate; importerzy bez
gate odmawiają. Typed inspection i oba CAS walkers muszą odrzucać nieznane refs
oraz zachować bounded decode. Cold reopen/Relax → M3/deactivate → reactivate nie
są zweryfikowane. AcceptedStateId V1, legacy codec i Unsupported ExactResume
pozostają bez zmian. FDM CPU: planned; FDM GPU/FEM CPU/FEM GPU: poza mostem,
odmowa bez fallbacku.

Planowani ownerzy kandydata: `crates/fullmag-application/src/study_artifact.rs` +
`decode_frozen_magnetization_state`; `crates/fullmag-runner/src/constraints/activation.rs` +
`FrozenOutputLifecycleV1`; `crates/fullmag-runtime-control/src/frozen_stage_lifecycle.rs` +
`load_execution_context`; `crates/fullmag-runner/src/fdm/cpu/reference.rs` +
`execute_reference_fdm_with_terminal_context`. To prerejestracja, nie dowód runtime.

Aneks planned contract [§14.12](../specs/frozen-spins-v1.md#cd-terminal-completion-receipt-clock)
wersjonuje istniejący completed receipt, bounded cold histories i metadata clock
nowego envelope. Exact M oraz rzeczywisty terminal child są wymagane przed zmianą
wyłącznie nested artifact metadata; legacy V3 i czas solvera pozostają bez zmian.
Brak Rust/HTTP/cold execution evidence; publiczny ExactResume nadal Unsupported.

(frozen-spins-scientific-bibliography)=
## 12. Bibliografia naukowa

1. W. F. Brown Jr., *Micromagnetics*, Interscience, 1963. Stabilny rekord:
   <https://archive.org/details/micromagnetics00brow>.
2. T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic
   materials”, *IEEE Transactions on Magnetics* 40 (2004), 3443–3449,
   <https://doi.org/10.1109/TMAG.2004.836740>.
3. A. Vansteenkiste et al., “The design and verification of MuMax3”,
   *AIP Advances* 4, 107133 (2014),
   <https://doi.org/10.1063/1.4899186>.



(frozen-spins-source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim | Ścieżka | Symbol / anchor | Odpowiedzialność | Lane | Test / dowód | Status evidence | Immutable link |
|---|---|---|---|---|---|---|---|
| Aneks terminal C+D | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:cd-terminal-completion-receipt-clock` | Strict existing completed owner V2, bounded publication i rzeczywisty terminal clock; planned, bez runtime. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source/parser; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-api/src/accepted_study_worker.rs` | `WorkerExecutionCompletedReceiptV2` | Nowy oddzielny strict wire, old V1 closed set nietknięty. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source/parser; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-runtime-control/src/study_output_history.rs` | `validate_committed_history` | Rzeczywiste thin history leaves, canonical layout/units oraz existing schedule cursors. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source/parser; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-application/src/study_artifact.rs` | `encode_frozen_study_state` | Nowy envelope z rzeczywistym terminal child clock; legacy state bytes nietknięte. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source/parser; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Jawny adapter metadata terminal M | `crates/fullmag-application/src/study_artifact.rs` | `materialize_study_state_at_terminal_clock` | Metadata aktualnego M bez zmiany wartości | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source review; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Wspólna owner/role/raw identity | `crates/fullmag-session/src/types.rs` | `terminal_publication_artifact_id` | Jedna formuła publishera i cold readera | FDM CPU FP64; pozostali unsupported dla nowej ścieżki | source review; runtime NOT VERIFIED | planned_contract | storage candidate; path + symbol |
| Publiczna odmowa transport resume A | `crates/fullmag-runner/src/lib.rs` | `validate_fdm_transport_checkpoint_resume_support` | Wspólna publiczna odmowa ExactResume dla CPU M1/M2/M3; ograniczona kontynuacja solver-state V1 nie jest admission. | FDM CPU M1/M2/M3; pozostali ownerzy bez zmian | source/parser controls; bez HTTP/native | SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED | source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; path + symbol |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `checkpoint_resume_unsupported_reason` | Typed metadata i schema wyznaczają powód Unsupported; brak wymaganej transport identity daje odmowę. | FDM CPU M1/M2/M3; pozostali ownerzy bez zmian | source/parser controls; bez HTTP/native | SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED | source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; path + symbol |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `supported_checkpoint_restore_class` | Unsupported przed dotychczasową klasyfikacją; pozostały catalog self-compatibility nie jest naprawiony przez A. | FDM CPU M1/M2/M3; pozostali ownerzy bez zmian | source/parser controls; bez HTTP/native | SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED | source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; path + symbol |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `restore_checkpoint_with_context` | API odmawia przed odczytem common state i mutacją snapshotu; brak automatycznego downgrade. | FDM CPU M1/M2/M3; pozostali ownerzy bez zmian | source/parser controls; bez HTTP/native | SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED | source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; path + symbol |
| Ograniczona kontynuacja nonfrozen M3 V1 | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Zachowanie pełnego V1 solver state przy niezmienionym planie; bez output prefix/cursorów i bez publicznego ExactResume. | FDM CPU FP64 M3 bez frozen | `legacy_m3_solver_state_rejects_changed_plan_and_frozen_before_publication`; zachowana pozytywna regresja resume | SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED | `worktree/uncommitted`; path + symbol |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `FdmCompositeCheckpointV2` | Prywatne typy composite v2; IMPLEMENTED_SOURCE_ONLY, NOT_COMPILED, NOT_EXECUTED. | FDM CPU FP64; inne lane unsupported | parser/source checks, bez wykonania codec | `IMPLEMENTED_SOURCE_ONLY`; `NOT_COMPILED`; `NOT_EXECUTED` | `worktree/uncommitted`; path + symbol |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `decode_composite_m3_codec_v2` | Strict raw ingress, required-null, typed roundtrip i outer hash; wyłącznie codec źródłowy. | FDM CPU FP64; inne lane unsupported | parser/source checks, bez wykonania codec | `IMPLEMENTED_SOURCE_ONLY`; `NOT_COMPILED`; `NOT_EXECUTED` | `worktree/uncommitted`; path + symbol |
| Prywatny original-stage gate | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `validate_for_original_stage` | CodecCheckedCompositeV2::validate_for_original_stage sprawdza oryginalne problem/plan/stage/outputs przekazane przez admitted ownera; sam helper nie dowodzi immutable admission. SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED. | FDM CPU FP64; inne lane unsupported | parser/source checks; bez wykonania Rust | `SOURCE_ONLY`; `NOT_COMPILED`; `NOT_EXECUTED`; reszta gates OPEN | `worktree/uncommitted`; path + symbol |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `validate_self_contained` | Reuse nested walidatorów oraz bitowe clocks/history/frozen i output shape; contextual gates i ExactResume nadal planned, NOT VERIFIED. | FDM CPU FP64; inne lane unsupported | parser/source checks, bez wykonania codec | `IMPLEMENTED_SOURCE_ONLY`; `NOT_COMPILED`; `NOT_EXECUTED` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-checkpoint` | Kontrakt wrappera i required pól; prywatny codec IMPLEMENTED_SOURCE_ONLY, publiczna integracja planned. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-hash` | Strict ingress, kompletność nested codecs i kanoniczny outer hash. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-accepted-history` | Outer accepted dt i rzeczywiste inner ARS history, bez dopisywania timestampów. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-output-commit` | Binding istniejącego committed output manifestu i jawna odmowa braku trwałego prefixu. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-atomic-restore` | Atomowy capture/restore w istniejących ownerach; bez recapture i implicit continuation. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `FdmCoupledCheckpoint` | Istniejący nested M3 V1, accepted/history/controller i własny payload digest. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `validate_complete_coupled_checkpoint` | Istniejąca pełna walidacja nested M3, bez zastępowania jej wrapperem. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/constraints/checkpoint.rs` | `FrozenSpinsCheckpointV1` | Istniejący mask/reference/activation codec i historyczne defaults niedozwolone jako brakujące dane V2. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/constraints/activation.rs` | `FrozenSpinsActivationSet` | Reuse istniejącej historycznej mapy epok i active set. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/interactive/runtime.rs` | `frozen_spins_activation_set` | Rzeczywisty runtime owner historycznej activation set między etapami. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `ensure_interactive_preview_runtime` | Przeniesienie historycznego activation set przy przebudowie stage runtime. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Istniejący adaptive full/two-half acceptance oraz outer dt/history writer; nie dowód runtime. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/schedules.rs` | `OutputSchedule` | Istniejący pojedynczy owner next_time i last_sampled_time; brak checkpoint cursorów V2. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `canonical_json_bytes` | Istniejąca rekursywna kanonizacja JSON użyta w prywatnym codec outer digest; runtime NOT VERIFIED. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-quantities/src/accepted_state.rs` | `AcceptedStateRef` | Istniejąca tożsamość accepted clocks/state/generation bez nowego modelu. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `FmsStudyOutputManifest` | Istniejący CAS-backed manifest z task/attempt/step i accepted-state reference. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `FmsArtifactCatalog` | Istniejący katalog revision i immutable published entries, nie nowy receipt. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-runner/src/artifact_pipeline.rs` | `record_scalar` | Enqueue outputu nie potwierdza durable checkpoint prefixu. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-session/src/store.rs` | `commit_checkpoint` | Istniejący writer lease, common state, reachability oraz commit marker. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `crates/fullmag-session/src/capture.rs` | `capture_checkpoint` | Istniejący capture common M/backend payload przed publikacją markeru. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Composite checkpoint v2 | `docs/physics/0996-frozen-spins-constraint.md` | `DOC-ANCHOR:frozen-spins-composite-resume-v2` | Granica prerejestracji composite bez rozszerzania kwalifikacji legacy. | FDM CPU FP64; inne lane unsupported | prereg composite_v2_*; niewykonane | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `docs/physics/0996-frozen-spins-constraint.md` | `DOC-ANCHOR:frozen-spins-auxiliary-transport-time` | Prerejestracja no-op M oraz aktywnego transportu w fizycznym czasie; runtime niezweryfikowany. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-all-frozen` | Executed steps, czas, pause/cancel i odmowa Relax+M3. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` | `DOC-ANCHOR:spin-transport-frozen-free-error-support` | Wspólny free-target support outer-error gate; bez zmiany bilansów. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `planned_contract` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Istniejący owner czasu, counters, outputs i completion; shortcut/gates wymagają naprawy. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_coupled_heun_trial` | Istniejący transaction Heun evaluate/commit/rollback. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_coupled_ars_trial` | Istniejący transaction ARS i historia M3. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `heun_trial_with_external_stage_terms_and_lte` | Źródłowy raw embedded Heun estimator w borrowed k[2], mask/restore; typy i runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/shared/types.rs` | `TransportStageErrorBudget` | Źródłowy borrowed per-cell estimator i resolved frozen mask; synchroniczny zakres callback/solve bez nowego stanu; runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `CoupledTransportOuterErrorBudget` | Istniejący budżet outer-error z Gilbert-source delta; nie wprowadzać arbitralnego floor. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `FdmSpinTransportWorkflow` | Istniejący accepted/rejected counters, cache, snapshot i checkpoint. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `transport_torque_delta_l2` | Źródłowa wspólna redukcja obu norm po target∩free, empty support i finite guards; runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/time_events.rs` | `build_resolved_stage_event_schedule_with_origin` | Istniejący owner zdarzeń; envelope current i fixed M3 clipping wymagają dowodów/naprawy. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-plan/src/validate.rs` | `validate_conservative_relaxation` | Istniejąca odmowa niekonserwatywnych torque; jawna odmowa Relax+M3 jeszcze niezaimplementowana. | FDM CPU FP64; inne lane niekwalifikowane | gates `frozen-spins-auxiliary-transport-time` | `source_only_unqualified` | `worktree/uncommitted`; path + symbol |
| Ograniczenie $\mathbf m_F=\mathbf m_F^\star$ | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-constraint-model` | Zatwierdzony model V1 | wspólny | review Task 1 | planned_contract | `worktree/uncommitted`; path + anchor only |
| Pełna energia | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-energy` | Energia constrained | wspólny | przyszły oracle energii | planned_contract | `worktree/uncommitted`; path + anchor only |
| Final-RHS masking | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-final-rhs` | Kolejność maskowania torque | wspólny | przyszłe STT/SOT/thermal fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| Candidate restore | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-candidate-restore` | Niezmienność kandydatów | wspólny | przyszłe integrator/minimizer fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| Redukcje po $U$ i $A$ | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-free-reductions` | Metryki free/all z tego samego pre-constraint stanu | wspólny | przyszłe convergence fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| Profil energii bimeronu | `tests/standard_problems/bimeron/goebel_2019/frozen_size/scenario_fdm.py` | `FROZEN` | Związana energia, pomiar $R$ i free torque przy frozen spins | FDM GPU FP64 | pilot w storage; punkty `not_converged` | diagnostic, not accepted | `worktree/uncommitted`; path + symbol only |
| Pomiar wybranej tekstury | `tests/standard_problems/bimeron/goebel_2019/frozen_size/analyze.py` | `_measure` | Spójna składowa, znak tła i najkrótsza odległość przez PBC | FDM postprocessing | `test_analyzer.py` | testy źródłowe; nowy runtime `NOT VERIFIED` | `worktree/uncommitted`; path + symbol only |
| Referencja tła i $\Delta E$ | `tests/standard_problems/bimeron/goebel_2019/frozen_size/analyze.py` | `_background_reference_status` | Tło używane wyłącznie po zbieżności; brak tła zachowuje `null` | FDM | reanaliza z `background_not_converged` | diagnostic, not accepted | `worktree/uncommitted`; path + symbol only |
| Stabilność i bias protokołu | `tests/standard_problems/bimeron/goebel_2019/frozen_size/run_sweep.py` | `_protocol_energy_spread` | Okno energii względem $E_\mathrm{total}$ i $\Delta E$; spread P2/P3/ring nie jest bramką | FDM | authoring smoke i pilot diagnostyczny | diagnostic, not accepted | `worktree/uncommitted`; path + symbol only |
| TPI essential true DOF | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-tpi` | Kontrakt tangent-plane | FEM CPU/GPU | przyszły managed FEM gate | planned_contract | `worktree/uncommitted`; path + anchor only |
| Capture timing i epoki | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-capture` | Atomowa maska/referencja, transitions i resume | wspólny | przyszły revision/restart fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| Zgodność overlap | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-overlap` | Dokładna zgodność resolved reference przed atomowym committem | wspólny | przyszły cross-epoch overlap fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| All-frozen | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-all-frozen` | No-op i stop reason | wspólny | przyszły stage fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| Aktualna granica wersji IR | `crates/fullmag-ir/src/lib.rs` | `is_supported_ir_version_for_read` | Obsługiwane wersje read | IR | bieżące testy IR niezwiązane z frozen spins | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/crates/fullmag-ir/src/lib.rs) |
| Typed selection IR | `crates/fullmag-ir/src/selection.rs` | `canonical_selection_sha256` | Kanoniczny zamknięty AST, limity i fingerprint | IR | `selection_*` w `crates/fullmag-ir/tests/ir_tests.rs` | current source, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Publiczny Python selection DSL | `packages/fullmag-py/src/fullmag/model/selection.py` | `class Selection` | Typed builders, parse/round-trip i canonical hash | Python | `packages/fullmag-py/tests/test_selection_contract.py` | current source, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Typed frozen-spins IR | `crates/fullmag-ir/src/constraint.rs` | `MagnetizationConstraintIR`, `FrozenSpinsIR` | Strict serde, defaulty i polityki V1 | IR | `frozen_spins_*` w `crates/fullmag-ir/tests/ir_tests.rs` | authoring/IR implemented, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Resolved plan i certyfikat | `crates/fullmag-ir/src/plan.rs` | `ResolvedFrozenSpinsPlanIR::validate_intrinsic` | Dense maska, certyfikat i fail-closed walidacja cache | IR/planner | `resolved_frozen_spins_*` | planner implemented, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Kompilator selekcji FDM | `crates/fullmag-plan/src/selection/fdm.rs` | `compile_fdm_frozen_spins` | Środki komórek, active intersection i certyfikat | FDM CPU/GPU | `frozen_spins_fdm_*` | planner implemented, execution lane unqualified | `worktree/uncommitted`; path + symbol only |
| Kompilator selekcji FEM | `crates/fullmag-plan/src/selection/fem.rs` | `compile_fem_frozen_spins` | P1/P2 magnetic true DOF, any-incident magnetic | FEM CPU/GPU | `frozen_spins_fem_*` | planner implemented, execution lane unqualified | `worktree/uncommitted`; path + symbol only |
| Publiczny Python frozen-spins DSL | `packages/fullmag-py/src/fullmag/model/constraints.py` | `class FrozenSpins` | Strict parse/lowering i default membership | Python | `packages/fullmag-py/tests/test_frozen_spins_contract.py` | authoring/IR implemented, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Aktualna materializacja regionu FDM | `crates/fullmag-plan/src/fdm.rs` | `materialize_object_region_mask` | Istniejący evaluator regionu | FDM | bieżące testy regionów, nie frozen spins | current source only | `worktree/uncommitted`; path + symbol only |
| Konsument predykatu geometrii drive | `crates/fullmag-plan/src/regional_field_drive.rs` | `resolve_fdm_regional_field_drives` | Istniejąca maska geometryczna drive | FDM | bieżące testy drive, nie frozen spins | current source only | `worktree/uncommitted`; path + symbol only |
| Aktualny preview membership FEM | `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs` | `build_mesh_region_membership` | Mesh parts i fallback preview | FEM/API | bieżące testy membership, nie true-DOF constraint | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs) |
| Publiczny właściciel regionu | `packages/fullmag-py/src/fullmag/model/structure.py` | `class ObjectRegion` | Region material/mesh API | Python | bieżące testy regionu, nie frozen spins | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/packages/fullmag-py/src/fullmag/model/structure.py) |
| Publiczny stage-first root | `packages/fullmag-py/src/fullmag/world.py` | `StudyStagesBuilder._merge_constraints` | Agregacja top-level constraintu do stage IDs bez mutacji przed zatwierdzeniem etapu | Python | `test_stage_constraints_lower_to_one_top_level_definition_with_stage_ids` | authoring/IR implemented, runtime unqualified | `worktree/uncommitted`; path + symbol only |


### Indeks C+D prerejestracji i obecnych ownerów

| Claim | Ścieżka | Symbol | Status |
|---|---|---|---|
| Planowany explicit historical stage lineage/admission owner, bez default/reconstruct. | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:cd-headless-frozen-lineage` | planned_contract |
| Istniejący strict full activation map; nie nowy model epok. | `crates/fullmag-runner/src/constraints/activation.rs` | `FrozenSpinsActivationSet` | source_only_unqualified |
| Istniejące zachowanie reference na overlap oraz epok w stage transition. | `crates/fullmag-engine/src/fdm/shared/frozen_spins.rs` | `transition_at_activation` | source_only_unqualified |
| Aktualny interactive carrier historii; nie dowód headless ownera. | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `ensure_interactive_preview_runtime` | source_only_unqualified |
