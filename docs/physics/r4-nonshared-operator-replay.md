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

Nowe bundle producenta mogą dodatkowo publikować w `exact_replay_refs` wpis
`mesh_payload` o schemacie `nonshared_floquet_mesh_payload.v1`. Wpis wiąże
`sample_index`, kanoniczną ścieżkę próbki, `encoding`, `byte_length`,
`raw_sha256` i `semantic_signature` z tymi samymi bajtami, które są zapisane
pod `mesh_payload_path`; `semantic_signature` i surowy SHA muszą być równe
`identity.mesh_payload_sha256`. Wpis jest addytywny i opcjonalny dla odczytu
historycznych artefaktów. Jego brak pozostaje jawną luką
`mesh_payload_not_in_exact_replay_refs` i nie podnosi kwalifikacji naukowej.

### Finalna diagnostyka wejściowa C ABI

Po scaleniu provenance producent tworzy dokładny, finalny JSON
`operator_diagnostics_json`, który jest przekazywany do `solve_native_modal_eigen`.
Historyczny `operator_diagnostics_sha256` pozostaje digestem bazowego obiektu
diagnostycznego użytego przy budowie `operator_input`; nie jest zmieniany ani
przemianowywany. Finalny JSON jest publikowany jako surowe bajty w:

```text
eigen/metadata/sample_NNNN/nonshared_source/native_input_operator_diagnostics.v1.json
eigen/metadata/sample_NNNN/nonshared_source/native_input_operator_diagnostics_preimage.v1.json
```

Finalny obiekt ma addytywne pola `sample_index`, ścieżkę finalnego payloadu,
ścieżkę preimage oraz `nonshared_floquet_native_input_diagnostics_sha256`.
Zawiera także `operator_diagnostics_sha256` i `operator_diagnostics_schema`,
przeniesione z bazowego obiektu diagnostycznego. Dzięki temu Python może
sprawdzić, że finalny JSON C ABI wskazuje ten sam digest i schemat, które
zostały związane z `operator_input`, zamiast ufać polom dopisanym przez
konsumenta.
W ścieżce zespolonej ten obiekt bazowy jest tworzony przez wspólny konstruktor
używany zarówno przy wyliczaniu digestu provenance, jak i bezpośrednio przed
wywołaniem C ABI; zapobiega to związaniu digestu z innym zestawem pól jednostek
lub inną konwencją bloku żyrotropowego.
Ten digest jest SHA-256 dokładnych bajtów preimage, w którym jego własna
wartość jest pusta. Referencja artefaktowa publikuje osobno długość i surowy
SHA-256 finalnych bajtów oraz preimage w
`nonshared_floquet_native_input_diagnostics_exact_refs`. Referencja nie jest
dodawana do `exact_replay_refs`, ponieważ ten obiekt jest częścią finalnego
wejścia C ABI i wprowadziłby cykl hashy. Zewnętrzny obiekt referencji ma
schemat `nonshared_floquet_native_input_diagnostics_refs.v1` i jest wybierany
po `sample_index`; deklaracja innej próbki jest filtrowana, a deklaracja
częściowa lub brakująca kończy replay błędem.

Pythonowy replay automatycznie odczytuje finalny sidecar, porównuje go z
preimage po wyzerowaniu tylko pola digestu, sprawdza oba surowe SHA i wiąże
diagnostykę z identity, source state, matrix pencil, `operator_input` oraz
`exact_replay_refs`. Brak sidecaru zachowuje jawną lukę
`native_input_diagnostics_not_published`; jego obecność nie dowodzi jeszcze
rekonstrukcji native matrix pencil, residualu ani zgodności z COMSOL/TetraX.
Manifesty single-k i multi-k mają teraz także jawne, pluralne tablice ścieżek
dla obu tych finalnych sidecarów. Są one osobną bramką strukturalnego pokrycia
artefaktów, a nie dowodem fizycznego operatora; `qualification` i
`scientific_qualification` pozostają `NOT_VERIFIED`.

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

