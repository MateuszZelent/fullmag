# Audyt Python DSL → ProblemIR → planner: capability i provenance

Data: 2026-09-08  
Checkout audytowany: `C:/git/fullmag/fullmag`  
Zakres: publiczne modele autora, ich lowering do `ProblemIR`, reguły planera
oraz deklarowane realizacje FDM/FEM CPU/GPU. Ten rozdział jest dowodem
źródłowym i kontraktowym. Nie jest dowodem wykonania solvera ani kwalifikacji
runtime.

## Zasada oceny

Model obecny w Pythonie nie oznacza jeszcze, że można go uruchomić na każdym
lane. Rozdzielam cztery stany: authorable, planner-legal, executable oraz
validated. `source_visible`, `implemented` i `semantic_only` nie są zamieniane
na `production_executable` bez odpowiadającego receipts i workloadu.

`ProblemIR` ma przechowywać fizyczną intencję, a planner ma dopiero rozstrzygać
realizację. `auto` może zostać rozwiązane, lecz nie może zniknąć z provenance.
Żądanie GPU jest twardym ograniczeniem; odrzucenie braku capability musi
nastąpić przed wejściem do backendu i nie może być opisane jako CPU fallback.

## Macierz modeli Python → IR → lane

| Model publiczny | Python → IR | Planner / runtime | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|---|---|
| Demag `model="airbox"` | `Demag.to_ir` → `EnergyTermIR::Demag` | Poisson airbox po jawnej legalizacji | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | source/contract path obecny; runtime NOT VERIFIED | source/contract path obecny; runtime NOT VERIFIED |
| Demag `realization="poisson_robin"` | `Demag.to_ir` → `RequestedFemDemagIR::PoissonRobin` | konkretny resolved FEM Poisson–Robin | NOT VERIFIED | NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED |
| Demag `realization="poisson_dirichlet"` | `Demag.to_ir` → `RequestedFemDemagIR::PoissonDirichlet` | konkretny resolved FEM Poisson–Dirichlet | NOT VERIFIED | NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED |
| Demag `fredkin_koehler` | `Demag.to_ir` → `RequestedFemDemagIR::FredkinKoehler` | body-only FEM/BEM realization, osobna od airbox | unsupported jako FDM model | unsupported jako FDM model | source path / planner state present; managed runtime NOT VERIFIED | source path / planner state present; managed runtime NOT VERIFIED |
| Demag `bem` | `Demag.to_ir` → `RequestedFemDemagIR::Bem` | jawnie odrzucany jako niezrealizowany wariant | unsupported | unsupported | unsupported; planner rejection | unsupported; planner rejection |
| Demag `fmm` | `Demag.to_ir` → `RequestedFemDemagIR::Fmm` | jawnie odrzucany jako niezrealizowany wariant | unsupported | unsupported | unsupported; planner rejection | unsupported; planner rejection |
| Exchange | `Exchange.to_ir` → `EnergyTermIR::Exchange` | zwykły konserwatywny term; lane proof zależny od workloadu | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | bounded mixed-P1 source/contract scope; runtime NOT VERIFIED | bounded mixed-P1 source/contract scope; runtime NOT VERIFIED |
| Zeeman | `Zeeman.to_ir` → `EnergyTermIR::Zeeman` | jawnie modelowane pole zewnętrzne | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | bounded scope; runtime NOT VERIFIED | bounded scope; runtime NOT VERIFIED |
| Interfacial DMI | `InterfacialDMI.to_ir` → `EnergyTermIR::InterfacialDmi` | tylko zwykły wariant z obecnym loweringiem | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | capability/status zależne od planera; runtime NOT VERIFIED | wybrane mixed-P1 konfiguracje odrzucane; runtime NOT VERIFIED |
| Bulk DMI | `BulkDMI.to_ir` → `EnergyTermIR::BulkDmi` | planner zachowuje jawne ograniczenia boundary/normal | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | capability/status zależne od planera; runtime NOT VERIFIED | wybrane mixed-P1 konfiguracje odrzucane; runtime NOT VERIFIED |
| Rotated-interfacial DMI | `RotatedInterfacialDMI.to_ir` → `EnergyTermIR::RotatedInterfacialDmi` | authoring/lowering/planning; frequency-domain jawnie odrzucany | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED |
| `StaticFieldMap` | `StaticFieldMap.to_ir` → zewnętrzny field payload | FEM jest jawnie odrzucany przez planner | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | unsupported w bieżącym plannerze | unsupported w bieżącym plannerze |
| `ThermalNoise` | `ThermalNoise.to_ir` → term termiczny | FEM GPU jest jawnie odrzucany | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | unsupported w bieżącym plannerze |

