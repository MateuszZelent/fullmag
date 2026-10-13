# Pochodzenie granicy magnetostatycznej dla modalnego FEM

- Status: FEM CPU `source_visible / unvalidated`; normalizacja metadanych jest
  sprawdzona źródłowo, lecz nie ma jeszcze kompilacji natywnej ani managed
  runtime dla tej zmiany
- Zakres: rozróżnienie kontraktu K0 i niezerowego Floqueta w diagnostyce
  adaptera Poisson-airbox
- Powiązana nota: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`

Ta nota zamraża małą, ale istotną granicę dowodu: nazwa adaptera native nie
może sama dopisać `periodic_airbox_k0` do wyniku dla planu Floqueta. Wspólny
diagnostyczny envelope jest produkowany dla obu tras, dlatego jego pola są
wyprowadzane z pary `(plan, adapter)`.

(problem-statement)=
## 1. Problem

Przed zmianą normalizator wpisywał K0 do `requested_execution` oraz
`boundary_gauge`, a `production_periodic_airbox_claim` i zakres
`fem_k0_periodic_airbox_p1_double_cpu_slepc` były stałe dla każdego
rozpoznanego adaptera Poisson-airbox. To mieszało niezerowy operator Floqueta
z K0 i mogło stworzyć fałszywy zakres walidacji. Naprawa dotyczy wyłącznie
proweniencji i nie jest dowodem zgodności częstotliwości z COMSOL-em.

(governing-equations)=
## 2. Reguła kontraktu

Niech $c$ będzie klasyfikacją diagnostycznego kontraktu, a $k$ wektorem
falowym planu. Planowany envelope zachowuje semantyczną intencję Floqueta,
natomiast wykonanie rozpoznanego adaptera stosuje regułę:

```{math}
:label: eq-adapter-plan-boundary-contract
c(P,A)=
\begin{cases}
\texttt{floquet\_airbox}, & A=\texttt{floquet\_airbox\_cpu\_schur\_slepc}\ \land\ P\ \text{spełnia pełny niezerowy tor Floqueta},\\
\texttt{periodic\_airbox\_k0}, & A\in A_{K0}\ \land\ P\ \text{spełnia pełną bramę shared-domain K0},\\
\text{RunError}, & A\ \text{jest rozpoznany, lecz warunek planu nie jest spełniony}.
\end{cases}
```

W pierwszym przypadku `production_periodic_airbox_claim=false` i
`validated_scope=null`. W drugim zachowujemy kontrakt K0, lecz wyłącznie
adapter `k0_poisson_airbox_cpu_schur_slepc` może publikować istniejący scope;
pełny-coupled CPU oraz GPU zachowują `null` scope. Rozpoznany mismatch kończy
normalizację przed publikacją modów; nie jest zamieniany na częściowy artefakt.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| c | klasyfikacja kontraktu granicy magnetostatycznej | 1 |
| k | wektor falowy planu | rad/m |
| A | identyfikator adaptera native | 1 |

(assumptions-and-validity)=
## 4. Założenia i granice

- `planned_magnetostatic_bc` zapisuje `floquet_airbox`, gdy plan jawnie żąda
  Floqueta z demagiem, nawet jeśli niepoprawne pary lub target później
  zablokują wykonanie. To jest intent, nie dowód uruchomienia operatora.
- `native_cpu_modal_window_has_floquet_dynamic_demag_path` wymaga demaga,
  Full2x2, ignorowanego tłumienia, wspólnej domeny z airboxem, Poissona,
  poprawnych par siatki i co najmniej jednego niezerowego punktu `k`.
- `native_shared_domain_cpu_modal_supported` ponownie używa pełnej bramy K0,
  obejmującej pary węzłów, pary granic airboxa, rozmiar airboxa i dostępność
  magnetycznego assembly; sama nazwa adaptera ani `shared_domain_k0_modal_requested`
  nie wystarcza.
- K0-only metrics parser nadal wymaga `demag_kind=periodic_airbox_k0`; ten
  parser nie jest rozszerzany na Floqueta.
- Testy przygotowane w Rust są dowodem źródłowym. Kompilacja natywna, managed
  runtime, zbieżność siatki i walidacja fizyczna pozostają `NOT VERIFIED`.

(python-api)=
## 5. Python API

Publiczny Python DSL nie dostaje nowych parametrów. Autor nadal żąda
`magnetostatic_bc="periodic_airbox_k0"` dla Gamma albo
`magnetostatic_bc="floquet_airbox"` dla niezerowego `k`; ta nota opisuje
wyłącznie transport i normalizację artefaktu wykonania.

```python
# %%
requested = {"k": [1.0e6, 0.0, 0.0], "magnetostatic_bc": "floquet_airbox"}
assert requested["magnetostatic_bc"] == "floquet_airbox"
```

(problem-ir)=
## 6. ProblemIR i provenance

`FemEigenPlanIR` jest źródłem prawdy dla fizycznego planu. `solver_adapter`
jest faktem wykonania. `requested intent` pozostaje oddzielone od
`resolved execution`; żadne z tych pól nie jest rekonstruowane z samej nazwy
K0. `production_periodic_airbox_claim` jest twierdzeniem o scope, a nie
synonimem udanego rozwiązania własnego.

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

`bind_planned_execution_diagnostics` wpisuje granicę z planu, a native
normalizer ponownie wiąże ją z adapterem. `validation errors` zatrzymują
niekompletne K0/GPU kontrakty. `unsupported combinations` pozostają
`not_applicable`, bez cichego fallbacku. W razie rozbieżności pary
rozpoznany plan–adapter normalizator zwraca `RunError` przed publikacją modów;
nie powstaje częściowy artefakt z odziedziczonym K0 scope ani claimem.

(discrete-realization)=
## 8. Realizacja dyskretna

`planned_magnetostatic_bc` obsługuje wspólny envelope planu i zachowuje
semantyczne żądanie Floqueta. Następnie
`native_poisson_airbox_execution_contract` klasyfikuje adapter Floquet albo
K0 po sprawdzeniu odpowiedniej bramy planu, zwracając `RunError` dla
rozpoznanego mismatchu. Oba miejsca zapisują ten sam `magnetostatic_bc`;
hardened contract ustawia claim i scope z tej klasyfikacji.
Nie zmienia to macierzy, fazy Blocha, residualu ani C ABI.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `eigen_capability.rs::native_cpu_modal_window_has_floquet_dynamic_demag_path`
  — pełna brama niezerowego Floqueta.
- `eigen_policy.rs::shared_domain_k0_modal_requested` — wstępna intencja K0.
- `eigen_capability.rs::native_shared_domain_cpu_modal_supported` — pełna
  brama wykonania K0 z metadanymi par siatki i assembly.
- `eigen_native_window.rs::planned_magnetostatic_bc` — planowany envelope.
- `eigen_native_window.rs::native_poisson_airbox_execution_contract` — wspólna
  klasyfikacja planu i adaptera.
- `eigen_native_window.rs::insert_native_poisson_airbox_hardened_contract` —
  publikacja claim/scope/BC.
- `eigen_native_result.rs::is_native_poisson_airbox_modal_adapter` — allowlist
  adapterów, bez rozszerzania K0-only metryk.
- `eigen_native_result.rs::is_native_k0_poisson_airbox_modal_adapter` — osobna
  allowlista K0 używana przez parser metryk Kittel.

(validation)=
## 10. Walidacja

Przygotowane regresje sprawdzają prawidłowy niezerowy Floquet, zachowanie
semantycznej etykiety Floqueta przy niepełnym planie, rozbieżność Floquet-plan
z adapterem K0 jako `RunError`, brak scope dla pełnego-coupled/GPU oraz scope
wyłącznie dla CPU Schur. Kontrole parsera Rust i walidator tej noty wykonano
źródłowo; native unit compilation, managed runner i physics qualification są
`NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia

