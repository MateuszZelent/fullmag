# Tożsamość liniaryzacji FEM: linearization_identity.v2

- Status: "source_visible / runtime_unvalidated"
- Właściciel: Fullmag FEM frequency-domain backend
- Data: 2026-10-01
- Zakres: addytywne związanie równowagi, exact payloadów i źródeł dla modalnego FEM
- Powiązane kontrakty: docs/specs/frequency-domain-artifacts-v2.md, docs/physics/0840-equilibrium-material-preimage-replay.md, docs/physics/r4-accepted-field-replay.md

(problem-statement)=
## 1. Domena fizyczna i cel

Modalny solver FEM buduje liniowy operator wokół magnetyzacji równowagi
$\mathbf m_0$. Dla niezerowego wektora falowego operator ma dodatkowo
topologię domeny mieszanej, warunek periodyczny Floqueta i próbkę $\mathbf k$.
Zgodność samego rozmiaru siatki nie dowodzi, że operator został zbudowany z
tej samej równowagi, materiału i źródła.

Artefakt linearization_identity.v2 jest addytywnym rekordem pochodzenia dla
jednego sample. Łączy:

- historyczny handoff relaksacji i jego digest;
- plan oraz snapshot źródła producenta i konsumenta;
- siatkę relaksacji, mieszaną topologię modalną i liczbę węzłów;
- dokładne identity materiału fizycznego;
- raw provenance planu materializacji;
- accepted, certified i recomputed payloady oraz ich dokładne bajty;
- artefakt równowagi i stan liniaryzacji;
- preimage certyfikatu recomputed.

Rekord nie definiuje nowej energii, warunku brzegowego ani równania
dyspersji. Nie jest dowodem, że solver znalazł poprawną częstotliwość. Jest
bramką pochodzenia, która ma zakończyć się fail-closed, gdy brakuje
któregokolwiek wymaganego związania.

`producer_source_snapshot_sha256`, `consumer_source_snapshot_sha256` oraz
odpowiadające im pola w build identity mają kanoniczny format 64 małych
znaków hex bez prefiksu, ustanowiony przez `fullmag-build-info`. Nie są
prefiksowanymi digestami payloadu. Warunek zgodności snapshotów pozostaje
porównaniem dokładnych identyfikatorów; prefiks, uppercase, brakujące pole
lub obcy snapshot są błędem. Mapowanie: `strict_build_identity_snapshot`
w `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs`.

Wspólny `validate_linearization_identity_source_snapshots` sprawdza również
zgodność zagnieżdżonych build identity z polami top-level. Używają go writer
preimage oraz Rustowy inspector strukturalny i walidator sidecara. Sam
`linearization_identity_v2_content_sha256_from_preimage_bytes` pozostaje
funkcją skrótu dokładnych bajtów; poprawny digest ramki nie zastępuje
walidacji kontraktu snapshotów. Regresje Rust tej granicy są przygotowane,
ale nie kompilowane; managed runtime pozostaje NOT VERIFIED.

(governing-equations)=
## 2. Digesty i związanie fizyczne

Tożsamość fizyczna materiału, statyki i boundary jest obliczana niezależnie od
raw provenance planu:

```{math}
:label: eq-equilibrium-identity-tuple
\mathcal I_{\mathrm{eq}} =
\left(
D_{\mathrm{mat}}^{\mathrm{eq}},
D_{\mathrm{stat}},
D_{\mathrm{bnd}}
\right).
```

Dla namespace N oraz dokładnych bajtów UTF-8 p obowiązuje ramka digestu
producenta:

```{math}
:label: eq-framed-sha256
D_N(p)=\operatorname{SHA256}
\left(
N\;\Vert\;\mathtt{0x00}\;\Vert\;
\operatorname{LE}_{64}(|p|)\;\Vert\;p
\right).
```

Wszystkie digesty typu sha256:<64 lowercase hex> muszą być liczone na
dokładnych bajtach, a nie na obiekcie zrekonstruowanym przez klienta. Dla
wektora równowagi handoff zachowuje historyczną ramkę:

```{math}
:label: eq-m0-content-digest
D_{m_0}=\operatorname{SHA256}
\left(
\mathtt{AcceptedFemRelaxStageHandoff.m0.v1}
\;\Vert\;\mathtt{0x00}\;\Vert\;
\operatorname{LE}_{64}(n)\;\Vert\;
\big\Vert_{i=0}^{n-1}\big\Vert_{c=0}^{2}
\operatorname{LE}_{64}\!\left(\operatorname{bits}(m_{0,i,c})\right)
\right).
```

linearization_identity.v2 zeruje własne pole content_sha256, serializuje
pozostałe pola dokładnie przez producerowy serde_json::to_vec, a następnie
używa tej samej ramki:

```{math}
:label: eq-linearization-identity-digest
p_{\mathrm{id}} =
\operatorname{JSON}_{\mathrm{serde}}
\left(
I_{\mathrm{v2}}[
\mathrm{content\_sha256}\leftarrow\text{""}]
\right),
\qquad
D_{\mathrm{id}}=D_{\texttt{linearization\_identity.v2}}
(p_{\mathrm{id}}).
```

Certyfikat recomputed zachowuje osobny historyczny digest. Jego preimage to
dokładne bajty JSON z wyzerowanym content_sha256:

```{math}
:label: eq-recomputed-certificate-preimage
p_{\mathrm{cert}} =
\operatorname{JSON}_{\mathrm{serde}}
\left(
C[
\mathrm{content\_sha256}\leftarrow\text{""}]
\right),
\qquad
D_{\mathrm{cert}}=
D_{\mathrm{schema\_version}(C)}(p_{\mathrm{cert}}),
\qquad
D_{\mathrm{cert,raw}}=\operatorname{SHA256}(p_{\mathrm{cert}}).
```

D_cert,raw jest pomocniczym digestem dokładnych bajtów. Nie zastępuje
historycznego content_sha256, ponieważ zachowanie jego namespace i długości
jest wymagane przez kompatybilność V1/V2.

Handoff sprawdza również normę stanu:

```{math}
:label: eq-m0-node-norm
\left|\lVert\mathbf m_{0,i}\rVert_2-1\right|
\leq 10^{-8}
\quad\text{dla każdego węzła magnetycznego }i.
```

Dla producenta i konsumenta obowiązuje:

```{math}
:label: eq-source-snapshot-binding
D_{\mathrm{source}}^{\mathrm{producer}}
=
D_{\mathrm{source}}^{\mathrm{consumer}},
\qquad
\mathrm{cross\_build\_policy}
=\texttt{same\_source\_snapshot\_required}.
```

Różnica tłumienia relaksacji i eigen nie narusza tej zasady. Na przykład
relaksacja może mieć damping = 0.5, a operator modalny damping = 0.0; raw
MaterialIR provenance obu planów jest wtedy różne, ale $\mathcal I_{\mathrm{eq}}$
pozostaje równe, jeśli statyczne $M_s$, $A_{\mathrm{ex}}$, $K_u$, oś,
pole i boundary są zgodne.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathcal I_{\mathrm{eq}}$ | fizyczna krotka tożsamości równowagi | $1$ |
| $D_{\mathrm{mat}}^{\mathrm{eq}}$ | canonical physical equilibrium material signature | $1$ |
| $D_{\mathrm{stat}}$ | signature statycznych pól i interakcji | $1$ |
| $D_{\mathrm{bnd}}$ | signature statycznych warunków brzegowych | $1$ |
| $N$ | namespace ramki digestu | $1$ |
| $p$ | dokładne bajty UTF-8 preimage | $1$ |
| $|p|$ | długość preimage | $1$ |
| $D_N(p)$ | framed SHA-256 | $1$ |
| $D_{m_0}$ | digest wektora równowagi | $1$ |
| $\mathbf m_{0,i}$ | znormalizowana magnetyzacja w węźle $i$ | $1$ |
| $p_{\mathrm{id}}$ | preimage identity v2 | $1$ |
| $D_{\mathrm{id}}$ | digest identity v2 | $1$ |
| $p_{\mathrm{cert}}$ | preimage certyfikatu recomputed | $1$ |
| $D_{\mathrm{cert}}$ | historyczny digest certyfikatu | $1$ |
| $D_{\mathrm{cert,raw}}$ | digest bajtów preimage certyfikatu | $1$ |
| $\mathbf k$ | wektor falowy próbki modalnej | $\mathrm{rad\,m^{-1}}$ |
| $k$ | moduł lub podpisana składowa $\mathbf k$ | $\mathrm{rad\,m^{-1}}$ |
| $s$ | współrzędna postępu po ścieżce k | $1$ |
| $i,j$ | indeksy węzłów lub próbek | $1$ |
| $n$ | liczba węzłów w równowadze | $1$ |
| $c$ | indeks składowej wektora magnetyzacji | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | stała anizotropii jednoosiowej | $\mathrm{J\,m^{-3}}$ |
| $\mathbf u$ | kanoniczna oś anizotropii | $1$ |
| $\alpha$ | tłumienie użytego planu | $1$ |
| $f$ | częstotliwość własna | $\mathrm{Hz}$ |
| $I_{\mathrm{v2}}$ | typed payload identity v2 | $1$ |
| $C$ | typed recomputed certificate | $1$ |
| $D_{\mathrm{source}}^{\mathrm{producer}}$ | digest snapshotu źródła producenta | $1$ |
| $D_{\mathrm{source}}^{\mathrm{consumer}}$ | digest snapshotu źródła konsumenta | $1$ |