Producent publikuje trzy historyczne immutable sidecary bezpośrednio w każdym
obliczonym katalogu `eigen/metadata/sample_NNNN/` oraz, gdy finalny input C ABI
został zapisany, dwa addytywne sidecary diagnostyczne w jego kanonicznym
podkatalogu `nonshared_source/`:

| Plik | Tablica manifestu | Alias single-sample |
|---|---|---|
| `nonshared_floquet_operator_identity.v1.json` | `nonshared_floquet_operator_identity_v1_paths` | `nonshared_floquet_operator_identity_v1_path` |
| `nonshared_floquet_operator_identity_preimage.v1.json` | `nonshared_floquet_operator_identity_preimage_v1_paths` | `nonshared_floquet_operator_identity_preimage_v1_path` |
| `nonshared_floquet_source_state.v1.json` | `nonshared_floquet_source_state_v1_paths` | `nonshared_floquet_source_state_v1_path` |
| `nonshared_source/native_input_operator_diagnostics.v1.json` | `nonshared_floquet_native_input_diagnostics_v1_paths` | `nonshared_floquet_native_input_diagnostics_v1_path` |
| `nonshared_source/native_input_operator_diagnostics_preimage.v1.json` | `nonshared_floquet_native_input_diagnostics_preimage_v1_paths` | `nonshared_floquet_native_input_diagnostics_preimage_v1_path` |

W single-k i multi-k każda rodzina ma tablicę porządkowaną numerycznie po
`sample_index`. Alias jest ścieżką tylko wtedy, gdy dana tablica zawiera
dokładnie jeden wpis; w przeciwnym razie ma wartość `null`. Historyczna
coverage porównuje trzy ścieżki z rzeczywistym zbiorem obliczonych próbek.
Oddzielna coverage diagnostyki porównuje dwie nowe ścieżki. Brak sidecara w
rodzinie, próbka spoza wyniku lub niekanoniczny zapis `sample_NNNN` daje
`missing_sidecars` albo `invalid` dla odpowiedniej rodziny. Nowa coverage
diagnostyczna dodatkowo odrzuca zduplikowaną ścieżkę, a zachowanie historycznej
rodziny trzech sidecarów pozostaje bez migracji; status jednej rodziny nie
zmienia statusu drugiej.

Nieobecność wszystkich sidecarów jest oznaczona jako `historical`. Historyczny
pakiet zawierający tylko trzy podstawowe rodziny zachowuje dotychczasowy
`path_coverage_complete` i swoje aliasy; brak dwóch addytywnych diagnostyk jest
raportowany osobno jako `historical`, bez migracji w locie. Obecność obu nowych
rodzin przenosi ich osobną diagnostykę do `path_coverage_complete`; pole
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
4. Jeśli obecna jest referencja `mesh_payload`, jej sample, ścieżka, długość,
   kodowanie, surowy SHA i `semantic_signature` są sprawdzane względem
   rzeczywistych bajtów meshu oraz `identity.mesh_payload_sha256`.
5. Preimage fizycznych źródeł są sprawdzane przez ich właściwy namespace.
6. Błąd ścieżki, digestu, schema, fazy, wymiaru, `K_omega`, `B` lub masy
   kończy się `NonSharedReplayError`.

Brakujące sidecary nie są raportowane jako częściowy sukces. Nowe bundle’y
wiążą mesh także przez exact ref. Historyczny bundle bez tego wpisu nadal może
sprawdzić bajty przez `mesh_payload_path`, lecz raport zachowuje lukę
`mesh_payload_not_in_exact_replay_refs`.

Ścieżki POSIX są sprawdzane w surowej postaci przed normalizacją przez
`Path`: komponenty puste, `.` i `..` są odrzucane. Dzięki temu podpisany
sidecar nie może używać aliasu `./` lub podwójnego separatora `//` dla tego
samego pliku. Kontrola containment po rozwiązaniu ścieżki nadal obowiązuje.

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

