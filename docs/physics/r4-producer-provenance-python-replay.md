# Python replay źródłowego provenance producenta FEM

- Status: `source_visible / interpreted_contract_only`
- Właściciel: granica relaksacja FEM → handoff eigen
- Data: 2026-10-01
- Kontrakt nadrzędny: `docs/specs/fem-relaxation-producer-provenance-v1.md`

(problem-statement)=
## 1. Domena fizyczna i cel

Relaksacja FEM zapisuje stan równowagi $mathbf m_0$, siatkę, materiał,
statykę oraz trzy payloady pól używane później przez solver częstotliwościowy.
Sam zgodny `node_count`, nazwa pliku albo digest skopiowanego JSON-u nie
wykazuje, że payload pochodzi z właściwego planu i source snapshotu. Adapter
`scripts/fem_producer_provenance_replay.py` zamyka tę granicę w interpreterze:

1. odczytuje sidecar `fem_relaxation_producer_provenance.v1`;
2. porównuje exact bytes planu z `producer_plan_snapshot.preimage_json` albo
   używa wyłącznie tych samych inline bytes w bundle modalnym;
3. odtwarza mesh, materiał, $mathbf m_0$ i trzy fizyczne preimage'y identity;
4. wiąże raw bytes accepted/certified/recomputed z oryginalnymi nazwami
   producenta, również gdy konsument skopiował je do `sample_NNNN`;
5. wiąże exact bytes `consumer_plan_snapshot.v1.json` z polem
   `consumer_plan_snapshot_sha256` identity;
6. zwraca `ReplaySourceContext` dopiero po zamknięciu wszystkich tych bram.

Adapter nie zmienia równań LLG, planu `ProblemIR` ani operatora Floqueta.
`scientific_qualification` pozostaje `NOT_VERIFIED`: replay nie jest dowodem
wykonania native, residualu modalnego, zbieżności siatki ani zgodności z COMSOL
lub TetraX.

(governing-equations)=
## 2. Digesty exact bytes

Dla planu producent stosuje namespace, separator NUL, długość LE64 i exact
UTF-8 bytes $p$:

```{math}
:label: eq-producer-python-plan-framing
D_N(p)=\operatorname{SHA256}\left(N\,\Vert\,\mathtt{0x00}\,\Vert\operatorname{LE}_{64}(|p|)\,\Vert\,p\right).
```

Raw transport każdego payloadu jest niezależny:

```{math}
:label: eq-producer-python-raw-payload
R(b)=\operatorname{SHA256}(b),
\qquad b\in\{0,1\}^{8n}.
```

Weryfikacja źródła wymaga:

```{math}
:label: eq-producer-python-source-binding
R(b_q)=R_{\mathrm{sidecar}}(q)\ \land\ D_{N}(p_{\mathrm{plan}})=D_{\mathrm{sidecar}}(p_{\mathrm{plan}})
\ \land\ S_{\mathrm{producer}}=S_{\mathrm{expected}}.
```

`json.dumps` nie jest używany do dowodu planu ani payloadu. Dopuszczona jest
wyłącznie interpretacja już odczytanych bytes w celu sprawdzenia pól i digestów
typed payloadu.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $N$ | digest namespace | $1$ |
| $p$ | exact producer plan JSON bytes | $1$ |
| $b_q$ | exact bytes of payload q | $1$ |
| $D_N$ | framed SHA-256 | $1$ |
| $R$ | raw SHA-256 transport digest | $1$ |
| $S_{\mathrm{producer}}$ | producer source snapshot | $1$ |
| $\mathbf m_0$ | equilibrium magnetization vectors | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | uniaxial anisotropy | $\mathrm{J\,m^{-3}}$ |
| $\alpha$ | raw relaxation damping | $1$ |
| $\mathbf k$ | modal wave vector | $\mathrm{rad\,m^{-1}}$ |

(assumptions-and-validity)=
## 4. Założenia i zakres ważności

Adapter obsługuje kontrakt producenta dla zakresu exchange/demag/Zeeman oraz
constant-Ku. Materiał V1 nie ma `uniaxial_anisotropy`; V2 ma jawne pole,
również dla $K_u=0$, i wymaga kanonicznej osi. Dodatkowe pola DMI,
przestrzennej anizotropii, sterowania, prądu, termiki lub mechaniki kończą
replay błędem, zgodnie z `validate_supported_relax_source`.

Źródłowy mesh pochodzi z exact `FemPlanIR.mesh`; przed fingerprintem adapter
odtwarza normalizację `element_markers` wykonywaną przez
`FemMeshPayload::from_fem_plan_with_generation`, ale nie zmienia exact planu.
Opcjonalny `source_mesh_path` musi być identycznym JSON-em. M0 musi pochodzić z jawnego
pliku: akceptowany jest certyfikowany `equilibrium_artifact.v7/v8` z polem
`m0` i `accepted_for_linearization=true`, a także istniejący producerowy
`m_final.json` z polem `values`. Adapter nie wyszukuje pliku po nazwie ani nie
zastępuje go bieżącym stanem procesu.