(assumptions-and-validity)=
## 4. Rodziny artefaktów i granice ważności

### 4.1. Historyczna rodzina Ku-free V1

Dla materiału bez authoringowego pola Ku pozostają bez zmian:

| Rola | Schemat |
|---|---|
| równowaga | equilibrium_artifact.v7 |
| stan liniaryzacji | LinearizationState.v6 |
| accepted/certified fields | CertifiedFemEquilibriumFields.v1 |
| certyfikat | RecomputedFemLinearizationCertificate.v1 |
| material identity | historyczny raw material_signature bez pól V2 |

V1 nie może udawać V2 przez dopisanie material_identity_kind,
material_provenance_signature lub material_provenance_scope. Stare digesty,
nazwy plików i interpretacja pozostają czytelne w historycznym zakresie.

### 4.2. Rodzina canonical Ku V2

Obecność authoringowego uniaxial_anisotropy wybiera V2. Dotyczy to także
jawnego $K_u=0$, które nie może zostać zredukowane do V1:

| Rola | Schemat |
|---|---|
| równowaga | equilibrium_artifact.v8 |
| stan liniaryzacji | LinearizationState.v7 |
| accepted/certified fields | CertifiedFemEquilibriumFields.v2 |
| certyfikat | RecomputedFemLinearizationCertificate.v2 |
| material identity | material_identity_kind = canonical_equilibrium_material.v2 |

Canonical material_signature jest fizyczną sygnaturą równowagi. Osobne
material_provenance_signature i material_provenance_scope =
materialization_plan wiążą raw MaterialIR planu, z którego zmaterializowano
artefakt. Znak i niezerowa skala osi mogą zmienić raw preimage, jeśli po
kanonizacji oznaczają tę samą oś fizyczną; zmiana $K_u$, canonical axis albo
statycznego materiału jest odrzucana.

### 4.3. Relax kontra eigen

Raw preimage producenta i konsumenta jest przechowywany osobno:

- producer_material_provenance_signature opisuje plan relaksacji;
- material_provenance_signature i odpowiadający preimage opisują aktualny
  plan eigen/materialization;
- equilibrium_material_signature opisuje wspólną fizyczną tożsamość materiału
  równowagi;
- equilibrium_static_physics_signature i equilibrium_boundary_signature wiążą
  odpowiednio statykę i boundary.

Damping jest własnością planu wykonania, a nie statycznej tożsamości
równowagi. Handoff nie może odrzucić poprawnej kontynuacji wyłącznie dlatego,
że $\alpha_{\mathrm{relax}}\ne\alpha_{\mathrm{eigen}}$.

### 4.4. Mesh, m0 i próbki k

source_mesh_topology_sha256 oznacza siatkę źródłowej relaksacji.
modal_mesh_topology_fingerprint_v3 oznacza mieszaną topologię domeny użytej
przez operator modalny, w tym część magnetyczną i airbox. Obie role są
rozłączne i nie wolno nadpisywać jednej drugą. node_count oraz
equilibrium_content_sha256 wiążą liczbę węzłów i exact m0.

