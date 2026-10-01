# Niezależny replay sidecarów operatora non-shared Floqueta

- Status: `interpreted_source_only / runtime_unvalidated`
- Właściciel: Fullmag FEM frequency-domain backend
- Data: 2026-10-01
- Zakres: odczyt exact sidecarów operatora, kontrola więzi źródła i relacji
  macierzowych bez rekonstrukcji assembly native
- Powiązany kontrakt producenta: `docs/physics/r4-nonshared-floquet-operator-provenance.md`

(problem-statement)=
## 1. Problem i cel

Ścieżka non-shared publikuje operator Floqueta jako dokładne bajty JSON
`source_state`, `operator_input` i `matrix_pencil`. Sam digest operatora nie
pozwala sprawdzić, czy zapisane macierze zachowują relację jednostek,
żyrotropowy blok masy, fazy Floqueta i więź ze źródłem równowagi. Ten adapter
czyta rzeczywiste pliki, sprawdza referencje `path`, kodowanie, długość i
surowy SHA-256, a następnie wykonuje ograniczony replay algebraiczny.

Adapter nie tworzy `SharedDomainLinearizationState`, nie odtwarza macierzy z
samego skrótu i nie zamienia obecności sidecarów w dowód wykonania solvera.

(governing-equations)=
## 2. Równania sprawdzane przez replay

Zapisany matrix pencil ma postać

```{math}
:label: eq-nonshared-replay-pencil
K_{\omega}(\mathbf k)q = \lambda B(\mathbf k)q,
```

gdzie przejście jednostek w sidecarze musi spełniać

```{math}
:label: eq-nonshared-replay-gamma
K_{\omega}=\gamma_0 K_{\mathrm{field}}.
```

Wartość `gyromagnetic_ratio` w `FemEigenPlanIR` jest zredukowanym
`gamma0_rad_s_per_A_m`: ma jednostkę `rad s⁻¹ /(A m⁻¹)` (równoważnie
`m/(A s)`). Nie jest to bare `gamma_rad_s_T` w `rad s⁻¹ T⁻¹`; native
otrzymuje tę drugą wartość dopiero po podzieleniu przez `mu0`.

Dla bezpośredniej reprezentacji `2N` Rust buduje blok żyrotropowy z masy
stycznej `M_t`:

```{math}
:label: eq-nonshared-replay-gyro
G=\begin{bmatrix}0&M_t\\-M_t&0\end{bmatrix}.
```

Replay sprawdza powtarzalność dwóch bloków `M_t`, zerowe bloki krzyżowe oraz
zgodność `G` z macierzą `gyrotropic` zapisaną w sidecarze. Dla osadzenia
zespolonego `4N` sprawdzana jest poprawna liczba stopni swobody i struktura
antysymetryczna; dokładny operator native pozostaje osobnym artefaktem.

Dla każdej pary periodycznej obowiązuje faza

```{math}
:label: eq-nonshared-replay-phase
\phi=-\mathbf k\cdot\Delta\mathbf r,
\qquad q_b=\exp(i\phi)q_a.
```

W tym kroku sprawdzana jest pierwsza równość oraz zgodność identyfikatora,
indeksów węzłów, translacji i konwencji fazowej. Nie jest sprawdzana
polaryzacja ani wektor własny `q`.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `$K_{\mathrm{field}}$` | macierz pola liniaryzacji przed skalowaniem | `A/m` w reprezentacji mass-weighted |
| `$K_{\omega}$` | macierz przekazana do pencilu modalnego | `rad/s` |
| `$B$` | macierz po prawej stronie pencilu | zależna od normalizacji FEM |
| `$M_t$` | powtarzalna masa styczna | zależna od dyskretyzacji FEM |
| `$\gamma_0$` | współczynnik przejścia pola do częstości kątowej | `rad s⁻¹ /(A m⁻¹)`; `gamma0_rad_s_per_A_m` |
| `$\alpha$` | tłumienie planu eigen | `1` |
| `$\mathbf{k}$` | wektor falowy | `rad/m` |
| `$\Delta\mathbf{r}$` | translacja pary periodycznej | `m` |
| `$\phi$` | faza Floqueta | `rad` |
| `$\lambda$` | wartość własna pencilu | `s⁻¹` |
| `$q$` | wektor perturbacji modalnej | `1` |
| `$G$` | blok żyrotropowy z masy stycznej | zależna od normalizacji FEM |