(python-api)=
## 5. Wewnętrzne API verifiera

To nie jest publiczny konstruktor `fullmag` Python DSL. Główne typy i funkcja:

| API | Typ / wartość | Walidacja |
|---|---|---|
| `ProducerArtifactPaths.producer_root` | `Path` | bezwzględny root dla producer-relative refs |
| `ProducerArtifactPaths.provenance_path` | `Path` | exact sidecar v1 |
| `ProducerArtifactPaths.producer_plan_path` | `Path \| None` | exact plan; `None` oznacza tylko inline preimage sidecara |
| `ProducerArtifactPaths.payload_paths` | `Mapping[str, Path] \| None` | trzy jawne ścieżki copied payloadów; klucze muszą być kompletne |
| `ProducerArtifactPaths.equilibrium_magnetization_path` | `Path` | jawny m0 artifact/field |
| `replay_producer_provenance(...)` | `ProducerReplayReport` | brak pliku, obce source, digest lub rodzina kończy fail-closed |
| `ProducerReplayReport.source_context` | `ReplaySourceContext` | tworzony dopiero po pełnym replayu źródła |
| `validate_consumer_plan_exact_replay(...)` | `dict[str, object]` | exact raw bytes i digest identity; semantyka consumer IR pozostaje `NOT_VERIFIED` |

`expected_source_run_id`, `expected_source_stage_id`,
`expected_source_stage_kind` i `expected_source_snapshot_sha256` są wymagane.
Adapter nie odczytuje bieżącego build identity w celu uzupełnienia braków.

Tabela parametrów użytych przez verifier jest wyczerpująca dla tego adaptera:

| Python | Typ | Domyślna wartość | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| `ProducerArtifactPaths.payload_paths` | `Mapping[str, Path] \| None` | `None` | `$1$` | when present, exactly three absolute copied-payload paths | consumer transport locations while preserving original producer refs | FEM CPU/GPU payloads; runtime not verified | No change |
| `ProducerArtifactPaths.producer_plan_path` | `Path \| None` | `required for standalone producer bundle; None for inline modal bundle` | `$1$` | exact bytes equal producer_plan_snapshot.preimage_json when supplied | source FemPlanIR exact preimage | FEM CPU/GPU payloads; runtime not verified | FemPlanIR |
| `replay_producer_provenance.expected_source_snapshot_sha256` | `str` | `required` | `$1$` | 64 lowercase hex without prefix, equal to producer build snapshot | explicit consumer expectation for cross-build policy | FEM CPU/GPU payloads; runtime not verified | No change |
| `manifest.artifacts.consumer_plan_snapshot_v1_paths` | `list[str]` | `absent` | `$1$` | ordered canonical `sample_NNNN/consumer_plan_snapshot.v1.json` paths with raw digest binding | exact consumer-plan transport locations | FEM CPU/GPU payloads; IR/runtime not verified | FemEigenPlanIR snapshot |

Poniższy przykład pokazuje pełny, kopiowalny przebieg dla jawnego bundle'u
producenta. Ścieżki są wejściem operatora; adapter nie wyszukuje brakujących
plików ani nie uzupełnia ich bieżącym stanem procesu.

```python
# %% Import and explicit producer bundle
from pathlib import Path

from scripts.fem_producer_provenance_replay import (
    ProducerArtifactPaths,
    replay_producer_provenance,
)

# %% Source-bound replay
bundle = Path("/absolute/path/to/producer-bundle")
paths = ProducerArtifactPaths(
    producer_root=bundle,
    provenance_path=bundle / "equilibrium/producer_provenance.v1.json",
    equilibrium_magnetization_path=bundle / "eigen/metadata/sample_0000/equilibrium_artifact.v7.json",
    identity_path=bundle / "eigen/metadata/sample_0000/linearization_identity.v2.json",
    identity_preimage_path=bundle / "eigen/metadata/sample_0000/linearization_identity_preimage.v1.json",
    producer_plan_path=bundle / "producer_plan.json",
    payload_paths={
        "accepted_fields": bundle / "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v1.json",
        "certified_fields": bundle / "eigen/metadata/sample_0000/certified_fem_equilibrium_fields.v1.json",
        "recomputed_certificate": bundle / "eigen/metadata/sample_0000/recomputed_fem_linearization_certificate.v1.json",
    },
)
report = replay_producer_provenance(
    paths,
    expected_source_run_id="run-id-from-manifest",
    expected_source_stage_id="stage-id-from-manifest",
    expected_source_stage_kind="relaxation",
    expected_source_snapshot_sha256="0" * 64,
)
assert report.status == "qualified_payload_replay"
assert report.scientific_qualification == "NOT_VERIFIED"
```