Porównania elementów macierzy mają względną tolerancję
$5\cdot10^{-11}$ i zerową tolerancję absolutną. Stały próg absolutny
`1e-12` jest niepoprawny dla małych, masowo ważonych wpisów FEM: mógłby
zaakceptować nawet wyzerowanie całej niezerowej macierzy częstotliwościowej.
Kontrola zerowych bloków i powtarzalnych bloków masy używa tej samej
względnej tolerancji pomnożonej przez największy moduł wpisu macierzy masy.
Wariant direct wymaga również zerowych diagonalnych bloków macierzy
żyrotropowej. Te progi dotyczą algebraicznego replayu artefaktów, nie
residuali ani tolerancji produkcyjnego solvera. Dla faz i bezwymiarowego
tłumienia zachowano dotychczasową tolerancję skalarną.

Weryfikacja seam obejmuje `pair_id`, `node_a`, `node_b`, translację, konwencję
fazy i `phase_rad`. Identyfikatory `mesh_topology_sha256`,
`source_mesh_topology_sha256`, `mesh_payload_sha256` i ścieżka payloadu muszą
być identyczne w identity, operator input i nested source mesh record.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `scripts/fem_nonshared_operator_replay.py` — parser fail-closed, resolver
  exact refs, replay preimage i kontrola `K_field/K_omega/B/M_t`, tłumienia,
  faz, source IDs, exact finalnego wejścia C ABI oraz opcjonalnej referencji
  exact mesh payloadu;
- `scripts/test_fem_nonshared_operator_replay.py` — frozen literal SHA,
  pozytywny replay, mutacje digestu/skali gamma/fazy/mesh ref oraz zgodność
  z historycznym bundle bez mesh ref;
- `scripts/test_fem_nonshared_native_input_diagnostics.py` — exact finalny
  payload C ABI, preimage, zewnętrzne raw refs i mutacje fail-closed;
- `scripts/test_nonshared_native_input_diagnostics_source.py` — source-only
  kontrola finalizera przed obiema ścieżkami C ABI i zachowania starego digestu;
- `scripts/test_nonshared_floquet_manifest_contract_source.py` — source-only
  kontrola wspólnych selektorów historycznych i diagnostycznych dla
  single-k/multi-k, nazw tablic,
  aliasów, kanonicznego `nonshared_source` i fail-closed dla
  duplikatów/historycznych luk;
- `scripts/verify_fem_frequency_domain_eigen_artifacts.py` — walidator
  konsumencki rozdziela historyczne trzy rodziny od nowej pary, sprawdza
  rzeczywiste pola `sample_index`/path/preimage sidecara i nie podnosi
  kwalifikacji fizycznej;
- `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` — producent
  sidecarów i schemat referencji, w tym exact `mesh_payload` ref wiążący
  rzeczywiste bajty meshu z próbką oraz finalizer dokładnych bajtów
  `operator_diagnostics_json`;
- `crates/fullmag-runner/src/fem/eigen_native_window.rs` — źródło konwencji
  jednostek, masy i bloków żyrotropowych;