Identity jest tworzona osobno dla każdego sample_index. Dotyczy zarówno
KSamplingIR::Single dla pojedynczego niezerowego $\mathbf k$, jak i każdego
punktu KSamplingIR::Path w wielopunktowej ścieżce. Manifest przechowuje tablice
ścieżek w numerycznej kolejności próbek; nie zakłada symetrii
$+\mathbf k/-\mathbf k$ i nie tworzy brakujących punktów przez odbicie.
Tożsamość stanu nie jest identyfikacją gałęzi częstotliwości; branch tracking
pozostaje osobnym kontraktem modalnym.

Canonicalna nazwa katalogu jest zgodna z Rust `format!("{index:04}")`:
`sample_0007` jest poprawne, `sample_00000` jest odrzucane, a dla indeksu
`10000` poprawną ścieżką jest `sample_10000`. Coverage sidecarów jest liczony
z rzeczywistych `sample_index` rozwiązanych próbek. Każdy niepusty zestaw
accepted/identity/preimage/certified/recomputed musi mieć ten sam zbiór próbek,
jedną rodzinę V1 albo V2 oraz zgodne exact raw-byte own-links. Incomplete lub
historyczny brak sidecarów otrzymuje status `NOT_VERIFIED`; nie zmienia to
czytelności historycznych artefaktów.

### 4.5. Ograniczenia

Identity nie dowodzi:

- poprawności zbieżności relaksacji, siatki ani airboxu;
- residualu modalnego lub poprawności wybranej gałęzi;
- parytetu COMSOL, TetraX, FEM GPU ani FDM;
- wykonania managed runtime;
- niezależnego odtworzenia własnego content_sha256 dla konkretnego artefaktu,
  jeśli nie są dostępne dokładne bajty $p_{\mathrm{id}}$.

Producer publikuje teraz sample-scoped sidecar
`linearization_identity_preimage.v1.json` obok identity v2. Sidecar zawiera
exact UTF-8 $p_{\mathrm{id}}$, jego surowy SHA-256 oraz framed digest identity;
nie ma własnego digestu, więc nie tworzy cyklicznego hasha. Python może wykonać
niezależny replay, gdy oba artefakty są dostępne. To nadal nie jest dowód
managed runtime ani kwalifikacja naukowa.

(python-api)=
## 5. Python API

Ten przyrost nie dodaje konstruktora ani parametru publicznego Python DSL.
ProblemIR pozostaje właścicielem fizycznego planu; identity powstaje dopiero
na granicy runnera. Poniższy fragment jest samodzielnym przykładem framingu
digestu dla testów kontraktu. Nie uruchamia solvera i nie jest dowodem runtime.

```python
# %%
from hashlib import sha256
from struct import pack

# %%
def framed_sha256(namespace: str, payload: bytes) -> str:
    frame = (
        namespace.encode("utf-8")
        + b"\x00"
        + pack("<Q", len(payload))
        + payload
    )
    return "sha256:" + sha256(frame).hexdigest()

# %%
identity_schema = "linearization_identity.v2"
identity_preimage = (
    b'{"schema_version":"linearization_identity.v2",'
    b'"cross_build_policy":"same_source_snapshot_required"}'
)
identity_digest = framed_sha256(identity_schema, identity_preimage)
assert identity_digest.startswith("sha256:")
assert len(identity_digest) == len("sha256:") + 64

# %%
# Production replay must consume producer-published exact bytes.
# json.dumps(...) is intentionally not used to recreate Rust serde bytes.
assert identity_preimage.startswith(b'{"schema_version"')
```

Przykład nie opisuje ścieżki publicznego authoringu i nie może być używany do
uruchamiania analizy. Pełny niezależny replay identity pozostaje
NOT VERIFIED, dopóki exact $p_{\mathrm{id}}$ nie będzie dostępny.

(problem-ir)=
## 6. ProblemIR, requested intent i resolved execution

Nie zmienia się FemEigenPlanIR, FemPlanIR, MaterialIR ani KSamplingIR. Plan
zachowuje requested device, precision i tryb solvera, resolved execution oraz
faktyczny runtime, materiał, damping i boundary oraz pojedynczy
KSamplingIR::Single albo ścieżkę KSamplingIR::Path.

Identity zapisuje digest snapshotu planu producenta i konsumenta, ale nie zastępuje
samego planu. material_signature nie jest nazwą materiału z UI: dla V2 jest
canonical physical signature, a material_provenance_signature jest raw
preimage materializacji. Brak źródłowego snapshotu, nieznany backend lub
niezgodna rodzina artefaktów kończy się błędem walidacji.