Anizotropie są serializowane inaczej niż `EnergyTermIR`: legacy obiekty `UniaxialAnisotropy` i `CubicAnisotropy` z `packages/fullmag-py/src/fullmag/model/energy.py` są migrowane przez `packages/fullmag-py/src/fullmag/model/problem.py` do parametrów materiałowych `MaterialIR` w `crates/fullmag-ir/src/model.rs`. Dotyczy to `uniaxial_anisotropy`, `uniaxial_anisotropy_k2`, osi oraz `cubic_anisotropy_kc1/kc2/kc3`. Źródła operatorów są obecne we wszystkich czterech realizacjach; kwalifikacja pozostaje NOT VERIFIED. Rozbieżność docstringa i konwencji Ku2 opisuje DOC-03, a materializację mapy FEM — OBS-01.

Pozostałe jawne warianty `EnergyTermIR` to `OerstedCylinder`, `OerstedField` z `OerstedFieldModelIR::FromCurrentSolution` oraz `Magnetoelastic { magnet, body, law }`. Torque i transport nie są sprowadzane do tych wariantów energii; mają odrębne źródła, modele i relacje w grafie fizyki. Ich zakres czterech realizacji i ograniczenia podaje rozdział dynamiki/transportu, a prescribed-strain — aneks FEM. Klasy transportowe i sam graf nie dowodzą sprzężonego wykonania.

`Demag()` bez argumentów serializuje `realization="auto"`; `Demag(model="airbox")` serializuje już `poisson_robin`. Nie są to identyczne żądania. Wiersze jawnych metod airbox dotyczą FEM; nie zweryfikowano w tej macierzy skutku przekazania tych metod do FDM i nie należy interpretować komórek NOT VERIFIED jako potwierdzenia obsługi Poissona przez FDM.

### Ścieżki źródłowe macierzy

- `packages/fullmag-py/src/fullmag/model/energy.py::Demag` definiuje publiczny
  wybór modelu demagnetyzacji i jego serializację.
- `packages/fullmag-py/src/fullmag/model/energy.py::InterfacialDMI`,
  `BulkDMI` i `RotatedInterfacialDMI` są oddzielnymi wariantami DMI.
- `packages/fullmag-py/src/fullmag/model/energy.py::StaticFieldMap` i
  `packages/fullmag-py/src/fullmag/model/energy.py::ThermalNoise` są
  authorable, ale ich obecność nie znosi plannerowych ograniczeń lane.
- `crates/fullmag-ir/src/plan.rs::RequestedFemDemagIR` zawiera warianty
  `PoissonDirichlet`, `PoissonRobin`, `Bem`, `FredkinKoehler` i `Fmm`.
- `crates/fullmag-ir/src/plan.rs::ResolvedFemDemagIR` nie ma wariantu `Auto`;
  resolved plan musi być konkretny przed runnerem.
- `crates/fullmag-ir/src/study.rs::EnergyTermIR` jest wspólnym miejscem
  loweringu termów fizycznych i zawiera `RotatedInterfacialDmi`.
- `packages/fullmag-py/src/fullmag/model/problem.py::Problem.to_ir` tworzy
  canonicalny dokument z `backend_policy`, `validation_profile`, energią,
  materiałami i runtime metadata.
- `crates/fullmag-plan/src/lib.rs::physics_graph_realization_provenance`
  należy do warstwy, która opisuje realizację grafu fizycznego w planie.
- `crates/fullmag-runner/src/capabilities.rs::mixed_p1_feature_capabilities`
  publikuje bounded capability mixed-P1, ale sama publikacja nie jest receipt.
- `docs/specs/capability-matrix-v0.json::features` utrzymuje osobne statusy
  implementation, executability, validation i qualification.

## Finding DSL-CAP-01 — rotated-interfacial DMI zostało zintegrowane w DSL

**Status poprawki: source/contract PASS; runtime i kwalifikacja czterech lane’ów
pozostają NOT VERIFIED.**

`RotatedInterfacialDMI` zachowuje podpisane $D$ dla `D21=D32=D` w osobnym
wariancie `EnergyTermIR::RotatedInterfacialDmi`. Walidacja odrzuca wartości
nieskończone i duplikaty, planner zachowuje term dla FDM/FEM CPU/GPU w
time-domain oraz jawnie odrzuca wykonanie częstotliwościowe. Round-trip
Python/IR i testy operatorów przechodzą.

Brak bieżących managed receipts oznacza, że integracja źródłowa nie dowodzi
wykonania ani parytetu. Testy znaku, energii i pola wymagają nadal kwalifikacji
osobno dla FDM CPU/GPU i FEM CPU/GPU.

## Finding DSL-CAP-02 — `RuntimeSelection.precision()` gubi politykę FDM

**Status: POTWIERDZONE zachowanie settera; ocena jako defekt kontraktu pozostaje RYZYKIEM do rozstrzygnięcia.**

`packages/fullmag-py/src/fullmag/model/problem.py::RuntimeSelection.precision`
tworzy nowy wybór precyzji, ale nie zachowuje `fdm_precision_policy`. W
zweryfikowanym przypadku przejście przez `.precision("double")` usuwa wcześniej
ustaloną politykę `single_storage_fp64_reduction`. Wynikowy `to_runtime_metadata`
nie niesie wtedy tego żądania dalej.