(assumptions-and-validity)=
## 4. Założenia i granice

Replay wymaga sidecaru tożsamości `nonshared_floquet_operator_identity.v1`,
wrappera exact preimage, stanu źródłowego oraz referencji do preimage
operatora i macierzy. Ścieżki są względne wobec wskazanego katalogu artefaktu;
ścieżka absolutna lub wychodząca przez `..` jest odrzucana.

Walidator parsuje JSON z odrzuceniem zduplikowanych kluczy, liczb
nieskończonych, niepoprawnego UTF-8 i nadmiernego zagnieżdżenia. Hashuje
wyłącznie bajty odczytane z pliku. Nie rekonstruuje bajtów Rust przez
`json.dumps`. Parser ścieżek `nonshared_source` wymaga niepustych
komponentów POSIX, odrzuca `.`, `..` i backslash oraz zachowuje exact bytes
bez reserializacji.

`source_replay_qualified` pozostaje właściwością producenta. Gdy jest `false`,
raport może potwierdzić integralność i algebraiczną spójność operatora, ale
zgłasza `source_replay_not_qualified`. Brak preimage fizycznych (`material`,
statyczna fizyka, granica, raw material provenance) nie jest zastępowany
bieżącym planem modalnym.

(python-api)=
## 5. Python API

Narzędzie nie zmienia publicznego DSL. Wewnętrzny adapter ma funkcję:

```python
# %%
from pathlib import Path
from scripts.fem_nonshared_operator_replay import replay_nonshared_operator

# %%
report = replay_nonshared_operator(Path("/path/to/artifact"), sample_index=3)
```

Wynik `NonSharedOperatorReplayReport` rozdziela `status` operatora,
`scientific_qualification`, digesty, relacje macierzowe, liczbę par i listę
luk. Opcjonalne `operator_diagnostics` pozwala sprawdzić etykiety jednostek
opublikowane przez native; nie jest ono zgadywane, gdy sidecar go nie zawiera.

(problem-ir)=
## 6. ProblemIR

Brak nowych pól ProblemIR i brak zmian round-trip. Adapter konsumuje istniejące
`k_sampling`, `spin_wave_bc`, `material.damping`, macierze i status provenance
z artefaktu eigen. Nie traktuje `k=0` jako automatycznej ścieżki shared-domain.
`requested intent` pozostaje intencją planu, a `resolved execution` pochodzi z
artefaktu runnera; replay nie dopisuje żadnego z tych pól.

### Transport manifestu dla single-k i multi-k

Producent publikuje trzy immutable sidecary w każdym obliczonym próbkowym
katalogu `eigen/metadata/sample_NNNN/`:

| Plik | Tablica manifestu | Alias single-sample |
|---|---|---|
| `nonshared_floquet_operator_identity.v1.json` | `nonshared_floquet_operator_identity_v1_paths` | `nonshared_floquet_operator_identity_v1_path` |
| `nonshared_floquet_operator_identity_preimage.v1.json` | `nonshared_floquet_operator_identity_preimage_v1_paths` | `nonshared_floquet_operator_identity_preimage_v1_path` |
| `nonshared_floquet_source_state.v1.json` | `nonshared_floquet_source_state_v1_paths` | `nonshared_floquet_source_state_v1_path` |

W single-k i multi-k tablice są porządkowane numerycznie po `sample_index`.
Alias jest ścieżką tylko wtedy, gdy dana tablica zawiera dokładnie jeden wpis;
w przeciwnym razie ma wartość `null`. Coverage porównuje zbiór ścieżek z
rzeczywistym zbiorem obliczonych próbek. Brak wszystkich trzech plików dla
którejkolwiek próbki, próbka spoza wyniku lub niekanoniczny zapis
`sample_NNNN` daje stan `NOT_VERIFIED` i nie jest częściowym sukcesem.

Nieobecność sidecarów jest oznaczona jako `historical`. Obecność pełnego zbioru
przenosi jedynie diagnostykę do `path_coverage_complete`; pole
`qualification` oraz `scientific_qualification` pozostają `NOT_VERIFIED`, a
`operator_replay` wymaga niezależnego adaptera tego dokumentu. Ten transport
nie zasila rodziny shared R4 i nie tworzy `SharedDomainLinearizationState`.