Brak claimu nie oznacza, że operator Floqueta jest już zwalidowany. Nota nie
rozstrzyga residual threshold, zbieżności airboxa, doboru siatki ani parytetu
z analityką lub COMSOL-em. K0 metrics i ich Pythonowe weryfikatory pozostają
celowo ograniczone do K0.

(scientific-bibliography)=
## 12. Bibliografia naukowa

- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` —
  równania liniaryzacji i granice kwalifikacji Floqueta.
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md` — znaczenie
  granicy okresowej i fazy Blocha.

(source-code-index)=
## 13. Indeks źródeł

| Plik | Symbol | Rola |
|---|---|---|
| `crates/fullmag-runner/src/fem/eigen_capability.rs` | `native_cpu_modal_window_has_floquet_dynamic_demag_path` | Brama pełnego niezerowego toru Floqueta. |
| `crates/fullmag-runner/src/fem/eigen_policy.rs` | `shared_domain_k0_modal_requested` | Wstępna intencja K0. |
| `crates/fullmag-runner/src/fem/eigen_capability.rs` | `native_shared_domain_cpu_modal_supported` | Pełna brama K0: pary mesh, airbox i magnetic assembly. |
| `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `planned_magnetostatic_bc` | Planowany BC. |
| `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `native_poisson_airbox_execution_contract` | Klasyfikacja adapter–plan. |
| `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `insert_native_poisson_airbox_hardened_contract` | Claim, scope i boundary gauge. |
| `crates/fullmag-runner/src/fem/eigen_native_result.rs` | `is_native_poisson_airbox_modal_adapter` | Allowlista adapterów. |
| `crates/fullmag-runner/src/fem/eigen_native_result.rs` | `is_native_k0_poisson_airbox_modal_adapter` | Ścisła allowlista parsera metryk K0. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `native_nonzero_floquet_diagnostics_bind_floquet_boundary_without_k0_claim` | Regresja poprawnego Floqueta. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `native_nonzero_floquet_plan_rejects_k0_adapter_claim_and_boundary_label` | Regresja mismatch fail-closed. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `planned_floquet_boundary_label_survives_invalid_execution_capability` | Regresja zachowania semantycznego Floqueta przed bramą wykonania. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `native_floquet_adapter_rejects_incomplete_plan_before_mode_publication` | Regresja błędu Floquet adapter–plan przed publikacją modów. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `native_poisson_airbox_top_level_accepted_mode_count_is_preserved` | Regresja scope tylko dla CPU Schur na pełnym fixture K0. |
| `crates/fullmag-runner/src/fem/eigen_tests.rs` | `native_poisson_airbox_k0_metrics_reject_floquet_adapter_even_with_k0_demag_kind` | Regresja ochrony parsera K0-only. |
