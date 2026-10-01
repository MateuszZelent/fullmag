# ProducerProvenance v1 dla dokładnych artefaktów relaksacji FEM

- Status: `source-visible partial / runtime-unvalidated`
- Właściciel: Fullmag FEM equilibrium-to-eigen handoff
- Data: 2026-10-01
- Zakres: typed provenance producenta dla accepted, certified i recomputed
  payloadów relaksacji oraz ich użycia w modalnym FEM
- Powiązane kontrakty: `docs/specs/fem-relaxation-producer-provenance-v1.md`,
  `docs/physics/r4-linearization-identity-v2.md`,
  `docs/physics/r4-accepted-field-replay.md`,
  `docs/specs/frequency-domain-artifacts-v2.md`

Ta nota opisuje kontrakt transportu tożsamości producenta oraz jego częściową
implementację w źródłach. Nie kwalifikuje solvera i nie zastępuje
walidacji fizycznej, residualu, zbieżności siatki, airboxu ani dowodu managed
runtime. Celem jest uniemożliwienie przypisania artefaktom z obcego runu
tożsamości bieżącego procesu.

(problem-statement)=
## 1. Domena fizyczna i problem pochodzenia

Relaksacja FEM tworzy stan równowagi $\mathbf m_0$ oraz trzy dokumenty
replayu: accepted fields, certified fields i recomputed linearization
certificate. Następny etap modalny liniaryzuje operator wokół tego stanu dla
jednego $\mathbf k$ albo dla każdego punktu ścieżki k. Zgodność samych pól
fizycznych nie dowodzi, że dokumenty powstały z tego samego planu, źródła i
builda.

Obecny problem ma trzy warianty:

1. w ścieżce live producent i konsument działają w jednym procesie, ale
   konstruktor handoffu odtwarzał producer identity z bieżącego
   `build_identity_json()` zamiast otrzymać ją z granicy produkcji;
2. exact payloady skopiowane z innego runu mogą przejść walidację pól, jeżeli
   odpowiadają fizycznemu materiałowi i siatce, a następnie dostać tożsamość
   aktualnego builda;
3. zwykły `LoadState` przenosi wektor magnetyzacji, ale nie jest kompletnym
   bundlem FEM i nie może sam przywracać kwalifikowanego handoffu.

`ProducerProvenance` jest addytywnym dowodem pochodzenia. Nie zmienia energii,
równań LLG, operatora Floqueta ani semantyki `ProblemIR`.

Identyfikator `producer_build_identity.source_snapshot_sha256` jest dokładną
kopią `fullmag_build_info::identity()` i ma 64 małe znaki hex bez prefiksu,
tak jak `FULLMAG_SOURCE_SNAPSHOT_SHA256` w buildzie managed. Ta sama reguła
dotyczy source snapshotów producenta i konsumenta w linearization identity.
Digesty planów, pól i sygnatur fizycznych zachowują format `sha256:<hex>`.
Walidatory rozdzielają te formaty zamiast normalizować wejście. Próba Γ po
buildzie #195 ujawniła użycie walidatora digestów payloadu dla poprawnej
tożsamości buildu; poprawka źródłowa nie jest jeszcze dowodem ponownego
uruchomienia ani wyniku częstotliwości.

(governing-equations)=
## 2. Digesty i warunek akceptacji

Każdy digest dokładnych bajtów ma jawny namespace i długość payloadu:

```{math}
:label: eq-producer-framed-sha256
D_N(p)=\operatorname{SHA256}\left(
N\;\Vert\;\mathtt{0x00}\;\Vert\;
\operatorname{LE}_{64}(|p|)\;\Vert\;p\right).
```

Surowy digest pliku jest osobnym dowodem transportu:

```{math}
:label: eq-producer-raw-sha256
R(b)=\operatorname{SHA256}(b),
\qquad b\in\{0,1\}^{8n}.
```

Typed provenance producenta jest akceptowalne tylko wtedy, gdy wszystkie
payloady wskazane przez sidecar mają te same bajty i digesty, które zostały
odczytane z katalogu źródłowego:

