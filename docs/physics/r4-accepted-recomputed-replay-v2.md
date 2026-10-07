# R4: niezależny replay accepted/certified FEM sidecarów

Ten dokument opisuje interpretowany konsument trzech artefaktów statycznego
stanu FEM: zaakceptowanego endpointu, odświeżonego endpointu certified oraz
certyfikatu ich porównania. Replay wiąże payload ze źródłowym materiałem,
magnetyzacją równowagi, topologią siatki i trzema sygnaturami tożsamości
fizycznej. Nie jest to dowód wykonania natywnego solvera ani kwalifikacja
modalnej dyspersji.

(problem-statement)=
## 1. Dziedzina fizyczna

Rozpatrywany jest statyczny endpoint magnetycznego modelu FEM z polem
demagnetyzującym obliczanym przez część Poissona i airbox, jeżeli plan tego
wymaga. Artefakty są wejściem do późniejszej linearyzacji i nie zmieniają
operatora Floqueta ani relacji dyspersji. Dla każdego węzła `i` producent
publikuje składowe pola oraz potencjał:

```{math}
:label: r4-replay-field-sum
\mathbf H_{\mathrm{eff},i} = \mathbf H_{\mathrm{ex},i}
 + \mathbf H_{\mathrm{demag},i} + \mathbf H_{\mathrm{ext},i}
 + \mathbf H_{\mathrm{ani},i}.
```

Składnik anisotropy występuje wyłącznie w rodzinie V2. Rodzina V2 jest
wybierana przez niepustą wartość `uniaxial_anisotropy` (`Some`) w źródłowym
`MaterialIR`, także dla jawnego $K_u=0$; wartość zero nie oznacza rodziny V1.
Wartość `null` (`None`) wybiera V1; sama obecność klucza JSON nie wybiera V2.

### Macierz realizacji

| solver | urządzenie | status | zakres tej noty |
|---|---|---|---|
| FEM | CPU | documented | źródła walidatora i interpretowany replay sidecarów |
| FEM | GPU | not verified | ten sam format payloadu; brak dowodu urządzenia i runtime |
| FDM | CPU | unsupported | artefakty `CertifiedFemEquilibriumFields` są kontraktem FEM |
| FDM | GPU | unsupported | artefakty `CertifiedFemEquilibriumFields` są kontraktem FEM |

(governing-equations)=
## 2. Równania kontraktu

Dla każdego widoku wektorowego replay sprawdza dokładnie sumę
`H_eff = H_ex + H_demag + H_ext (+ H_ani)`. Różnica accepted/certified jest
liczona składowa po składowej:

```{math}
:label: r4-replay-difference
\Delta_X = \max_{i,c}\left|X^{\mathrm{accepted}}_{i,c}
 - X^{\mathrm{certified}}_{i,c}\right|,
\qquad
\Delta_\phi = \max_i\left|\phi_i^{\mathrm{accepted}}
 - \phi_i^{\mathrm{certified}}\right|.
```

Pole spełnia wspólną politykę natywną, gdy
$\Delta_X \le 10^{-6}\,\mathrm{A\,m^{-1}} +
10^{-8}\max(1,|X|)$, a potencjał spełnia
$\Delta_\phi \le 10^{-12}\,\mathrm A + 10^{-8}\max(1,|\phi|)$.

Digest każdego payloadu pól jest binarny i little-endian:

```{math}
:label: r4-replay-field-digest
D_F = \operatorname{SHA256}(s_F\,||\,0\,||\,
\operatorname{u64}_{LE}(n)\,||\,\operatorname{f64bits}_{LE}(F_1)\,||\cdots),
```

gdzie $s_F$ to wersja schematu, a kolejność widoków jest ustalona w kodzie
Rust. Przed każdym widokiem zapisywana jest jego długość `u64_LE`, następnie
bity wszystkich składowych. Dotyczy to także widoku potencjału; V2 dodaje
widok anizotropii między demag a polem zewnętrznym. Digest magnetyzacji
równowagi używa namespace
`RecomputedFemLinearizationCertificate.m0.v1`, liczby węzłów i bitów f64.

Digest certyfikatu ma inną granicę:

```{math}
:label: r4-replay-certificate-digest
D_C = \operatorname{SHA256}(s_C\,||\,0\,||\,
\operatorname{u64}_{LE}(|P_C|)\,||\,P_C),
```

