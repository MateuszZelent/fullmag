# Frozen spins: ograniczenie magnetyzacji

- Status: zatwierdzony kontrakt fizyczny; implementacja i wszystkie lane'y niezakwalifikowane
- Właściciele: Fullmag physics, planner i backend teams
- Ostatnia aktualizacja: 2026-08-20
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
kod zawiera typed `SelectionExprIR` i publiczny `fullmag.select`, ale nadal nie
zawiera `FrozenSpins`, top-level constraintu w `ProblemIR`, plannerowej maski
ani backendowego runtime. Poniższe równania są zatwierdzonym kontraktem
planowanym, nie dowodem wykonania.

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
| $E$ | Pełna energia mikromagnetyczna | $\mathrm{J}$ |
| $E_{\mathrm c}$ | Energia ograniczona jako funkcja swobodnego stanu | $\mathrm{J}$ |
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

(frozen-spins-python-api)=
## 5. Python API

### 5.1. Aktualna granica wykonywalności

Publiczne `fullmag` udostępnia `fm.study(...)`, jawne `object_id` na realnym
uchwycie magnetycznym, `ObjectRegion`, typed `fullmag.select` i canonical
fingerprint. Nie udostępnia jeszcze `fm.FrozenSpins` ani stage registration
constraintów. Poniższy blok jest wykonywalnym testem aktualnej granicy
authoringu; buduje typed selector, ale nie uruchamia constraintu.

```python
# %%
import fullmag as fm

# %%
selector = fm.select.in_object("free_layer") & (fm.select.m.z > 0.5)
print(selector.to_ir())
print(hasattr(fm, "FrozenSpins"))
```

Po implementacji Task 5 ten test ma zostać zastąpiony repozytoryjnym scenariuszem
`fm.study(...)` z jawnym engine/device/mode, geometrią, materiałem,
magnetyzacją, constraintem, `study.stages.add_relaxation(...)`, dynamiką i
outputs. Do tego czasu planowany kształt authoringu jest kontraktem tekstowym,
nie kodem Python do skopiowania:

```text
constraint = FrozenSpins(selector=typed_selection, ...)
study.stages.add_relaxation(..., constraints=[constraint])
study.stages.add_time_evolution(..., constraints=[constraint])
```

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

### 5.3. Planowane parametry publiczne constraintu

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

Convenience `ObjectRegion.freeze_spins()` ma przyjąć co najmniej stabilne
constraint ID/name, reference, membership i activation, po czym zbudować
`selector=in_region(owner_object, region_id)`. Nie zapisuje właściwości
materiałowej w regionie.

(frozen-spins-problem-ir)=
## 6. `ProblemIR`, normalizacja i planner

Target `ProblemIR 0.4.0` dodaje top-level `selections[]` oraz
`magnetization_constraints[]`. Kanoniczny target payload constraintu jest
zdefiniowany w `docs/specs/frozen-spins-v1.md` pod
`DOC-ANCHOR:frozen-v1-problem-ir`. Typed selection istnieje, ale nie jest to
jeszcze JSON wyprodukowany przez top-level lowering constraintu, ponieważ
`magnetization_constraints[]` i jego stage sugar należą do Task 5.

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
| FDM | CPU | cell-center bool mask; osobny Rust reference oracle i natywny właściciel backendu | `UNQUALIFIED` |
| FDM | GPU | device-resident dense mask/reference; osobne FP64 i FP32 gates | `UNQUALIFIED` |
| FEM | CPU | magnetic true-DOF mask; MFEM/hypre; TPI essential true DOF | `UNQUALIFIED` |
| FEM | GPU | MFEM/hypre/libCEED/CUDA, mask/reference device-resident | `UNQUALIFIED` |

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

Aktualne źródła dowodzą jedynie istniejących właścicieli, na których przyszła
implementacja ma się oprzeć:

- `ProblemIR` ma obecnie wersję `0.3.0` i nie zawiera jeszcze top-level kolekcji
  selekcji ani constraintów;
- `SelectionExprIR`, strict validation, canonical hash i publiczny Python
  selection DSL są zaimplementowane jako samodzielny kontrakt authoringowy;
- `ObjectRegion` jest publicznym właścicielem geometrii, materiału i polityki
  realizacji regionu;
- FDM plan ma `active_mask` i jednowartościowe `region_mask`, ale nie ma
  `frozen_mask`;
- co najmniej dwa istniejące evaluatory geometrii mają różne zakresy wariantów;
- FEM mesh membership może publikować node/centroid preview, które nie jest
  solverowym true-DOF constraintem;
- obecny publiczny builder posiada `study()`, lecz nie ma authoringu frozen
  spins.

Te fakty nie dowodzą działania constraintu. Planowane równania są zakotwiczone
w `docs/specs/frozen-spins-v1.md` jako `planned_contract`.

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
- all-frozen no-op bez NaN i z dokładnym stop reason;
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