```{math}
:label: eq-producer-payload-binding
\forall q\in Q:\quad
R(b_q)=R_{\mathrm{declared}}(q)
\;\land\;
D_{N_q}(p_q)=D_{\mathrm{declared}}(q).
```

Dla planu producenta przechowywane są exact bajty JSON/preimage oraz digest
surowy i framed. Nie wolno odtwarzać ich przez `serde_json` lub `json.dumps`
po stronie klienta i uznawać zrekonstruowanego obiektu za ten sam preimage.

Warunek źródła dla domyślnej polityki cross-build jest następujący:

```{math}
:label: eq-producer-source-policy
D_{\mathrm{source}}^{\mathrm{producer}}
=D_{\mathrm{source}}^{\mathrm{consumer}}
\quad\land\quad
\mathrm{cross\_build\_policy}=
\texttt{same\_source\_snapshot\_required}.
```

Brak dowodu producenta nie jest zgodnością. Zakończenie takiego odczytu ma
stan `NOT VERIFIED` albo błąd fail-closed; nie wolno uzupełniać go aktualnym
buildem procesu.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $P_{\mathrm{prod}}$ | typed `ProducerProvenance` jednego source stage | $1$ |
| $B_{\mathrm{prod}}$ | dokładna tożsamość builda producenta | $1$ |
| $S_{\mathrm{prod}}$ | snapshot źródła producenta | $1$ |
| $p_{\mathrm{plan}}$ | exact JSON/preimage planu producenta | $1$ |
| $N$ | namespace ramki digestu | $1$ |
| $p$ | dokładne bajty preimage | $1$ |
| $D_N(p)$ | framed SHA-256 w namespace $N$ | $1$ |
| $R(b)$ | surowy SHA-256 bajtów $b$ | $1$ |
| $b$ | dokładny payload bajtowy | $1$ |
| $Q$ | zbiór accepted/certified/recomputed payloadów | $1$ |
| $\mathbf m_0$ | magnetyzacja równowagi w węzłach magnetycznych | $1$ |
| $\mathbf k$ | wektor falowy próbki modalnej | $\mathrm{rad\,m^{-1}}$ |
| $n$ | liczba węzłów lub długość payloadu w bajtach, zależnie od kontekstu | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | stała anizotropii jednoosiowej | $\mathrm{J\,m^{-3}}$ |
| $\alpha$ | damping planu relaksacji albo eigen | $1$ |
| $f$ | częstotliwość własna | $\mathrm{Hz}$ |
| $D_{\mathrm{source}}^{\mathrm{producer}}$ | digest snapshotu źródła producenta | $1$ |
| $D_{\mathrm{source}}^{\mathrm{consumer}}$ | digest snapshotu źródła konsumenta | $1$ |

(assumptions-and-validity)=
## 4. Zakres ważności i rodziny artefaktów

### 4.1. Rozdzielenie identity fizycznej i provenance

`equilibrium_material_signature`, `equilibrium_static_physics_signature` i
`equilibrium_boundary_signature` opisują fizyczną tożsamość równowagi.
`ProducerProvenance` opisuje pochodzenie dokumentu i planu. Raw provenance
planu relaksacji nie może być nazywane canonical physical material identity.

Różny damping jest dozwolony:

- `alpha_relax = 0.5` może służyć do uzyskania równowagi;
- `alpha_eigen = 0.0` może służyć do liniaryzacji modalnej;
- obie wartości są związane z własnymi planami, ale nie zmieniają fizycznej
  tożsamości statycznego $M_s$, $A_{\mathrm{ex}}$, $K_u$, osi i boundary.

### 4.2. Ku-free i canonical Ku

Provenance nie zmienia rodzin zapisanych w istniejącym kontrakcie:

| Rodzina | Równowaga | Stan liniaryzacji | Payload fields |
|---|---|---|---|
| Ku-free V1 | `equilibrium_artifact.v7` | `LinearizationState.v6` | `CertifiedFemEquilibriumFields.v1` |
| canonical Ku V2, także jawne $K_u=0$ | `equilibrium_artifact.v8` | `LinearizationState.v7` | `CertifiedFemEquilibriumFields.v2` |