gdzie $P_C$ są dokładnymi bajtami `serde_json::to_vec` po wyzerowaniu
`content_sha256`. Python nie odtwarza tych bajtów przez `json.dumps`.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| symbol | znaczenie | jednostka SI |
|---|---|---|
| $\mathbf H_{\mathrm{ex}}$ | pole wymiany | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag}}$ | pole demagnetyzujące | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ani}}$ | pole anizotropii jednoosiowej | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ext}}$ | pole zewnętrzne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | suma pól statycznych | $\mathrm{A\,m^{-1}}$ |
| $\phi$ | potencjał skalarny demagnetyzacji | $\mathrm{A}$ |
| $K_u$ | stała anizotropii jednoosiowej | $\mathrm{J\,m^{-3}}$ |
| $m_0$ | znormalizowany kierunek magnetyzacji równowagi, $\mathbf M_0/M_s$ | $1$ |
| $n$ | liczba węzłów | $1$ |
| $\Delta_X$ | maksymalna różnica składowej pola | $\mathrm{A\,m^{-1}}$ |
| $\Delta_\phi$ | maksymalna różnica potencjału | $\mathrm{A}$ |
| $D_F$ | digest binarny payloadu pól | $1$ |
| $D_C$ | digest certyfikatu | $1$ |
| $s_F$ | identyfikator schematu digestu pól | $1$ |
| $s_C$ | identyfikator schematu certyfikatu | $1$ |
| $F_i$ | uporządkowana wartość pola w rekordzie $i$ | $\mathrm{A\,m^{-1}}$ |
| $P_C$ | dokładne bajty preimage certyfikatu | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Replay zakłada, że payloady pochodzą z tego samego endpointu, mają zgodną
liczbę węzłów i używają natywnych nazw schematów. `MaterialIR` musi jawnie
zawierać klucz `uniaxial_anisotropy`; brak klucza jest odrzucany jako
niepełny snapshot. Wartość `None` wybiera V1, a liczba, w tym zero, wybiera
V2. Wszystkie liczby pól, $m_0$ i certyfikatu muszą być skończone.

Replay wylicza `fem_mesh_topology_fingerprint_v3` z rzeczywistego canonical
payloadu siatki (`nodes`, `cells`, markery, facets oraz pary PBC) i dopiero ten
wynik porównuje z certyfikatem. Przed fingerprintem wrapper wykonuje
strukturalny podzbiór `MeshIR::validate`: liczba węzłów, markery, CSR offsets,
ordinals, arity i zakresy indeksów, reguły topologii mieszanej oraz spójność
par PBC. Opcjonalne tablice PBC i ordinals są normalizowane tak jak
`serde(default)` w Rust; brak PBC oznacza pustą tablicę. Wrapper
odrzuca jednoczesne `tolerance` i `tolerance_m`: alias Rust oznacza to samo
pole, więc także przy równych wartościach jest to zduplikowany payload.
Wejście odpowiada topologii `FemMeshPayload`, więc nie wymaga pola `mesh_name` z pełnego
`MeshIR` i nie zastępuje natywnego `validate_mesh_for_execution`: kontrola
Jacobianów, orientacji i zbieżności geometrii pozostaje poza tym replayem.
Payload może być przekazany jako mapping albo niezmienione bajty JSON; brak
siatki pozostaje `mesh_binding_verified = False` i nigdy nie daje
`payload_replay_qualified = True`. Trzy sygnatury (`material`, `static physics`,
`boundary`) są oczekiwanymi digestami caller-validated preimage źródłowego
planu. Raport jawnie oznacza ten zakres jako
`identity_scope = caller_validated_source_signatures`; skrypt ich sam nie
rekonstruuje i nie udaje uwierzytelnienia producenta.

(python-api)=
## 5. Interfejs Python

Moduł `scripts/fem_accepted_recomputed_replay.py` udostępnia:

```python
# %%
from fem_accepted_recomputed_replay import (
    ReplaySourceContext,
    replay_accepted_recomputed_payloads,
)

# %%
source = ReplaySourceContext(
    node_count=4,
    material={"uniaxial_anisotropy": None},
    equilibrium_magnetization=[
        [0.0, 0.0, 1.0], [0.0, 0.0, 1.0],
        [0.0, 0.0, 1.0], [0.0, 0.0, 1.0],
    ],
    mesh_topology_sha256="sha256:<64 lowercase hex>",
    equilibrium_material_signature="sha256:<64 lowercase hex>",
    equilibrium_static_physics_signature="sha256:<64 lowercase hex>",
    equilibrium_boundary_signature="sha256:<64 lowercase hex>",
    mesh=canonical_mesh_mapping_or_exact_json_bytes,
)
report = replay_accepted_recomputed_payloads(
    accepted_fields,
    certified_fields,
    recomputed_certificate,
    source=source,
    certificate_preimage=producer_exact_certificate_bytes,
)
```