(problem-ir)=
## 6. ProblemIR i provenance

Plan źródłowy jest istniejącym `FemPlanIR`; adapter nie tworzy nowego
`ProblemIR`. `producer_build_identity`, `producer_plan_snapshot` i raw refs
pozostają danymi producenta. `requested_execution`, `resolved_execution` oraz
device/precision są tylko odczytywane z istniejących artefaktów i nie mogą być
zamienione przez adapter na cichy CPU fallback.

W bundle modalnym `payload_paths` może wskazywać kopie w
`eigen/metadata/sample_NNNN`, lecz pole `payloads.*.path` zachowuje oryginalne
`equilibrium/...` producenta. `source_paths` raportu pokazuje zarówno inline
plan, jak i rzeczywiste pliki skopiowane przez konsumenta.

(round-trip-and-failure-semantics)=
## 7. Round-trip i fail-closed

Round-trip zachowuje `requested intent` planu i jawne `resolved execution`
producenta; adapter ich nie nadpisuje ani nie zamienia urządzenia. `validation errors`
kończą się wyjątkiem przed utworzeniem `ReplaySourceContext`. Znane
`unsupported combinations`, takie jak DMI, przestrzenne pola materiałowe,
termika, mechanika, niezgodna rodzina V1/V2 lub obcy source snapshot, pozostają
odrzucone i nie są cichym fallbackiem CPU/GPU.

Kolejność walidacji jest stała:

1. exact sidecar i wszystkie wymagane pola typed;
2. source run/stage i `same_source_snapshot_required`;
3. raw/framed digest planu oraz zgodność jego bytes z plikiem albo inline;
4. source mesh/material/physics projection i m0 digest;
5. pełny `linearization_identity.v2` z jego exact preimage sidecar;
6. semantyczne związanie identity ze source run/build/plan/mesh/m0 i polityką
   cross-build;
7. pięć equilibrium identity preimage'ów i ich zgodność z planem;
8. raw bytes, schema, content digest oraz V1/V2 zgodność trzech payloadów;
9. niezależny replay accepted/certified/recomputed z exact certificate preimage;
10. exact-byte replay `consumer_plan_snapshot.v1.json` z digestem identity.

Brak któregokolwiek pliku, ścieżka absolutna/traversal, obcy snapshot,
zmienione bytes, nieznana rodzina lub niezgodny m0 daje
`ProducerProvenanceReplayError`; nie powstaje częściowy `ReplaySourceContext`.
Brak dowodu pozostaje `NOT VERIFIED`, a poprawny replay nie jest naukowym
`PASS` solvera.

(discrete-realization)=
## 8. Realizacja backendów

| Solver | Urządzenie | Status | Granica dowodu |
|---|---|---|---|
| FEM | CPU | documented / interpreted | source bundle replay; bez managed runtime |
| FEM | GPU | unsupported for this increment | brak dowodu GPU residency i parytetu |
| FDM | CPU | not-applicable | kontrakt dotyczy payloadów FEM |
| FDM | GPU | not-applicable | kontrakt dotyczy payloadów FEM |

(implementation-mapping)=
## 9. Mapowanie implementacji

| Element | Ścieżka + symbol | Odpowiedzialność |
|---|---|---|
| typed producer sidecar | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `validate_for_handoff` | schema, source, plan, payload refs i rodzina |
| producer plan framing | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `fem_relaxation_producer_provenance_from_exact_artifacts` | exact plan bytes, source signatures i producer refs |
| producer payload refs | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `validate_producer_payload_ref` | relative paths, schema i raw/content digests |
| exact producer writer | `crates/fullmag-runner/src/artifacts.rs` + `fem_relaxation_producer_provenance_artifact` | zapis rzeczywistych bytes sidecara i payloadów |
| Python adapter | `scripts/fem_producer_provenance_replay.py` + `replay_producer_provenance` | source-bound replay i `ReplaySourceContext` |
| producer routing | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_producer_payload_replay` | sample_NNNN routing, source replay i operator gate separation |
| consumer exact-byte replay | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_consumer_plan_exact_replay` | raw consumer plan bytes i digest identity, bez semantyki IR |
| field replay | `scripts/fem_accepted_recomputed_replay.py` + `replay_artifact_paths` | typed fields, m0, mesh i certificate preimage |
| physical identity replay | `scripts/fem_equilibrium_identity_replay.py` + `replay_equilibrium_identity_preimages` | pięć preimage/signature pairs |
| full identity gate | `scripts/fem_linearization_identity_replay.py` + `replay_identity_preimage` | 52 pola i own exact preimage |
| topology fingerprint | `scripts/comsol_mesh_identity.py` + `mesh_topology_fingerprint_v3` | source mesh digest |