(round-trip-and-failure-semantics)=
## 7. Round-trip i fail-closed

Producent:

1. zapisuje accepted fields przed refresh oraz certified fields i recomputed
   certificate po refresh;
2. waliduje oba payloady i certyfikat niezależnie;
3. przechowuje dokładne bajty wszystkich trzech dokumentów w verified handoff;
4. przy modalnym sample odczytuje parę equilibrium/state i sprawdza family,
   mesh, m0, materiał, statykę, boundary i źródło;
5. serializuje `FemEigenPlanIR` raz, używa tych samych bajtów do
   `consumer_plan_snapshot_sha256` i publikuje je jako
   `consumer_plan_snapshot.v1.json`;
6. publikuje sidecary sample-scoped oraz identity.

Konsument odrzuca brak jednego z trzech payloadów, mieszanie V1/V2 lub
niespójną parę equilibrium/state, V1 z polami V2, V2 bez canonical kind,
raw provenance lub właściwego scope, różne source snapshots, różne physical
material/static/boundary signatures, zmienione exact bytes lub digest,
nieznaną politykę cross-build i brak wymaganego identity.

Puste tablice legacy w manifeście nie deklarują drugiej rodziny. Relokacja
artefaktu zachowuje jego bajty i digesty. Deduplikacja może łączyć identyczne
bajty, ale konflikt pod jedną ścieżką jest błędem, nie wyborem pierwszego
rekordu. Validation errors kończą się odrzuceniem artefaktu, a unsupported combinations
nie otrzymują fallbacku. Brak dowodu jest NOT VERIFIED, a nie
domyślną zgodnością.

Sidecar planu konsumenta jest surowym wynikiem `serde_json::to_vec` bez
koperty. Jego ścieżka ma postać
`eigen/metadata/sample_NNNN/consumer_plan_snapshot.v1.json`, a manifesty
publikują `consumer_plan_snapshot_v1_paths[]` oraz singular alias dla
pojedynczego sample. Odbiornik sprawdza raw SHA względem pola
`consumer_plan_snapshot_sha256` identity i parsuje te same bajty jako
`FemEigenPlanIR`; nie rekonstruuje planu ani nie używa reserializacji jako
dowodu exact bytes. Brak lub niezgodność tej rodziny pozostaje
`r4_replay.qualification = "NOT_VERIFIED"`.

(discrete-realization)=
## 8. Realizacja FEM i backendów

### FEM CPU

To jest bieżąca ścieżka producenta i konsumenta identity: native shared-domain
modal artifacts, Floquet/mixed topology, single-k i multi-k. Status źródłowy
jest widoczny, lecz runtime managed i wartości naukowe są jeszcze
niezweryfikowane.

### FEM GPU

Format identity może pozostać artefaktem pochodzenia wspólnym dla przyszłej
realizacji, ale nie ma dowodu wykonania GPU ani parytetu. Status:
unsupported / runtime_unvalidated dla tego przyrostu. Wymuszone GPU nie może
spaść cicho do CPU.

### FDM CPU i FDM GPU

Identity v2 dotyczy artefaktów FEM equilibrium/modal i nie zmienia ścieżek
FDM. Status: not_applicable.

(implementation-mapping)=
## 9. Mapowanie implementacji