- `crates/fullmag-runner/src/fem/eigen_output.rs` —
  `inspect_nonshared_floquet_sidecars` sprawdza kanoniczne ścieżki i pełne
  pokrycie trzech historycznych rodzin, a osobna coverage diagnostyczna
  odrzuca zduplikowane ścieżki; `write_eigen_v2_bundle` publikuje trzy stare
  tablice oraz opcjonalne dwie tablice diagnostyczne i ich aliasy;
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
python -B -m unittest -v scripts.test_fem_nonshared_native_input_diagnostics scripts.test_nonshared_native_input_diagnostics_source scripts.test_fem_nonshared_operator_replay scripts.test_fem_nonshared_operator_routing scripts.test_nonshared_floquet_manifest_contract_source
43 tests: PASS
```

Dodano przygotowane regresje Rust dla historycznego braku, pełnego single-/
multi-k coverage, osobnej coverage obu nowych rodzin diagnostycznych,
częściowej tablicy, duplikatu i niekanonicznej/obcej próbki. Z powodu
obowiązującego zakazu kompilacji testów jednostkowych nie uruchamiano tych
testów natywnie. Sprawdzono także parser AST nowego modułu. Są to dowody source/interpreted;
nie uruchamiano natywnego testu jednostkowego, managed builda, runnera ani
rzeczywistego artefaktu z wykonania FEM.

(limitations)=
## 11. Ograniczenia i jawne luki

Replay sidecarów nie odtwarza assembly MFEM/PETSc, nie porównuje digestu actual
native magnetic pencil, nie rozwiązuje wartości własnych i nie mierzy residualu.
Dokładny finalny payload `operator_diagnostics` jest już publikowany i wiązany
z preimage oraz zewnętrznym raw SHA, ale nie zamyka to bramki wykonania native.
Z tego powodu każdy
raport zwraca `scientific_qualification = NOT_VERIFIED`, nawet gdy wszystkie
czytane preimage i relacje algebraiczne są spójne.

Nowe sidecary udostępniają niezależnemu Pythonowi exact referencję mesh payloadu
z sample, length, encoding i SHA oraz exact finalne bajty diagnostyki C ABI;
manifest deklaruje ich obecność osobnymi tablicami strukturalnymi. Historyczne
pakiety bez tych wpisów zachowują trzyrodzinny status, a osobna coverage
diagnostyczna pozostaje `historical`; nie ma migracji w locie. Nadal
brakuje niezależnej rekonstrukcji actual native matrix pencil; ta luka nie jest
uzupełniana z bieżącego źródła.

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
| `scripts/test_fem_nonshared_native_input_diagnostics.py` | `class NonSharedNativeInputDiagnosticsTests` | exact finalny payload C ABI, preimage, zewnętrzne raw refs i mutacje |
| `scripts/test_nonshared_native_input_diagnostics_source.py` | `class NonSharedNativeInputDiagnosticsSourceTests` | source-only kolejność finalizacji przed C ABI |
| `scripts/test_nonshared_floquet_manifest_contract_source.py` | `class NonsharedFloquetManifestContractSourceTests` | source-only rodziny tablic manifestu single-k/multi-k i fail-closed coverage |
| `scripts/fem_nonshared_operator_replay.py` | `_matrix_close` | porównanie względne bez wymiarowej tolerancji absolutnej |
| `scripts/test_fem_nonshared_scaled_matrix_replay.py` | `class NonsharedScaledMatrixReplayTests` | małe poprawne macierze i podmiany po pełnym rehash |
| `scripts/test_fem_nonshared_canonical_paths.py` | `class NonsharedCanonicalPathTests` | odrzucanie aliasów przed normalizacją ścieżki |
| `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_nonshared_operator_replay` | routing manifestu i kompletność policzonych próbek |
| `scripts/test_fem_nonshared_operator_routing.py` | `class NonsharedOperatorRoutingTests` | rzeczywisty fixture bez mocka, coverage i odrzucenie podmian |
| `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` | `build_nonshared_floquet_provenance` | producent exact refs/preimage |
| `crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs` | `finalize_native_input_diagnostics` | acykliczna publikacja exact finalnych bajtów C ABI i preimage |
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

Manifest producenta deklaruje trzy historyczne plural arrays
`nonshared_floquet_*_v1_paths` dla identity, identity preimage i source state.
Gdy finalne wejście C ABI istnieje, deklaruje osobną parę tablic
`nonshared_floquet_native_input_diagnostics*_v1_paths`. Każda rodzina musi
zawierać własny, uporządkowany zbiór policzonych próbek, a singular alias jest
dozwolony wyłącznie dla jednej próbki i musi wskazywać tę samą ścieżkę. Brak
nowej pary w historycznym pakiecie nie jest błędem odczytu trzech rodzin;
diagnostyka nowej pary pozostaje `historical`/`NOT_VERIFIED` i nie podnosi
operatora ani kwalifikacji naukowej. Obecny routing algebraiczny nadal rozdziela
obie kontrole strukturalne od odczytu finalnego C ABI.
Regresje routingu i source-contract przeszły na interpretowanych fixture bez
mocka; nie jest to wykonanie FEM.