Pary V1/V2 nie wolno mieszać w jednym sample. Sidecar zachowuje rodzinę
payloadów, ale nie promuje V1 do V2.

### 4.3. Macierz backendów

| Solver | Urządzenie | Status | Granica dowodu |
|---|---|---|---|
| FEM | CPU | documented / source-visible | Propozycja dotyczy aktualnej ścieżki native FEM CPU; runtime pozostaje NOT VERIFIED. |
| FEM | GPU | planned / unsupported for this contract | Brak dowodu native GPU modal handoff i parytetu; brak cichego fallbacku CPU. |
| FDM | CPU | not-applicable | Sidecar opisuje exact FEM equilibrium payloady. |
| FDM | GPU | not-applicable | Sidecar opisuje exact FEM equilibrium payloady. |

### 4.4. Sample i ścieżka k

Jeden sidecar źródłowej relaksacji może być użyty dla kolejnych próbek ścieżki
k tylko przez jawny, zweryfikowany handoff. Każdy modalny `sample_index` musi
mieć własne identity, ścieżki i digesty. Nie wolno uzupełniać brakującego
punktu przez odbicie $+\mathbf k\leftrightarrow-\mathbf k$.

(python-api)=
## 5. Python API i ProblemIR

Ten kontrakt nie dodaje publicznego konstruktora Python ani pola do authoringu.
Źródłem `p_plan` jest istniejący `FemPlanIR`/`ExecutionPlanIR`, a
`requested_execution` i `resolved_execution` pozostają osobno zapisane.

Poniższy przykład jest wyłącznie małym, nieuruchamiającym solvera wzorcem
walidatora exact sidecara. Nie tworzy `ProblemIR` i nie jest dowodem runtime:

```python
# %%
from hashlib import sha256
from pathlib import Path
from struct import pack

# %%
def raw_sha256(payload: bytes) -> str:
    return "sha256:" + sha256(payload).hexdigest()


def framed_sha256(namespace: str, payload: bytes) -> str:
    frame = namespace.encode("utf-8") + b"\x00" + pack("<Q", len(payload)) + payload
    return "sha256:" + sha256(frame).hexdigest()

# %%
sidecar = Path("equilibrium/producer_provenance.v1.json")
assert sidecar.name == "producer_provenance.v1.json"
# Production replay must read producer-published bytes and compare their raw
# hashes; it must not serialize a reconstructed Python dictionary.
assert raw_sha256(b"producer-payload") == raw_sha256(b"producer-payload")
assert framed_sha256("fem_relaxation.producer_plan.v1", b"producer-plan")
```

### 5.1. Mapping do istniejącego planu

| Pole provenance | Źródło semantyczne | Zachowanie |
|---|---|---|
| `producer_build_identity` | `RunMetadata.build_identity` | exact obiekt z runu producenta; nie bieżący build konsumenta |
| `producer_plan_snapshot` | source `FemPlanIR` przekazany do `write_artifacts` | exact JSON/preimage i digesty tego planu |
| `requested_execution` | plan wykonania | zachowuje intencję użytkownika |
| `resolved_execution` | faktyczne wykonanie | zachowuje backend, device, precision i fallback |
| `source_mesh_topology_sha256` | source relaxation mesh | nie jest zastępowany modalnym mixed topology |
| `equilibrium_*_signature` | canonical physical identity | porównywana z planem eigen |
| payload refs | trzy exact auxiliary artifacts | raw bytes SHA i content digest |

(problem-ir)=
## 6. ProblemIR, requested intent i resolved execution

`ProducerProvenance` nie zastępuje `ProblemIR`. Jest zapisem wykonania po
materializacji planu. Konsument musi zachować:

1. authored/requested `FemPlanIR`, w tym materiał, boundary, damping i
   `KSamplingIR`;
2. resolved execution, w tym rzeczywisty backend, device, precision, engine i
   informację o fallbacku;