| Element kontraktu | Ścieżka i symbol | Rola |
|---|---|---|
| typed identity v2 | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + LinearizationIdentityV2 | pola, family, source/build, material, mesh i sidecary |
| verified exact handoff | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + from_completed_relax_verified_with_exact_artifacts | walidacja accepted/certified/recomputed i zachowanie bajtów |
| identity producer | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + build_linearization_identity_v2 | sprawdzenie target planu i budowa rekordu sample |
| consumer plan snapshot | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + consumer_plan_snapshot_bytes_and_sha256 | jeden exact serde byte stream dla digestu identity i sidecara |
| identity digest | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + linearization_identity_v2_content_sha256 | framed digest po wyzerowaniu własnego content |
| exact cert preimage | crates/fullmag-runner/src/types.rs + recomputed_fem_linearization_certificate_preimage_bytes | exact serde bytes certyfikatu |
| producer sidecary | crates/fullmag-runner/src/fem/eigen_native_artifacts.rs + native_modal_artifacts | publikacja accepted/certified/recomputed/identity/preimage/consumer plan |
| konflikt bajtów | crates/fullmag-runner/src/fem/eigen_native_artifacts.rs + append_exact_signed_sidecar | fail-closed przy sprzecznych dokumentach |
| single-k manifest binding | crates/fullmag-runner/src/fem/eigen_output.rs + validate_published_linearization_identity_sidecars | sprawdza identity, exact preimage i rzeczywisty content digest przed reklamą ścieżek |
| bias continuation | crates/fullmag-runner/src/fem/eigen_execution.rs + from_completed_relax_verified_with_exact_artifacts | ta sama bramka dla kolejnego sample |
| CLI consumer | crates/fullmag-cli/src/orchestrator.rs + accepted_relax_handoff_from_completed_stage_with_exact_artifacts | odczyt exact artefaktów i verified handoff |
| manifest paths | crates/fullmag-runner/src/fem/eigen_path_manifest.rs + eigen_path_state_metadata_paths | multi-sample ścieżki sidecarów |
| path selectors | crates/fullmag-runner/src/fem/eigen_path_artifacts.rs + sample_scoped_signed_state_artifact_index | jeden canonical parser sample_NNNN, bez arbitrary zero-padding |
| R4 coverage guard | crates/fullmag-runner/src/fem/eigen_output.rs + inspect_r4_sidecars | rzeczywisty sample set, family completeness, consumer-plan raw SHA, exact identity own-links i per-sample digest |
| path R4 manifest status | crates/fullmag-runner/src/fem/eigen_path_manifest.rs + build_eigen_path_frequency_domain_manifest | historyczny brak oraz partial sidecars pozostają NOT VERIFIED |
| source replay tests | scripts/test_eigen_path_signed_sidecars.py + test_* | zgodność rodzin, brakujące i sprzeczne sidecary |
| own identity preimage replay | scripts/fem_linearization_identity_replay.py + replay_identity_preimage | exact sidecar, typed equality, duplicate/unknown/nonfinite rejection |
| own identity replay tests | scripts/test_fem_linearization_identity_replay.py + class IdentityReplayTests | 10 grup mutation/format checks; nie jest to managed runtime |

(scientific-documentation-map)=
## 10. Mapa API, źródeł i artefaktów

Tożsamość jest wewnętrznym kontraktem artefaktów, nie nową metodą publicznego
Python API. Python/IR i lowering FEM dostarczają plan; identity nie zmienia ich
parametrów. Producer native_modal_artifacts zapisuje sidecary w końcowej
przestrzeni publikacji: root dla pojedynczego solve oraz
`eigen/metadata/sample_NNNN/` dla punktu ścieżki. Wrapper ścieżki przekazuje
rzeczywisty `sample_index` przed framingiem identity; remap zachowuje już
sample-scoped signed bytes. Consumer CLI i runner używają verified handoff.
Single-k oraz eigen_path manifest publikują tylko rzeczywiście znalezione
tablice R4 i dołączają `r4_replay` z coverage, statusem oraz mapą
`linearization_identity_sha256_by_sample`; brak lub częściowość nie jest
kwalifikacją.
W kompletnym nowym pakiecie tablice obejmują także
`consumer_plan_snapshot_v1_paths[]`; single-k dodaje alias
`consumer_plan_snapshot_v1_path`. Sidecar jest dokładnym JSON planu użytym
przez identity, więc Python może sprawdzić raw SHA bez rekonstrukcji planu.

Python verifier potrafi odtworzyć identity z dostarczonego sample-scoped
sidecara exact p_id; testy kontraktu obejmują 10 grup mutacji i odrzuceń. Nie
jest to jeszcze replay
produkcyjnego artefaktu z managed runtime ani dowód wykonania solvera. Artefakt
nie jest dowodem zgodności z COMSOL-em lub TetraX. Takie porównanie wymaga branch binding, residuali,
zbieżności siatki/airboxu i managed runtime.

(validation)=
## 11. Walidacja i bramki