Szczegółowy ledger i wszystkie początkowe statusy `UNQUALIFIED` znajdują się w
`docs/validation/frozen-spins-qualification-matrix.md`.

(frozen-spins-limitations)=
## 11. Ograniczenia i prace odłożone

- Typed selection jest zaimplementowane w Python API i `fullmag-ir`, ale brak
  top-level frozen-spins constraintu w `ProblemIR`, plannerze i backendach;
  nota nie nadaje capability.
- `live_accepted_step_membership` wymaga osobnego schematu V2 z histerezą,
  restartem historii i checkpointem maszyny członkostwa.
- Częściowe zamrożenie składowych magnetyzacji nie należy do V1.
- Imported CAD pozostaje fail-closed bez kwalifikowanego occupancy engine.
- V1 nie wykonuje automatycznego remeshingu ani reprojekcji po zmianie
  topologii.
- Sparse runtime mask/reference i kompresja hot-loop nie są częścią V1; dense
  jest bezpieczną reprezentacją referencyjną do czasu profilowania.

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
| Ograniczenie $\mathbf m_F=\mathbf m_F^\star$ | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-constraint-model` | Zatwierdzony model V1 | wspólny | review Task 1 | planned_contract | `worktree/uncommitted`; path + anchor only |
| Pełna energia | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-energy` | Energia constrained | wspólny | przyszły oracle energii | planned_contract | `worktree/uncommitted`; path + anchor only |
| Final-RHS masking | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-final-rhs` | Kolejność maskowania torque | wspólny | przyszłe STT/SOT/thermal fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| Candidate restore | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-candidate-restore` | Niezmienność kandydatów | wspólny | przyszłe integrator/minimizer fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| Redukcje po $U$ i $A$ | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-free-reductions` | Metryki free/all z tego samego pre-constraint stanu | wspólny | przyszłe convergence fixtures | planned_contract | `worktree/uncommitted`; path + anchor only |
| TPI essential true DOF | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-tpi` | Kontrakt tangent-plane | FEM CPU/GPU | przyszły managed FEM gate | planned_contract | `worktree/uncommitted`; path + anchor only |
| Capture timing i epoki | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-capture` | Atomowa maska/referencja, transitions i resume | wspólny | przyszły revision/restart fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| Zgodność overlap | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-overlap` | Dokładna zgodność resolved reference przed atomowym committem | wspólny | przyszły cross-epoch overlap fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| All-frozen | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-all-frozen` | No-op i stop reason | wspólny | przyszły stage fixture | planned_contract | `worktree/uncommitted`; path + anchor only |
| Aktualna granica wersji IR | `crates/fullmag-ir/src/lib.rs` | `is_supported_ir_version_for_read` | Obsługiwane wersje read | IR | bieżące testy IR niezwiązane z frozen spins | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/crates/fullmag-ir/src/lib.rs) |
| Typed selection IR | `crates/fullmag-ir/src/selection.rs` | `canonical_selection_sha256` | Kanoniczny zamknięty AST, limity i fingerprint | IR | `selection_*` w `crates/fullmag-ir/tests/ir_tests.rs` | current source, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Publiczny Python selection DSL | `packages/fullmag-py/src/fullmag/model/selection.py` | `class Selection` | Typed builders, parse/round-trip i canonical hash | Python | `packages/fullmag-py/tests/test_selection_contract.py` | current source, runtime unqualified | `worktree/uncommitted`; path + symbol only |
| Aktualna materializacja regionu FDM | `crates/fullmag-plan/src/fdm.rs` | `materialize_object_region_mask` | Istniejący evaluator regionu | FDM | bieżące testy regionów, nie frozen spins | current source only | `worktree/uncommitted`; path + symbol only |
| Konsument predykatu geometrii drive | `crates/fullmag-plan/src/regional_field_drive.rs` | `resolve_fdm_regional_field_drives` | Istniejąca maska geometryczna drive | FDM | bieżące testy drive, nie frozen spins | current source only | `worktree/uncommitted`; path + symbol only |
| Aktualny preview membership FEM | `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs` | `build_mesh_region_membership` | Mesh parts i fallback preview | FEM/API | bieżące testy membership, nie true-DOF constraint | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs) |
| Publiczny właściciel regionu | `packages/fullmag-py/src/fullmag/model/structure.py` | `class ObjectRegion` | Region material/mesh API | Python | bieżące testy regionu, nie frozen spins | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/packages/fullmag-py/src/fullmag/model/structure.py) |
| Publiczny stage-first root | `packages/fullmag-py/src/fullmag/world.py` | `study` | `fm.study(...)` | Python | bieżące testy buildera, brak constraint hook | current source only | [source](https://github.com/MateuszZelent/fullmag/blob/d9518082eaee2131c3e7160bd8ae952ed2f45899/packages/fullmag-py/src/fullmag/world.py) |