(round-trip-and-failure-semantics)=
## 7. Semantyka odczytu i błędów

1. Najpierw sprawdzane są schema, sample index i exact identity preimage.
2. Następnie sidecar `source_state` jest porównywany z jego preimage z pustym
   `content_sha256`; digest źródła musi wiązać identity i operator.
3. Referencje operatora i macierzy muszą mieć `utf-8-json-bytes`, poprawną
   długość, surowy SHA oraz zgodny `semantic_signature`.
4. Preimage fizycznych źródeł są sprawdzane przez ich właściwy namespace.
5. Błąd ścieżki, digestu, schema, fazy, wymiaru, `K_omega`, `B` lub masy
   kończy się `NonSharedReplayError`.

Brakujące sidecary nie są raportowane jako częściowy sukces. Renderowany mesh
payload jest kontrolowany przez swój SHA, lecz obecna produkcyjna schema nie
umieszcza go w `exact_replay_refs`; dlatego raport zachowuje lukę
`mesh_payload_not_in_exact_replay_refs`.

Niepoprawny artefakt zwraca `validation errors` przez wyjątek
`NonSharedReplayError`. Niezgodne lub nieobsługiwane kombinacje zapisuje jako
`unsupported combinations` i zatrzymuje przed raportem replayowalności; nie ma
cichego fallbacku na bieżący plan.

(discrete-realization)=
## 8. Realizacja dyskretna

`matrix_pencil` jest row-major i ma jeden z dwóch wariantów:

- `direct_real_tangent`: `dimension = 2 * active_node_count`, z dokładnym
  blokiem `G = [[0,M],[-M,0]]`;
- `complex_bloch_real_embedding`: `dimension = 4 * active_node_count`, z
  kontrolą skończonych wartości i antysymetrycznej struktury `B`.

W obu wariantach `stiffness_field_a_per_m` i
`stiffness_omega_rad_s` muszą mieć tę samą macierz row-major. Jeżeli plan
źródłowy zawiera skończony `gyromagnetic_ratio`, replay sprawdza skalowanie
każdego elementu. `alpha` musi być identyczne w operator input i stanie
źródłowym oraz ma jednostkę `1`.

Weryfikacja seam obejmuje `pair_id`, `node_a`, `node_b`, translację, konwencję
fazy i `phase_rad`. Identyfikatory `mesh_topology_sha256`,
`source_mesh_topology_sha256`, `mesh_payload_sha256` i ścieżka payloadu muszą
być identyczne w identity, operator input i nested source mesh record.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `scripts/fem_nonshared_operator_replay.py` — parser fail-closed, resolver
  exact refs, replay preimage i kontrola `K_field/K_omega/B/M_t`, tłumienia,
  faz oraz source IDs;
- `scripts/test_fem_nonshared_operator_replay.py` — frozen literal SHA,
  pozytywny replay oraz mutacje digestu, skali gamma, fazy i ścieżki;
- `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` — producent
  sidecarów i schemat referencji, źródło bieżącego kontraktu;
- `crates/fullmag-runner/src/fem/eigen_native_window.rs` — źródło konwencji
  jednostek, masy i bloków żyrotropowych;
- `crates/fullmag-runner/src/fem/eigen_output.rs` —
  `inspect_nonshared_floquet_sidecars` sprawdza kanoniczne ścieżki i pełne
  pokrycie próbek, a `write_eigen_v2_bundle` publikuje tablice oraz aliasy;
- `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` —
  `build_eigen_path_frequency_domain_manifest` przenosi ten sam kontrakt do
  manifestu multi-k;
- `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` —
  `single_k_signed_state_artifact` zachowuje i remapuje trzy sidecary bez
  zmiany ich bajtów.
- `docs/physics/r4-nonshared-floquet-operator-provenance.md` — kontrakt
  publikacji producenta.

(validation)=
## 10. Walidacja

Uruchomiona bramka interpretowana:

```text
python -B -m unittest scripts.test_fem_nonshared_operator_replay -v
15 tests: PASS
```

Dodano przygotowane regresje Rust dla historycznego braku, pełnego single-/
multi-k coverage, częściowej tablicy i niekanonicznej/obcej próbki. Z powodu
obowiązującego zakazu kompilacji testów jednostkowych nie uruchamiano tych
testów natywnie. Sprawdzono także parser AST nowego modułu. Są to dowody source/interpreted;
nie uruchamiano natywnego testu jednostkowego, managed builda, runnera ani
rzeczywistego artefaktu z wykonania FEM.