| Bramka | Stan | Znaczenie |
|---|---|---|
| parser Rust zmienionych plików | NOT VERIFIED | przygotowany guard Rust; native/unit compilation nieuruchomione |
| source/map checks sidecarów | NOT VERIFIED | zmieniono mapę i kontrakt; walidacja po zakończeniu fragmentu |
| exact cert preimage helper | PASS źródłowy | helper ma regresję exact bytes; native test nieuruchomiony |
| native unit compilation | NOT VERIFIED | obowiązuje zakaz kompilacji testów |
| managed FEM CPU runtime | NOT VERIFIED | brak terminalnego receipt dla tego przyrostu |
| FEM GPU runtime/parytet | NOT VERIFIED | brak dowodu urządzenia i wykonania |
| Python replay produkcyjnego artefaktu p_id | NOT VERIFIED | verifier i testy fixture istnieją, brak managed artifact |
| Python sidecar replay contract | PASS | 10 grup interpreted mutation/format checks |
| residual/modal branch validation | NOT VERIFIED | identity nie jest residualem |
| mesh/airbox convergence | NOT VERIFIED | wymaga osobnych serii |
| COMSOL/TetraX comparison | NOT VERIFIED | wymaga zgodnych artefaktów referencyjnych |

Minimalna bramka naukowa przed kwalifikacją wymaga spójnej pary family,
pełnych sidecarów, exact byte replay, własnego identity preimage sidecara,
zgodnego source/build snapshotu, weryfikacji mesh/m0, residualu każdego modu,
zbieżności siatki i airboxu oraz osobnej walidacji fizycznej. Sama obecność
linearization_identity_v2_paths[] nie spełnia tej bramki.

Sidecar linearization_identity_preimage.v1.json oraz odpowiadająca tablica
linearization_identity_preimage_v1_paths[] są publikowane addytywnie. Sidecar
ma schema_version = linearization_identity_preimage.v1 i zawiera
identity_schema, dokładny UTF-8 identity_preimage_json,
identity_preimage_sha256 oraz identity_content_sha256; jego własny digest nie
jest częścią p_id. Konsument porównuje exact preimage, typed semantic
equality z identity po wyzerowaniu content_sha256 i framed digest. Brak
sidecara dla deklarowanego identity kończy się błędem fail-closed.

(limitations)=
## 12. Ograniczenia i prace odroczone

- [x] Zachowanie historycznych equilibrium/state V7/V6, nazw i digestów.
- [x] Rozdzielenie V1 raw od V2 canonical, w tym jawnego Ku=0.
- [x] Oddzielne source/raw provenance producenta i konsumenta.
- [x] Związanie m0, source mesh, modal mixed topology i endpointów.
- [x] Exact bytes accepted/certified/recomputed w verified handoff.
- [x] Exact recomputed-certificate preimage helper.
- [x] Publikacja exact p_id własnego identity digestu jako sidecar sample.
- [x] Canonicalny parser `sample_NNNN` oraz strukturalny R4 sample-set guard.
- [x] Niezależny verifier sidecara own identity preimage na fixture.
- [ ] Replay own identity preimage na artefakcie z managed runtime.
- [ ] Native/managed runtime oraz pełna walidacja FEM.
- [ ] Zbieżność siatki, airboxu, liczby modów i branch tracking.
- [ ] Porównanie z analityką, COMSOL i TetraX.

(scientific-bibliography)=
## 13. Bibliografia i kontrakty nadrzędne

- NIST, Secure Hash Standard (SHS), FIPS 180-4,
  https://doi.org/10.6028/NIST.FIPS.180-4.
- Fullmag, docs/physics/0840-equilibrium-material-preimage-replay.md,
  exact material preimage V1/V2 i jawne Ku=0.
- Fullmag, docs/physics/r4-accepted-field-replay.md, accepted/certified/
  recomputed replay staticznego stanu.
- Fullmag, docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md,
  kontrakt modalnego operatora i residualu.
- Fullmag, docs/adr/0031-fem-nonzero-k-dispersion-representations.md,
  reprezentacja ścieżki k i ograniczenia kwalifikacji.

(source-code-index)=
## 14. Indeks źródeł