3. producer snapshot, który identyfikuje źródło użyte do wyprodukowania
   payloadów;
4. consumer snapshot, który identyfikuje build sprawdzający handoff.

Brak któregoś z tych rozróżnień nie może być naprawiany nazwą pliku,
`git_commit` odczytanym z bieżącego procesu ani etykietą `solver_kind`.

(round-trip-and-failure-semantics)=
## 7. Typed schema i transport

### 7.1. Proponowany sidecar

Canonical source sidecar ma ścieżkę:

```text
equilibrium/producer_provenance.v1.json
```

Po użyciu w sample modalnym jest kopiowany z zachowaniem bajtów do:

```text
eigen/metadata/sample_NNNN/producer_provenance.v1.json
```

Minimalny typed payload:

```json
{
  "schema_version": "fem_relaxation_producer_provenance.v1",
  "source_run_id": "run-id",
  "source_stage_id": "stage-id",
  "source_stage_kind": "relaxation",
  "producer_build_identity": {
    "built_at_utc": "...",
    "git_commit": "...",
    "worktree_state": "clean",
    "source_snapshot_sha256": "<64 lowercase hex>"
  },
  "producer_plan_snapshot": {
    "namespace": "fem_relaxation.producer_plan.v1",
    "encoding": "utf-8-json-bytes",
    "preimage_json": "<exact UTF-8 JSON string>",
    "raw_sha256": "sha256:<64 lowercase hex>",
    "framed_sha256": "sha256:<64 lowercase hex>"
  },
  "source_mesh_topology_sha256": "sha256:<64 lowercase hex>",
  "equilibrium_content_sha256": "sha256:<64 lowercase hex>",
  "equilibrium_material_signature": "sha256:<64 lowercase hex>",
  "equilibrium_static_physics_signature": "sha256:<64 lowercase hex>",
  "equilibrium_boundary_signature": "sha256:<64 lowercase hex>",
  "payloads": {
    "accepted_fields": {
      "path": "equilibrium/accepted_fem_equilibrium_fields.v2.json",
      "schema_version": "CertifiedFemEquilibriumFields.v2",
      "raw_bytes_sha256": "sha256:<64 lowercase hex>",
      "content_sha256": "sha256:<64 lowercase hex>"
    },
    "certified_fields": {
      "path": "equilibrium/certified_fem_equilibrium_fields.v2.json",
      "schema_version": "CertifiedFemEquilibriumFields.v2",
      "raw_bytes_sha256": "sha256:<64 lowercase hex>",
      "content_sha256": "sha256:<64 lowercase hex>"
    },
    "recomputed_certificate": {
      "path": "equilibrium/recomputed_fem_linearization_certificate.v2.json",
      "schema_version": "RecomputedFemLinearizationCertificate.v2",
      "raw_bytes_sha256": "sha256:<64 lowercase hex>",
      "content_sha256": "sha256:<64 lowercase hex>"
    }
  },
  "cross_build_policy": "same_source_snapshot_required"
}
```

`preimage_json` i wszystkie `raw_bytes_sha256` są dowodem exact bytes. W
przyszłej implementacji pola mogą być reprezentowane jako typed Rust struct,
ale zmiana nazwy lub namespace wymaga nowej wersji schematu.

### 7.2. Producent i finalizacja

Obecny fragment źródłowy tworzy sidecar w granicy materializacji artefaktów
`artifacts.rs::write_artifacts`. Finalizator relaksacji zachowuje trzy exact
payloady w `ExecutedRun`; writer odczytuje te same bajty, pobiera rzeczywisty
`build_identity_json()` producenta i wymagane `producer_run_id`,
`producer_stage_id` oraz `producer_stage_kind` z runtime metadata orkiestracji.
Brak tych identyfikatorów nie jest uzupełniany z bieżącego konsumenta: sidecar
nie powstaje i późniejszy verified handoff pozostaje `NOT VERIFIED`.