(limitations)=
## 11. Ograniczenia i jawne luki

Replay sidecarów nie odtwarza assembly MFEM/PETSc, nie ma exact payloadu
`operator_diagnostics`, nie porównuje digestu actual native magnetic pencil,
nie rozwiązuje wartości własnych i nie mierzy residualu. Z tego powodu każdy
raport zwraca `scientific_qualification = NOT_VERIFIED`, nawet gdy wszystkie
czytane preimage i relacje algebraiczne są spójne.

Obecny sidecar nie udostępnia jeszcze niezależnemu Pythonowi pełnych bajtów
diagnostyki native ani osobnej referencji mesh payloadu z length/encoding;
pozostają one zapisaną luką kontraktu, a nie są uzupełniane z bieżącego źródła.

(scientific-bibliography)=
## 12. Bibliografia naukowa

- Bloch, F., *Über die Quantenmechanik der Elektronen in Kristallgittern*,
  Zeitschrift für Physik 52 (1929), 555–600 — faza Blocha.
- Brown, W. F., *Micromagnetics*, Interscience (1963) — energia i
  liniaryzacja magnetyczna.
- Wewnętrzny kontrakt Fullmag `r4-nonshared-floquet-operator-provenance.md`
  oraz `frequency-domain-artifacts-v2.md` — serializacja i granice dowodów.

(source-code-index)=
## 13. Indeks źródeł

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| `scripts/fem_nonshared_operator_replay.py` | `replay_nonshared_operator` | niezależny odczyt i kontrola algebraiczna |
| `scripts/test_fem_nonshared_operator_replay.py` | `class NonSharedOperatorReplayTests` | frozen literal i mutacyjne regresje |
| `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_nonshared_operator_replay` | routing manifestu i kompletność policzonych próbek |
| `scripts/test_fem_nonshared_operator_routing.py` | `class NonsharedOperatorRoutingTests` | rzeczywisty fixture bez mocka, coverage i odrzucenie podmian |
| `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` | `build_nonshared_floquet_provenance` | producent exact refs/preimage |
| `crates/fullmag-runner/src/fem/eigen_native_window.rs` | `gyrotropic_matrix_row_major_from_tangent_mass` | jednostki i blok `G` |
| `crates/fullmag-runner/src/fem/eigen_output.rs` | `inspect_nonshared_floquet_sidecars` | osobna strukturalna kontrola coverage i manifest single-k |
| `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | `build_eigen_path_frequency_domain_manifest` | plural arrays i aliasy multi-k |
| `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `remap_single_k_mode_artifacts` | zachowanie exact bytes, canonical paths i tożsamości próbki |
| `crates/fullmag-runner/src/fem/eigen_output.rs` | `inspect_nonshared_floquet_sidecars` | canonical paths, pełne coverage i fail-closed status |
| `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` | `build_eigen_path_frequency_domain_manifest` | manifest multi-k i aliasy single-sample |
| `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` | `single_k_signed_state_artifact` | zachowanie/remap exact sidecarów |
| `docs/physics/r4-nonshared-floquet-operator-provenance.md` | `build_nonshared_floquet_provenance` | kontrakt publikacji |

Status `interpreted_source_only` oznacza, że wynik jest użytecznym dowodem
integralności artefaktów i relacji danych, ale nie zamyka walidacji runtime ani
kwalifikacji naukowej dyspersji.

Główny verifier odczytuje trzy plural arrays `nonshared_floquet_*_v1_paths`
dla identity, identity preimage oraz source state. Wszystkie muszą zawierać
ten sam uporządkowany zbiór policzonych próbek; singular alias jest dozwolony
wyłącznie dla jednej próbki i musi wskazywać tę samą ścieżkę. Brak deklaracji
w historycznym pakiecie pozostaje `NOT_VERIFIED`; jawnie zadeklarowane puste
lub niekompletne tablice powodują błąd walidacji. Obecny routing nie dopisuje
shared identity i nie awansuje statusu natywnego operatora ani kwalifikacji
naukowej po poprawnym replayu algebraicznym. Pięć regresji routingu przeszło
na rzeczywistym interpretowanym fixture bez mocka; nie jest to wykonanie FEM.