(validation)=
## 10. Walidacja

| Kontrola | Wynik | Znaczenie |
|---|---|---|
| `python -B -m unittest scripts/test_fem_producer_provenance_replay.py` | PASS, 14 testów | valid bundle, inline plan, copied payloads, certified m0, marker normalization, source routing i consumer exact-byte replay |
| `python -B -m unittest scripts/test_fem_producer_provenance_replay.py scripts/test_fem_accepted_recomputed_replay.py scripts/test_fem_equilibrium_identity_replay.py` | PASS, 36 testów | adapter plus zależne replaye |
| native compilation | NOT VERIFIED | obowiązuje zakaz kompilacji testów jednostkowych |
| managed runtime | NOT VERIFIED | adapter nie uruchamia runnera |
| modal residual/convergence | NOT VERIFIED | wymaga osobnej bramy naukowej |
| COMSOL/TetraX parity | NOT VERIFIED | wymaga wspólnych danych i execution evidence |

(limitations)=
## 11. Ograniczenia

- Adapter nie zastępuje natywnego parsera `FemPlanIR`; sprawdza wymagany
  projection kontraktu i odrzuca znane nieobsługiwane moduły.
- Exact identity digest nie jest samodzielnym dowodem: adapter wiąże pola
  source identity z provenance, planem, m0 i rzeczywistymi payloadami.
- `consumer_plan_snapshot_sha256` jest tutaj sprawdzany jako jawny digest i
  element polityki cross-build; pełny consumer plan oraz operator modalny są
  poza tym adapterem i pozostają `NOT_VERIFIED`.
- Zmiana consumer-plan bytes bez aktualizacji identity jest odrzucana. Zmiana
  samospójna, czyli nowe bytes plus nowy digest i exact identity preimage, może
  przejść bramkę transportową; jej `plan_semantics_status` oraz
  `operator_replay_status` nadal są `NOT_VERIFIED`, ponieważ adapter nie
  odtwarza semantyki `FemEigenPlanIR` ani assembly operatora.
- Certyfikowany artifact m0 jest sprawdzany pod kątem schematu i akceptacji,
  a pełna walidacja jego `content_sha256`, completion i periodic certificate
  pozostaje odpowiedzialnością native loadera.
- Replay nie dowodzi source mesh Jacobian/airbox convergence, torque,
  SLEPc residual, operatora modalnego ani rzeczywistego urządzenia.
- `scientific_qualification` celowo pozostaje `NOT_VERIFIED`, nawet przy
  `status=qualified_payload_replay`.

(scientific-bibliography)=
## 12. Bibliografia i kontrakty

- NIST, Secure Hash Standard, FIPS 180-4,
  <https://doi.org/10.6028/NIST.FIPS.180-4>.
- Fullmag, `docs/specs/fem-relaxation-producer-provenance-v1.md`.
- Fullmag, `docs/physics/r4-linearization-identity-v2.md`.
- Fullmag, `docs/physics/r4-accepted-recomputed-replay-v2.md`.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Path + symbol | Lane | Dowód |
|---|---|---|---|
| framing planu | `scripts/fem_producer_provenance_replay.py` + `_framed_sha256` | FEM CPU interpreted | test valid bundle |
| source policy | `scripts/fem_producer_provenance_replay.py` + `_validate_provenance` | FEM CPU interpreted | foreign snapshot mutation |
| real mesh/material/m0 | `scripts/fem_producer_provenance_replay.py` + `replay_producer_provenance` | FEM CPU interpreted | valid bundle + m0 mutation |
| copied payload binding | `scripts/fem_producer_provenance_replay.py` + `payload_paths` | FEM CPU interpreted | inline/copy regression |
| identity preimages | `scripts/fem_equilibrium_identity_replay.py` + `replay_equilibrium_identity_preimages` | FEM CPU interpreted | physical identity suite |
| field/certificate replay | `scripts/fem_accepted_recomputed_replay.py` + `replay_artifact_paths` | FEM CPU interpreted | accepted/recomputed suite |
| adapter tests | `scripts/test_fem_producer_provenance_replay.py` + `class ProducerProvenanceReplayTests` | FEM CPU interpreted | fixture and mutation suite |
| producer routing | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_producer_payload_replay` | FEM CPU interpreted | real producer fixture, operator `NOT_VERIFIED` |
| routing regression | `scripts/test_fem_producer_provenance_replay.py` + `test_main_shared_routing_replays_real_producer_bundle` | FEM CPU interpreted | source replay and foreign artifact/path/hash rejection |
| consumer exact bytes | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_consumer_plan_exact_replay` | FEM CPU interpreted | raw digest replay; plan/operator remain `NOT_VERIFIED` |