| konstruktor/funkcja | typ i wymagania | wynik |
|---|---|---|
| `ReplaySourceContext` | `node_count > 0`; skończone wektory $m_0$; canonical `mesh` mapping/bajty; trzy caller-validated digesty sygnatur oraz opcjonalny digest siatki; `material.uniaxial_anisotropy` obecne | typed source binding |
| `ArtifactPaths` | trzy istniejące pliki JSON accepted/certified/certificate | canonical sample paths |
| `load_json_artifact` | UTF-8 JSON object, bez duplicate keys, `NaN`/`Infinity`, nadmiernego zagnieżdżenia i lone surrogates | obiekt oraz niezmienione bajty pliku |
| `certificate_preimage_from_identity` | `recomputed_certificate_preimage_json` oraz zgodny raw SHA-256; extractor nie waliduje pełnego `linearization_identity.v2` | exact UTF-8 preimage bytes |
| `replay_accepted_recomputed_payloads` | payloady i `ReplaySourceContext`; preimage opcjonalne | `AcceptedRecomputedReplayReport` |
| `replay_artifact_paths` | `ArtifactPaths`; preimage bezpośrednio albo z identity | raport dla rzeczywistych sidecarów |

Mapowanie parametrów źródłowego kontekstu i preimage (typ, domyślność,
jednostka, walidacja, znaczenie, lane i powiązanie z `ProblemIR`):

| python | type | default | si_unit | validation | meaning | backend_support | problem_ir |
|---|---|---|---|---|---|---|---|
| `ReplaySourceContext.node_count` | `int` | `required` | `$1$` | `> 0 and equal to every field and m0 array length` | `Source FEM node count` | `FEM CPU/GPU payloads; runtime not verified` | `No change` |
| `ReplaySourceContext.material` | `mapping` | `required` | `SI values by MaterialIR field` | `Must explicitly include uniaxial_anisotropy; source identity is caller-validated` | `Producer material snapshot; this wrapper selects the field family` | `FEM CPU/GPU payloads; runtime not verified` | `materials[]; no mutation` |
| `ReplaySourceContext.equilibrium_magnetization` | `sequence of three-component finite vectors` | `required` | `$1$` | `Length equals node_count; native binary m0 digest must match certificate` | `Actual normalized source endpoint m0, not an operator air extension` | `FEM CPU/GPU payloads; runtime not verified` | `Source equilibrium artifact; no mutation` |
| `ReplaySourceContext.mesh_topology_sha256` | `sha256 string or None` | `required argument, may be None` | `$1$` | `When present must match fingerprint replayed from mesh; alone never qualifies mesh` | `Optional expected topology identity` | `FEM CPU/GPU payloads; runtime not verified` | `Source mesh provenance; no mutation` |
| `ReplaySourceContext.equilibrium_material_signature` | `sha256 string` | `required` | `$1$` | `Canonical lowercase digest equal to certificate; preimage validation is caller-owned` | `Expected producer material identity` | `FEM CPU/GPU payloads; runtime not verified` | `Source material identity; no mutation` |
| `ReplaySourceContext.equilibrium_static_physics_signature` | `sha256 string` | `required` | `$1$` | `Canonical lowercase digest equal to certificate; preimage validation is caller-owned` | `Expected static interactions and external-field identity` | `FEM CPU/GPU payloads; runtime not verified` | `Source static physics identity; no mutation` |
| `ReplaySourceContext.equilibrium_boundary_signature` | `sha256 string` | `required` | `$1$` | `Canonical lowercase digest equal to certificate; preimage validation is caller-owned` | `Expected source boundary identity` | `FEM CPU/GPU payloads; runtime not verified` | `Source boundary identity; no mutation` |
| `ReplaySourceContext.mesh` | `mapping or exact UTF-8 JSON bytes` | `None` | `$1$` | `Canonical v3 FemMeshPayload topology; structural MeshIR subset, Rust serde defaults for optional PBC/ordinals, omitted mesh keeps payload replay unqualified` | `Source nodes/cells/facets/markers/PBC used to recompute topology fingerprint` | `FEM CPU/GPU payloads; runtime not verified` | `mesh` |
| `ReplaySourceContext.material['uniaxial_anisotropy']` | `None or finite float` | `required key` | `\mathrm{J\,m^{-3}}` | `None selects V1; present finite value, including 0, selects V2` | `Material-family discriminator` | `FEM CPU/GPU payloads; runtime not verified` | `materials[].uniaxial_anisotropy` |
| `replay_accepted_recomputed_payloads.certificate_preimage` | `bytes or None` | `None` | `$1$` | `Exact producer UTF-8 serde bytes required for qualified certificate digest` | `Certificate framing preimage` | `FEM CPU/GPU payloads; runtime not verified` | `No change` |