| Twierdzenie | Źródło path + symbol | Lane | Dowód |
|---|---|---|---|
| framed identity digest | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + linearization_identity_v2_content_sha256 | FEM CPU | source-visible; runtime NOT VERIFIED |
| typed schema and field roles | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + LinearizationIdentityV2 | FEM CPU | source-visible |
| exact consumer plan snapshot | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + consumer_plan_snapshot_bytes_and_sha256 | FEM CPU | source-visible; runtime NOT VERIFIED |
| consumer plan raw-SHA gate | crates/fullmag-runner/src/fem/eigen_output.rs + inspect_r4_sidecars | FEM CPU | source-visible; runtime NOT VERIFIED |
| physical V1/V2 signatures | crates/fullmag-runner/src/fem/equilibrium_identity.rs + from_relax_plan | FEM CPU | source + existing contract |
| exact accepted/recomputed handoff | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + AcceptedFemRelaxStageReplayPayload | FEM CPU | source-visible |
| exact certificate preimage | crates/fullmag-runner/src/types.rs + recomputed_fem_linearization_certificate_preimage_bytes | FEM CPU | source + prepared regression |
| sidecar publication | crates/fullmag-runner/src/fem/eigen_native_artifacts.rs + native_modal_artifacts | FEM CPU | source-visible; runtime NOT VERIFIED |
| final state paths in identity | crates/fullmag-runner/src/fem/eigen_native_artifacts.rs + state_artifact_paths | FEM CPU | source-visible; runtime NOT VERIFIED |
| path sample-index forwarding | crates/fullmag-runner/src/fem/eigen_path.rs + solve_single_k | FEM CPU | source-visible; runtime NOT VERIFIED |
| signed sample remap | crates/fullmag-runner/src/fem/eigen_path_artifacts.rs + remap_single_k_mode_artifacts | FEM CPU | source-visible; runtime NOT VERIFIED |
| manifest family selectors | crates/fullmag-runner/src/fem/eigen_path_manifest.rs + eigen_path_state_metadata_paths | FEM CPU | source-visible |
| single-k R4 arrays | crates/fullmag-runner/src/fem/eigen_output.rs + sample_scoped_signed_sidecar_paths | FEM CPU | source-visible; runtime NOT VERIFIED |
| producer provenance path selection | crates/fullmag-runner/src/fem/eigen_output.rs + sample_scoped_producer_provenance_paths | FEM CPU | source-visible; runtime NOT VERIFIED |
| producer provenance manifest transport | crates/fullmag-runner/src/fem/eigen_path_manifest.rs + build_eigen_path_frequency_domain_manifest | FEM CPU | source-visible; runtime NOT VERIFIED |
| identity preimage sidecar | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + linearization_identity_v2_preimage_sidecar_bytes | FEM CPU | source-visible; exact replay NOT VERIFIED on managed artifact |
| CLI exact handoff | crates/fullmag-cli/src/orchestrator.rs + accepted_relax_handoff_from_completed_stage_with_exact_artifacts | FEM CPU | source-visible |
| Python sidecar routing | scripts/test_eigen_path_signed_sidecars.py + test_* | artifact verifier | interpreted PASS |
| Python own preimage replay | scripts/fem_linearization_identity_replay.py + replay_identity_preimage | artifact verifier | source + 9 interpreted groups PASS |
| Python own preimage regressions | scripts/test_fem_linearization_identity_replay.py + class IdentityReplayTests | artifact verifier | 9 interpreted groups PASS |
| physical material replay | crates/fullmag-runner/src/fem/equilibrium_identity.rs + replay_equilibrium_material_signature | FEM CPU | source-visible; runtime NOT VERIFIED |
| source snapshot policy | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + strict_build_identity_snapshot | FEM CPU | source-visible |
| m0 endpoint binding | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + vector_field_content_sha256 | FEM CPU | source-visible; runtime NOT VERIFIED |
| physical identity constructor | crates/fullmag-runner/src/fem/equilibrium_identity.rs + from_relax_plan | FEM CPU | source-visible |
| m0 norm gate | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + validate_handoff_m0_norms | FEM CPU | source-visible; runtime NOT VERIFIED |
| shared snapshot validation | crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs + validate_linearization_identity_source_snapshots | FEM CPU | raw64, nested/top-level binding; runtime NOT VERIFIED |

Nota nie promuje source parsera, testów interpretowanych ani obecności plików do
kwalifikacji solvera. Uzupełnienie własnego exact preimage identity i dowody
runtime pozostają wymagane.