Writer serializuje dokładny `FemPlanIR` użyty do wykonania, liczy raw/framed
digests planu i raw/content digests trzech payloadów, a następnie waliduje
sidecar przed dołączeniem go do listy artefaktów. Konflikt istniejącej ścieżki
sidecara kończy materializację błędem; zapis artefaktów pozostaje istniejącym
sekwencyjnym writerem, więc nie należy nazywać tej granicy transakcją atomową.

`RunMetadata.build_identity` i `build_identity_json()` są źródłem pól builda
na granicy producenta. Nie są używane przez konsumenta do odtwarzania
provenance. Top-level `metadata.json` nadal nie zastępuje sidecara, ponieważ
sidecar wskazuje konkretne payloady i ich raw hashes.

### 7.3. CLI i verified handoff

Transport zaimplementowanego fragmentu ma postać:

```text
finalize.rs / ExecutedRun
  -> producer_provenance.v1.json + exact payload bytes
  -> artifacts.rs::write_artifacts
  -> orchestrator exact-artifact loader
  -> AcceptedFemRelaxExactArtifacts + FemRelaxationProducerProvenance
  -> verified constructor
  -> linearization_identity.v2
```

`accepted_relax_handoff_from_completed_stage_with_exact_artifacts` czyta sidecar
z tego samego `artifact_dir`, sprawdza wszystkie raw hashes, source run/stage i
rodzinę V1/V2, a następnie przekazuje typed provenance do nowego verified API.
Starszy exact constructor bez sidecara jest obecnie jawnie fail-closed i zwraca
`relax_stage_handoff_exact_producer_provenance_required`; nie może ustawiać
`verified_replay` na podstawie bieżącego `build_identity_json()`.

Ten fragment obejmuje zwykłą orkiestrację etapów. Ścieżki interaktywne oraz
inne native call sites, które nie przekazują producer metadata, pozostają bez
sidecara do czasu ich osobnej migracji.

### 7.4. Loader cross-run i vector-only LoadState

Jawny loader kompletnego FEM bundle może przywrócić handoff tylko po walidacji
sidecara, planu, mesh, m0, materiału, statyki, boundary i trzech payloadów.

Zwykły `LoadState` pozostaje vector-only:

- odczytuje magnetyzację i zapisuje `synthetic_stage.json`;
- nie ładuje accepted/certified/recomputed payloadów;
- czyści verified relaxation handoff;
- nie może uzyskać kwalifikacji przez samą zgodność długości wektora.

Brak sidecara w imporcie cross-run daje `identity_unavailable`/`NOT VERIFIED`,
a nie provenance utworzone z bieżącego procesu.

Validation errors (brak pól, zły digest, obcy source snapshot, konflikt ścieżki
albo nieznana polityka) kończą się odrzuceniem przed linkiem manifestu.
Unsupported combinations, takie jak mieszanie rodzin V1/V2, import vector-only
do verified handoffu albo deklarowanie pełnego non-shared identity bez operator
signature, pozostają `NOT VERIFIED`; nie są obsługiwane przez cichy fallback.

(discrete-realization)=
## 8. Modalny handoff shared i non-shared Floquet

### 8.1. Shared-domain

Shared-domain modal path może użyć `ProducerProvenance`, jeśli otrzyma
zweryfikowany handoff i zachowa go przy każdym `sample_index`. `source_mesh`
relaksacji i `modal_mesh_topology_fingerprint_v3` muszą pozostać osobnymi
polami. Identity nie zastępuje `operator_input_signature_sha256` ani
`phase_constraint_sha256`.

### 8.2. Non-shared Bloch/Floquet

Non-shared path nie może tracić handoffu tylko dlatego, że używa osobnej
funkcji operatora. Plan naprawy:

1. dodać do wejścia `execute_native_cpu_modal_window_from_bloch_floquet_complex`
   opcjonalny verified source handoff i producer provenance;
2. przekazać je do publikatora artefaktów dla każdego sample;
3. wyliczyć `operator_input_signature_sha256` z rzeczywistego operatora,
   macierzy stiffness/mass, mapy par periodycznych, fazy, $\mathbf k$,
   boundary/gauge i polityki tłumienia;