`payload_replay_qualified` jest prawdziwe tylko dla poprawnych pól, zgodnego
$m_0$, rzeczywiście przeliczonej siatki, materiału, fizyki statycznej, granicy
oraz zweryfikowanego exact preimage certyfikatu. `scientific_qualification` pozostaje zawsze
`NOT_VERIFIED`. Sam brak preimage nie powoduje wyjątku dla field replay, ale
ustawia `certificate_content_digest_status =
"unverified_missing_preimage"` i `payload_replay_qualified = False`.

(problem-ir)=
## 6. ProblemIR

Ten przyrost nie dodaje pól do `ProblemIR`, nie zmienia normalizacji materiału
i nie wybiera backendu. Odczytuje wyłącznie istniejący snapshot `MaterialIR`
oraz artefakty wyprodukowane po loweringu. Requested device/runtime i resolved
execution pozostają własnością istniejącego provenance.

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

Round-trip zachowuje requested intent osobno od resolved execution: wrapper
odczytuje żądany materiał, siatkę i artefakty, a wybór FEM CPU/GPU oraz runtime
pozostaje w provenance producenta. `validation errors` są zgłaszane jako
`ValidationError` i nie ma cichego fallbacku. Niezgodne lub unsupported combinations
(na przykład payload FEM użyty jako FDM albo mixed topology z PBC)
kończą się stanem odrzuconym; nie są przedstawiane jako poprawny wynik.

Wczytanie sidecara zachowuje jego bajty, odrzuca zduplikowane klucze, lone
surrogates, nadmierne zagnieżdżenie i niekończone liczby. Schematy V1 i V2 są nieprzenikalne: V1 z polem
anizotropii oraz V2 bez niego są odrzucane. Zła suma `H_eff`, liczba węzłów,
digest pola, digest $m_0$, digest siatki albo którakolwiek z trzech sygnatur
kończy się `ValidationError`. Nie ma fallbacku V2→V1 ani dopisywania brakującej
próbki przez symetrię.

Obecny manifest sidecarów publikuje plik certyfikatu, ale nie osobną ścieżkę
do jego exact preimage. Preimage pozostaje dostępny w
`linearization_identity.v2.json` jako
`recomputed_certificate_preimage_json` i jego raw digest. Do niezależnego
replay można więc przekazać identity albo dodatkowy plik preimage. Bez tego
producent musi dodać addytywną, sample-scoped ścieżkę preimage; Python nie może
zgadywać jej przez ponowną serializację.

(discrete-realization)=
## 8. Dyskretna realizacja

Właścicielem semantyki pól, certyfikatu, digestów, tolerancji i wyboru rodziny
jest `crates/fullmag-runner`. Skrypt jest niezależnym konsumentem
interpretowanym. CPU i GPU mogą emitować ten sam typed sidecar, ale ta nota nie
wyciąga z niego dowodu urządzenia. FDM nie może przedstawić tego payloadu jako
artefaktu FEM.

(implementation-mapping)=
## 9. Mapowanie implementacji