To nie jest dowód, że kernel użył złej precyzji. Jest to dowód utraty jawnej
intencji przed plannerem i potencjalnej niespójności między skryptem, IR,
planem i receipt. Wywołanie `precision("double")` może być świadomym zastąpieniem wcześniejszej polityki przez użytkownika. Samo zniknięcie poprzedniego wyboru nie dowodzi wtedy błędu. Należy określić kontrakt kolejności setterów, w tym zachowanie po ustawieniu tej samej precyzji; potrzebna jest udokumentowana zasada zastąpienia, zachowania lub jawnego odrzucenia konfliktu.

Obszar dotknięty:

- `RuntimeSelection.fdm_precision_policy` — pole żądania;
- `RuntimeSelection.precision` — mutator zwracający nowy obiekt;
- `RuntimeSelection.to_runtime_metadata` — granica eksportu do IR;
- `Problem.to_ir` — miejsce zapisu `runtime_selection` i `backend_policy`.

Status walidacji fizycznej i runtime tego findingu: NOT VERIFIED. Potrzebny
focused test powinien ustawić `single_storage_fp64_reduction`, wywołać setter
precyzji, sprawdzić zachowanie polityki i porównać canonicalny IR.

## Finding DSL-CAP-03 — override urządzenia ma osobną granicę provenance

`packages/fullmag-py/src/fullmag/runtime/loader.py::apply_ir_runtime_device_override`
zapisuje launcherowy override w osobnym `runtime_device_override`, natomiast
`apply_ir_runtime_device_selection` modyfikuje mapy `runtime_selection` i ich
`gpu_count`/`device_index`. `Problem.to_ir` używa override także do preflightu
bounded mixed-P1, lecz nie powinien udawać, że override jest authored intent.

**Wniosek: POTWIERDZONE rozdzielenie warstw; ryzyko provenance wymaga kontroli
runnera.** Loader/runner musi przechować authored request, effective request i
resolved execution jako trzy rozróżnialne wartości. Nie wolno wyprowadzać
resolved device tylko z nazwy engine ani nadpisywać authored `auto` bez śladu.

W tym audycie nie wykonywano managed launchera ani nie sprawdzano receipt
przypisanego do tego override. Skutek runtime pozostaje NOT VERIFIED.

## Finding DSL-CAP-04 — fail-closed combinations są poprawnym ograniczeniem

`crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation` odrzuca
niekonserwatywne torque w workflow relaksacji, zamiast traktować je jako
minimum energii. Ten sam plannerowy kontrakt rozdziela także obecność modelu
od legalności lane.

Potwierdzone przykłady odrzucenia:

- `StaticFieldMap` w planie FEM nie jest obecnie automatycznie uznawany za
  executable tylko dlatego, że ma klasę DSL;
- `ThermalNoise` na FEM GPU jest odrzucany przed uruchomieniem;
- mieszany P1 z GPU DMI jest odrzucany przez stabilny predicate
  `gpu_dmi_kernel_not_mixed_p1`;
- `Bem` i `Fmm` są jawnie niezaimplementowanymi wariantami
  `RequestedFemDemagIR`;
- `TangentPlaneImplicit` w FDM jest FEM-only i nie może spaść do CPU bez
  jawnej, dozwolonej zmiany żądania.

Te odrzucenia są dowodem kontroli kontraktu, nie dowodem pełnej poprawności
operatorów. Każdy unsupported path powinien nadal przekazać requested
backend/device/precision/mode oraz reason code do diagnostyki.

## Provenance i granice dowodu

`Problem.to_ir` zapisuje requested backend oraz precision w
`backend_policy`, a execution mode w `validation_profile`. To potwierdza
serializację intencji, ale nie potwierdza resolved device ani wykonania.

`RequestedFemDemagIR` i `ResolvedFemDemagIR` potwierdzają, że auto-resolution
ma dwa poziomy reprezentacji. `ResolvedFemDemagIR` nie może pozostać `auto`.
Brak managed receipt, source identity, device identity, fallback mask i
completed artifact oznacza NOT VERIFIED niezależnie od statusu `implemented`.

W szczególności source/contract test `mixed_p1_feature_capabilities` nie
promuje FEM CPU/GPU do `production_executable`; obecny status opisuje bounded
zakres i wymaga świeżego managed workloadu. Podobnie obecność publicznego
modelu DMI nie promuje każdej jego realizacji.

## Konkluzja zakresowa

Najmocniejsze ustalenia DSL/capability to źródłowo zamknięta ścieżka
rotated-interfacial DMI bez kwalifikacji runtime, naprawiony kontrakt
`fdm_precision_policy` w `precision()` oraz osobna granica
launcherowego override oraz poprawne fail-closed odrzucenia unsupported
combination. Żaden z tych punktów nie upoważnia do twierdzenia o parytecie
FDM/FEM CPU/GPU. Do kwalifikacji pozostają niezależne testy round-trip,
planner acceptance/rejection, managed execution, source-bound provenance i
physics validation.