4. nie tworzyć fikcyjnego `SharedDomainLinearizationState` dla non-shared;
5. jeżeli pełne identity non-shared nie jest jeszcze zdefiniowane, opublikować
   `identity_unavailable_reason` i pozostać `NOT VERIFIED`.

To nie jest trwałe wyłączenie non-shared. Jest to rozdzielenie wykonania
operatora od roszczenia, że jego producer provenance został zweryfikowany.

(implementation-mapping)=
## 9. Mapa implementacji i proponowanych zmian

| Warstwa | Stabilny symbol | Obecny stan | Wymagana zmiana |
|---|---|---|---|
| Finalizacja | `crates/fullmag-runner/src/fem/relax/finalize.rs` + `finalize_native_fem_relaxation` | Zachowuje trzy exact payloady w `ExecutedRun`; nie nadaje jeszcze run/stage identity | Writer artefaktów dołącza sidecar, gdy orkiestracja przekaże rzeczywiste identity. |
| Run metadata | `crates/fullmag-runner/src/artifacts.rs` + `RunMetadata` / `build_identity_json` | Sidecar bierze build identity i exact payloady na granicy `write_artifacts` | Uzupełnić manifest/path maps i pozostałe call sites; nie odtwarzać identity w konsumencie. |
| Exact handoff | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `AcceptedFemRelaxExactArtifacts` | Typed `ProducerProvenance`, walidacja digestów i nowy verified API są source-visible; stary exact API fail-closed | Przenieść sidecar przez wszystkie producentów i konsumentów, bez bypassu. |
| CLI | `crates/fullmag-cli/src/orchestrator.rs` + `accepted_relax_handoff_from_completed_stage_with_exact_artifacts` | Czyta sidecar z tego samego katalogu i przekazuje typed provenance | Dodać ścieżki manifestu oraz obsłużyć interactive/cross-run loader. |
| Equilibrium import | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` + `load_certified_equilibrium_artifact` | Waliduje fizyczne pola, nie producer build/plan | Dodać jawny verified bundle loader; artifact-only bez sidecara pozostaje NOT VERIFIED. |
| Shared modal | `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` + `native_modal_artifacts` | Potrafi publikować identity, jeśli handoff jest obecny | Dołączyć producer sidecar i zachować sample binding. |
| Non-shared modal | `crates/fullmag-runner/src/fem/eigen_native_window.rs` + `execute_native_cpu_modal_window_from_bloch_floquet_complex` | Handoff jest odrzucany na granicy, operator signature bywa null | Przenieść handoff i dodać odrębną operator identity albo jawny NOT VERIFIED. |
| Vector state | `crates/fullmag-cli/src/orchestrator.rs` + `execute_synthetic_stage` | Ładuje tylko magnetyzację | Zachować vector-only semantics; nie promować do FEM replay. |

(validation)=
## 10. Walidacja i regresje

### Source/contract checks

- typed sidecar odrzuca unknown schema, unknown cross-build policy, uppercase
  lub niepełny digest i `null` w wymaganych polach;
- zmiana jednego bajtu dowolnego payloadu, planu lub sidecara jest odrzucona;
- producer/consumer source snapshot mismatch kończy się fail-closed;
- V1/V2 mixed family i puste wymagane payloady są odrzucane;
- `producer_build_identity` nie może pochodzić z bieżącego procesu konsumującego;
- exact constructor bez `ProducerProvenance` nie ustawia verified replay;
- sidecar i manifest zachowują `sample_index` oraz ścieżkę każdego punktu;
- zwykły `LoadState` po load nie ma kwalifikowanego handoffu;
- non-shared missing handoff publikuje explicit unavailable reason, a nie null
  udający pomiar.

### Prepared native checks

Nie uruchamiać, dopóki zakaz kompilacji native unit pozostaje aktywny:

1. producer sidecar roundtrip z exact `RunMetadata` i plan preimage;
2. obcy build identity i obcy source snapshot;
3. mutacja raw bytes accepted/certified/recomputed;
4. zła ścieżka lub `sample_index` przed linkiem manifestu;
5. cross-run bundle akceptowany tylko z pełnym sidecarem;
6. non-shared operator signature wiąże $\mathbf k$, fazę i mapę Floqueta;
7. vector-only `LoadState` nie odtwarza verified handoffu.

### Evidence boundary

Walidator źródłowy i Python replay potwierdzają strukturę i digesty. Nie
potwierdzają wykonania solvera, residualu, zbieżności siatki, dynamicznego
demagu, zgodności z COMSOL/TetraX ani parytetu GPU. Te bramki pozostają
oddzielne i wymagają managed runtime oraz artefaktów dla dokładnie określonego
zakresu.

(limitations)=
## 11. Ograniczenia i otwarte decyzje

Publiczny standalone runner wiąże nową execution przed dispatch przez
`bind_fem_execution_stage_identity`; to obejmuje producenta relaksacji
wywołanego z Python `_core.run_problem_json`. Brak wszystkich trzech IDs
powoduje utworzenie nowej tożsamości tego wykonania; komplet jawnych IDs
orkiestratora jest zachowany, a częściowe lub niewłaściwie typowane dane są
odrzucane. Nie rekonstruuje się w ten sposób tożsamości importowanego
producenta. Binding obowiązuje również przed pipeline unified
`InteractiveRuntime::execute_planned_streaming`. Parser źródeł PASS,
regresje zachowania są przygotowane, lecz nie skompilowane ani uruchomione;
kwalifikacja managed runtime nadal jest otwarta.

`validate_producer_provenance_discovery` w głównym verifierze kontroluje
canonical sample paths, pełny zbiór policzonych próbek, kolejność i zgodność
singular/plural. Historyczny brak nie dostaje kwalifikacji; poprawne ścieżki
również pozostają `payload_replay_status=NOT_VERIFIED`. Ten krok discovery
nie zastępuje odtworzenia planu, fizycznych sygnatur, pól ani operatora.

- Nazwa sidecara i wersja `fem_relaxation_producer_provenance.v1` są już
  używane przez source-visible producer/CLI fragment, ale nie są jeszcze
  kwalifikowanym publicznym API.
- Obecny writer przechowuje exact plan jako UTF-8 JSON serializowany z
  wykonywanego `FemPlanIR`; manifest/path transport i niezależny runtime replay
  pozostają do domknięcia.
- `RunMetadata` opisuje run, lecz nie zastępuje wiązania trzech payloadów;
  implementacja musi sprawdzić ich raw hashes.
- Non-shared Floquet zachowuje ścieżkę wykonania, ale pozostaje
  `NOT VERIFIED`, dopóki handoff i operator identity nie przejdą własnej bramki.
- Dokumentacja nie deklaruje, że obecne dirty źródła lub przygotowane testy
  native dowodzą runtime.

(scientific-bibliography)=
## 12. Bibliografia i kontrakty nadrzędne

- NIST, *FIPS PUB 180-4: Secure Hash Standard*, SHA-256 framing primitives,
  https://doi.org/10.6028/NIST.FIPS.180-4.
- Fullmag, `docs/physics/r4-linearization-identity-v2.md`, identity modalnego
  sample i exact własny preimage.
- Fullmag, `docs/physics/r4-accepted-field-replay.md`, accepted/certified/
  recomputed replay równowagi.
- Fullmag, `docs/physics/0840-equilibrium-material-preimage-replay.md`,
  canonical V1/V2 material identity i raw provenance.
- Fullmag, `docs/specs/frequency-domain-artifacts-v2.md`, manifest, sample paths,
  operator i readiness boundaries.
- Fullmag, `docs/adr/0023-physical-bias-sweep-and-frequency-domain-analysis-boundary.md`,
  granice produktu frequency-domain.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Path + symbol | Lane | Stan dowodu |
|---|---|---|---|
| build identity runu | `crates/fullmag-runner/src/artifacts.rs` + `RunMetadata`, `build_identity_json` | FEM CPU | source-visible; producer boundary, runtime NOT VERIFIED |
| exact payloady | `crates/fullmag-runner/src/fem/relax/finalize.rs` + `finalize_native_fem_relaxation` | FEM CPU | source-visible; exact bytes transportowane przez `ExecutedRun` |
| obecny exact handoff | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `AcceptedFemRelaxExactArtifacts` | FEM CPU | source-visible; sidecar validation i fail-closed API |
| obecny CLI loader | `crates/fullmag-cli/src/orchestrator.rs` + `accepted_relax_handoff_from_completed_stage_with_exact_artifacts` | FEM CPU | source-visible; sidecar wymagany przez verified handoff |
| artifact loader | `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` + `load_certified_equilibrium_artifact` | FEM CPU | source-visible; brak producer identity |
| modal identity | `crates/fullmag-runner/src/fem/eigen_native_artifacts.rs` + `native_modal_artifacts` | FEM CPU | source-visible; runtime NOT VERIFIED |
| manifest producer path transport | `crates/fullmag-runner/src/fem/eigen_output.rs` + `sample_scoped_producer_provenance_paths`, `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` + `build_eigen_path_frequency_domain_manifest` | FEM CPU | source-visible; runtime NOT VERIFIED |
| non-shared Floquet | `crates/fullmag-runner/src/fem/eigen_native_window.rs` + `execute_native_cpu_modal_window_from_bloch_floquet_complex` | FEM CPU | handoff gap; NOT VERIFIED |
| vector-only state | `crates/fullmag-cli/src/orchestrator.rs` + `execute_synthetic_stage` | CLI | source-visible |
| independent preimage replay | `scripts/fem_linearization_identity_replay.py` + `replay_identity_preimage` | verifier | interpreted evidence only |

| Framed producer digest | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `linearization_identity_v2_content_sha256_from_preimage_bytes` | FEM CPU | source-visible; runtime NOT VERIFIED |
| Raw artifact digest | `crates/fullmag-runner/src/fem/eigen_output.rs` + `published_artifact_sha256` | FEM CPU | source-visible; runtime NOT VERIFIED |
| Producer payload boundary | `crates/fullmag-runner/src/artifacts.rs` + `fem_relaxation_producer_provenance_artifact` | FEM CPU | source-visible; exact bytes and hashes validated before append |
| Source snapshot policy | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `validate_for_handoff` | FEM CPU | source-visible; fail-closed validation, runtime NOT VERIFIED |
| Source snapshot encoding | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `is_strict_source_snapshot_sha256` | FEM CPU | raw64; managed runtime poprawki NOT VERIFIED |
| Build identity authority | `crates/fullmag-build-info/src/lib.rs` + `identity` | wspólny build | exact source identity bez normalizacji |
| CLI producer transport | `crates/fullmag-cli/src/orchestrator.rs` + `accepted_relax_handoff_from_completed_stage_with_exact_artifacts` | FEM CPU | source-visible; sidecar required by verified API |
| Verified constructor | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `from_completed_relax_verified_with_exact_artifacts_and_provenance` | FEM CPU | source-visible; requires typed producer sidecar |
| Standalone execution binding | `crates/fullmag-runner/src/lib.rs` + `bind_fem_execution_stage_identity` | FEM CPU/GPU | source-visible; prepared regressions, runtime NOT VERIFIED |
| Unified interactive binding | `crates/fullmag-runner/src/interactive/runtime.rs` + `execute_planned_streaming` | FEM CPU/GPU | source-visible; runtime NOT VERIFIED |
| Producer discovery | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_producer_provenance_discovery` | verifier | interpreted coverage regressions; payload qualification NOT VERIFIED |
| Non-shared modal boundary | `crates/fullmag-runner/src/fem/eigen_native_window.rs` + `execute_native_cpu_modal_window_from_bloch_floquet_complex` | FEM CPU | handoff gap; NOT VERIFIED |

Ta nota opisuje częściowo wdrożony kontrakt i mapę dalszych zmian. Nie zamyka
R4 ani nie podnosi żadnego wyniku do kwalifikacji naukowej.