| element | źródło | odpowiedzialność | dowód |
|---|---|---|---|
| V1/V2 fields i digest binarny | `crates/fullmag-runner/src/types.rs` — `CertifiedFemEquilibriumFields`, `certified_equilibrium_fields_sha256` | typy, kolejność widoków i bytes | source-visible |
| certyfikat i exact preimage | `crates/fullmag-runner/src/types.rs` — `RecomputedFemLinearizationCertificateV1`, `recomputed_fem_linearization_certificate_sha256` | typed fields i framing serde preimage | source-visible |
| native validation | `crates/fullmag-runner/src/fem_eigen.rs` — `validate_recomputed_fem_linearization_certificate` | m0, mesh, signatures, różnice i tolerancje | source-visible |
| publikacja accepted/certified | `crates/fullmag-runner/src/fem/eigen_execution.rs` — `decode_bias_field_relaxation_artifact_with_bytes` | zachowanie trzech payloadów | source-visible |
| sidecar identity | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` — `build_linearization_identity_v2` | zachowanie exact certificate preimage | source-visible |
| source mesh replay | `scripts/comsol_mesh_identity.py` — `mesh_topology_fingerprint_v3` | niezależne wyliczenie fingerprintu z nodes/cells/markers/facets/PBC | interpreted |
| mesh structural gate | `scripts/fem_accepted_recomputed_replay.py` — `_normalize_and_validate_mesh` | node count, CSR, ordinals, arity, indices, mixed-topology/PBC structural subset | interpreted tests |
| niezależny replay | `scripts/fem_accepted_recomputed_replay.py` — `replay_accepted_recomputed_payloads` | typed/content/array/context binding and explicit caller-validated scope | interpreted tests |
| identity preimage extractor | `scripts/fem_accepted_recomputed_replay.py` — `certificate_preimage_from_identity` | raw-byte extraction only; full `linearization_identity.v2` validation remains caller-owned | interpreted tests |

(validation)=
## 10. Walidacja

Regresję interpretowaną można uruchomić bez Cargo i bez natywnego builda:

```text
python -B -m unittest scripts/test_fem_accepted_recomputed_replay.py
```

Regresja obejmuje V1, V2, jawne $K_u=0$, binarne digesty pól, dokładne
różnice, digest $m_0$, rzeczywisty fingerprint v3 siatki, zgodność pustych
tablic PBC z domyślnym serde, strukturalne odrzucenie złej liczby węzłów,
offsetów i indeksów, mutacje nodes/cells/markerów/PBC,
mesh/material/static/boundary binding, identity-carried exact preimage, literal
Rust v1 preimage, duplicate JSON keys, lone Unicode surrogate i brak preimage.
Weryfikacja native unit,
managed runtime oraz GPU pozostają `NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia i dalsze bramki

- [x] typed accepted/certified/recomputed payload replay V1/V2;
- [x] explicit Ku=0 family selection;
- [x] field, m0, mesh, material, static-physics i boundary binding;
- [x] structural MeshIR subset before v3 fingerprint, including node-count and PBC default parity;
- [x] exact certificate preimage when supplied by producer/identity;
- [x] explicit caller-validated identity scope and extractor limitation;
- [x] fail-closed status when preimage is absent;
- [ ] addytywna, bezpośrednia ścieżka certificate preimage w manifeście sidecarów;
- [ ] kompilacja i managed FEM CPU/GPU runtime;
- [ ] modal residual, mesh/airbox/mode convergence;
- [ ] porównanie z COMSOL/TetraX i kwalifikacja naukowa dyspersji.

Brak preimage, brak runtime albo przejście testu interpretowanego nie jest
kwalifikacją solvera. Replay nie mierzy dokładności relacji dyspersji.

(scientific-bibliography)=
## 12. Bibliografia i dokumenty normatywne

- Fullmag, `docs/physics/r4-accepted-field-replay.md`, kontrakt różnic pól
  accepted/certified.
- Fullmag, `docs/physics/r4-linearization-identity-v2.md`, exact preimage i
  tożsamość linearyzacji.
- Fullmag, `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, statyczne
  pole Poissona i airbox.
- Fullmag, `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`,
  granica między stanem statycznym i modalnym.

(source-code-index)=
## 13. Indeks źródeł

| twierdzenie | path + symbol | lane | status |
|---|---|---|---|
| rodzina V1/V2 zależy od obecności Ku | `crates/fullmag-runner/src/fem_eigen.rs` + `validate_recomputed_fem_linearization_certificate` | FEM CPU/GPU | source-visible |
| digest pól jest binarny | `crates/fullmag-runner/src/types.rs` + `certified_equilibrium_fields_sha256` | FEM CPU/GPU | source-visible |
| digest m0 i różnice są wiązane | `crates/fullmag-runner/src/fem_eigen.rs` + `validate_recomputed_fem_linearization_certificate` | FEM CPU/GPU | source-visible |
| exact preimage nie jest zgadywany | `scripts/fem_accepted_recomputed_replay.py` + `certificate_preimage_from_identity` | FEM CPU | interpreted |
| replay wiąże m0, mesh i trzy caller-validated sygnatury | `scripts/fem_accepted_recomputed_replay.py` + `replay_accepted_recomputed_payloads` | FEM CPU | interpreted |
| regresja V1/V2/Ku0 i mutacji | `scripts/test_fem_accepted_recomputed_replay.py` + `test_v1_binds_m0_mesh_and_three_identity_signatures_but_missing_preimage_is_pending` | FEM CPU | interpreted |

Managed execution, native compilation, device identity i scientific release
gate są w tym dokumencie jawnie `NOT VERIFIED`.
