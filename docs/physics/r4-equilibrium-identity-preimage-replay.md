# Niezależny replay preimage tożsamości równowagi FEM

- Status: `source_visible / interpreted_contract_only`
- Właściciel: wewnętrzny verifier artefaktów FEM frequency-domain
- Data: 2026-10-01
- Zakres: pięć dokładnych preimage'ów z `linearization_identity.v2`
- Kontrakty nadrzędne: `docs/physics/0840-equilibrium-material-preimage-replay.md`,
  `docs/physics/r4-linearization-identity-v2.md`

(problem-statement)=
## 1. Problem fizyczny i cel

Solver modalny FEM używa stanu równowagi do zbudowania operatora liniowego.
Przed interpretacją częstotliwości trzeba ustalić, że materiał i statyka
źródła są tym samym przypadkiem, który opisuje artefakt modalny. Rekord
`linearization_identity.v2` przenosi trzy preimage'y fizycznej tożsamości
równowagi oraz dwa surowe preimage'y `MaterialIR`:

1. `equilibrium_material_preimage_json` — materiał statyczny V1 albo V2;
2. `equilibrium_static_physics_preimage_json` — wymiana, demag i pole zewnętrzne;
3. `equilibrium_boundary_preimage_json` — boundary, demag/airbox i PBC;
4. `producer_material_provenance_preimage_json` — raw materiał planu relaksacji;
5. `material_provenance_preimage_json` — raw materiał planu eigen/materializacji.

Helper `scripts/fem_equilibrium_identity_replay.py` sprawdza każdy JSON,
liczy digest z jego oryginalnych bajtów UTF-8 i porównuje go z digestem
opublikowanym w identity. Nie rekonstruuje bajtów przez `json.dumps` i nie
twierdzi, że częstotliwość, residual, operator modalny albo zgodność z COMSOL
zostały zweryfikowane.

(governing-equations)=
## 2. Ramki digestów

Dla trzech preimage'ów fizycznych producent używa namespace $N$ oraz
dokładnego strumienia bajtów $p$:

```{math}
:label: eq-r4-identity-framed-digest
D_N(p)=\operatorname{SHA256}\left(N\,\Vert\,\mathtt{0x00}\,\Vert\operatorname{LE}_{64}(|p|)\,\Vert\,p\right).
```

Dwa preimage'y raw są liczone przez `shared_domain_content_digest`. Label
`material_signature` służy do komunikatu i nie jest częścią hashowanych bajtów:

```{math}
:label: eq-r4-identity-raw-material-digest
D_{\mathrm{raw}}(p)=\operatorname{SHA256}(p).
```

Wspólna fizyczna kontrola ma postać:

```{math}
:label: eq-r4-identity-replay-tuple
\mathcal R=\left(D_{\mathrm{eq\text{-}mat}},D_{\mathrm{stat}},D_{\mathrm{bnd}},D_{\mathrm{raw,producer}},D_{\mathrm{raw,consumer}}\right).
```

Walidacja typów poprzedza hashowanie. Oryginalna kolejność pól, spacje,
końce linii i leksykalna postać liczb pozostają częścią $p$.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $N$ | namespace ramki digestu preimage'u fizycznego | $1$ |
| $p$ | exact UTF-8 bytes preimage'u | $1$ |
| $|p|$ | liczba bajtów preimage'u | $1$ |
| $D_N$ | framed SHA-256 preimage'u fizycznego | $1$ |
| $D_{\mathrm{raw}}$ | surowy SHA-256 `MaterialIR` | $1$ |
| $\mathcal R$ | pięcioelementowy wynik replay | $1$ |
| $D_{\mathrm{eq\text{-}mat}}$ | canonicalny digest materiału równowagi | $1$ |
| $D_{\mathrm{stat}}$ | digest statyki fizycznej | $1$ |
| $D_{\mathrm{bnd}}$ | digest boundary i metadanych periodycznych | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | stała anizotropii jednoosiowej | $\mathrm{J\,m^{-3}}$ |
| $\mathbf u$ | kanoniczna oś jednoosiowa | $1$ |
| $\mathbf H_{\mathrm{ext}}$ | pole zewnętrzne | $\mathrm{A\,m^{-1}}$ |
| $\alpha$ | damping w raw `MaterialIR` planu | $1$ |
| $\mathbf k$ | wektor falowy próbki modalnej | $\mathrm{rad\,m^{-1}}$ |

(assumptions-and-validity)=
## 4. Zakres i założenia

Material V1 wymaga skończonych $M_s>0$ i $A_{\mathrm{ex}}\geq0$ oraz
opcjonalnych skończonych pól materiałowych. Material V2 jest wariantem
constant-Ku: pole $M_s$ musi być `null`, $K_u$ musi być skończone (jawne
$K_u=0$ pozostaje V2), a oś musi być skończona, jednostkowa z tolerancją
$10^{-12}$ i kanonicznie zorientowana. Ujemne zero jest odrzucane.

Static physics wymaga dokładnie `schema_version`, dwóch wartości bool i
opcjonalnego trójskładnikowego pola. Boundary ma dokładnie sześć pól; zagnieżdżone
`AirBoxConfigIR` i pary periodyczne zachowują zgodność z typami Rust, a ich
nieznane pola są tolerowane, bo te struktury nie mają `deny_unknown_fields`.
W producerowym JSON nazwa pola tolerancji jest kanonicznie `tolerance`;
serde'owy alias wejściowy `tolerance_m` nie jest formatem serializowanym przez
producer i jest odrzucany przez replay.

Raw `MaterialIR` jest walidowany w kształcie generowanym przez producerowy
`serde_json::to_vec`: pola bez `skip_serializing_if` (`uniaxial_anisotropy` i
`anisotropy_axis`) muszą wystąpić, także jako `null`. Pozostałe opcjonalne
pola mogą być nieobecne. Replay sprawdza tutaj tylko kształt, typy i
skończoność liczb; nie nakłada dodatniości, obsługiwanej rodziny materiału
ani normalizacji osi wymaganej przez planner IR. Damping należy wyłącznie do
raw provenance; nie jest porównywany z fizycznym
`equilibrium_material_signature`.

Powyższa walidacja jest kontraktem replay preimage'ów. Nie sprawdza jeszcze
mesh, $\mathbf m_0$, source snapshotu, `linearization_state`, operatora,
residualu, gałęzi modowej ani wykonania managed runtime.

(python-api)=
## 5. Python API verifiera

To jest wewnętrzny moduł weryfikacyjny, a nie nowy konstruktor publicznego
Python DSL. Główne funkcje to:

| Funkcja | Wejście | Wynik |
|---|---|---|
| `framed_digest` | namespace i dokładne `bytes` | `sha256:<64 lowercase hex>` |
| `raw_material_digest` | dokładne `bytes` `MaterialIR` | `sha256:<64 lowercase hex>` |
| `replay_preimage_json` | tekst preimage'u, oczekiwany digest, rodzina | zweryfikowany digest albo wyjątek |
| `replay_equilibrium_identity_preimages` | dokładne bajty identity v2 | mapa pięciu pól signature albo wyjątek |

Minimalny przykład kontraktowy jest wykonywalny bez solvera:

```python
# %%
from scripts.fem_equilibrium_identity_replay import (
    framed_digest,
    replay_preimage_json,
)

# %%
preimage = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null}'
)
expected = framed_digest(
    "EquilibriumMaterialSignaturePreimage.v1", preimage.encode("utf-8")
)
assert replay_preimage_json(preimage, expected, "equilibrium_material") == expected
```

(problem-ir)=
## 6. ProblemIR i provenance

Replay nie zmienia `MaterialIR`, `FemPlanIR`, `FemEigenPlanIR` ani `KSamplingIR`.
Pola `requested device`, `precision`, `damping`, demag, boundary i ścieżka
$\mathbf k$ pozostają częścią planu i jego provenance. Helper odczytuje tylko
preimage'y już zapisane przez runner; nie tworzy planu i nie zamienia
`auto`/GPU na CPU.

Raw producer i raw consumer są rozdzielone, aby zmiana damping planu relaksacji
nie była mylona ze zmianą fizycznej tożsamości statycznej. Wykonanie replay
nie jest round-tripem Python → IR i nie zmienia publicznego API.

(round-trip-and-failure-semantics)=
## 7. Round-trip i fail-closed

1. Main verifier najpierw sprawdza pełny 52-polowy rekord identity, jego własny
   exact preimage i `content_sha256`.
2. Odczytaj exact bytes pięciu preimage'ów identity.
3. Sprawdź UTF-8, JSON object, duplikaty kluczy, skończoność liczb i limity
   zagnieżdżenia.
4. Dla każdego z pięciu pól zweryfikuj rodzinę, schemat, typy i wartości.
5. Policz digest z tych samych bytes, bez serializacji wtórnej.
6. Odrzuć brak pary preimage/signature, zły digest, mieszanie V1/V2, bool
   udający liczbę, niepoprawny kształt lub nieskończony damping, pole albo
   boundary.

Nieznany lub zniekształcony preimage zwraca `EquilibriumIdentityReplayError`.
Brak dowodu pozostaje `NOT VERIFIED`; wynik `PASS` tego helpera nie oznacza
kwalifikacji solvera ani zgodności z COMSOL/TetraX.

W tym wewnętrznym przepływie `requested intent` pozostaje zapisany w planie,
`resolved execution` pozostaje zapisane w provenance, a `validation errors`
i `unsupported combinations` kończą replay błędem zamiast cichego fallbacku.
Sam helper nie zastępuje pełnego 52-polowego sprawdzenia; jest wywoływany po
tej bramce przez main verifier.

(discrete-realization)=
## 8. Realizacja backendów

| Solver | Urządzenie | Stan | Zakres |
|---|---|---|---|
| FEM | CPU | source-visible / interpreted contract | bieżący producent i konsument identity |
| FEM | GPU | unsupported for this increment | brak dowodu wykonania GPU; brak cichego fallbacku |
| FDM | CPU | not applicable | identity dotyczy artefaktów FEM |
| FDM | GPU | not applicable | identity dotyczy artefaktów FEM |

Helper jest niezależnym parserem Python. Nie wykonuje native builda, nie
uruchamia SLEPc/MFEM i nie mierzy częstotliwości.

(implementation-mapping)=
## 9. Mapowanie implementacji

| Element | Ścieżka + symbol | Odpowiedzialność |
|---|---|---|
| physical preimages | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `signature_digest_and_preimage` | namespace, NUL, LE64 i producer JSON |
| material replay | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `equilibrium_material_signature_digest_from_preimage` | V1/V2, Ku=0 i canonical axis |
| raw digest | `crates/fullmag-runner/src/fem/eigen_digest.rs` + `shared_domain_content_digest` | SHA-256 exact `MaterialIR` bytes |
| raw producers | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `raw_material_provenance` | producer/consumer raw plan provenance |
| typed identity | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `LinearizationIdentityV2` | pięć pól i sample identity |
| independent helper | `scripts/fem_equilibrium_identity_replay.py` + `replay_equilibrium_identity_preimages` | Python replay bez reserializacji |
| main integration | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_r4_signed_sidecars` | pełny own identity check przed pięcioma replayami |
| regression suite | `scripts/test_fem_equilibrium_identity_replay.py` + `class EquilibriumIdentityReplayTests` | golden digests, airbox/PBC i mutacje fail-closed |

(validation)=
## 10. Walidacja

| Kontrola | Wynik | Znaczenie |
|---|---|---|
| `python -m unittest scripts/test_fem_equilibrium_identity_replay.py` | PASS, 10 testów | fixture replay, Ku V1/V2/0, raw shape/finite, airbox/PBC i mutacje |
| `python scripts/test_equilibrium_material_preimage_replay.py` | PASS | zgodność historycznych golden digestów V1/V2 |
| main verifier integration | PASS, 57 interpreted tests (root evidence) | pełny 52-polowy own identity check poprzedza pięć replayów; digest status jest propagowany |
| native unit compilation | NOT VERIFIED | obowiązująca polityka nie uruchamia kompilacji testów |
| managed FEM runtime | NOT VERIFIED | brak terminalnego receiptu tego helpera |
| modal residual/branch | NOT VERIFIED | replay nie jest solverem eigen |
| COMSOL/TetraX parity | NOT VERIFIED | wymaga wspólnego runtime, siatki i danych referencyjnych |

Testy obejmują złe schematy, pola, duplikaty, whitespace, bool zamiast liczby,
NaN, leksykalne `-0`, niepoprawną oś, pełny boundary z airboxem i PBC oraz
brak producerowych kluczy `MaterialIR`. Raw replay nie ocenia dodatniości
parametrów ani rodziny IR; to pozostaje walidacją producer/planner. Nie
uruchamiano kompilacji native ani managed runnera.

(limitations)=
## 11. Ograniczenia

- Helper nie jest pełnym walidatorem identity: wymaga tylko znacznika schematu
  i pięciu par preimage/signature. Main verifier musi wcześniej wykonać pełny
  52-polowy check, własny exact-preimage sidecar i `content_sha256`.
- Nie weryfikuje `modal_operator_signature` ani `modal_dynamic_boundary`.
- Nie sprawdza m0, mesh/topology, source/build identity, accepted/certified
  fields, `linearization_state` ani residualu.
- Nie rozstrzyga, czy damping jest właściwy dla obliczeń modalnych; rozróżnia
  tylko raw provenance od statycznego material identity.
- Fixture testowy nie jest wynikiem managed runtime i nie zastępuje
  porównania analitycznego, COMSOL ani TetraX.

(scientific-bibliography)=
## 12. Bibliografia i kontrakty

- NIST, Secure Hash Standard (SHS), FIPS 180-4,
  https://doi.org/10.6028/NIST.FIPS.180-4.
- Fullmag, `docs/physics/0840-equilibrium-material-preimage-replay.md`,
  kontrakt materiału V1/V2 i jawnego $K_u=0$.
- Fullmag, `docs/physics/r4-linearization-identity-v2.md`,
  provenance identity, damping i granice kwalifikacji.
- Fullmag, `crates/fullmag-runner/src/fem/equilibrium_identity.rs`,
  implementacja producerowego framingu i walidacji fizycznej.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie | Path + symbol | Lane | Dowód |
|---|---|---|---|
| framed digest | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `signature_digest_and_preimage` | FEM CPU | source-visible; fixture PASS |
| V1/V2/Ku=0 validation | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` + `validate_material_preimage_v2` | FEM CPU | source-visible; interpreted PASS |
| raw material SHA | `crates/fullmag-runner/src/fem/eigen_digest.rs` + `shared_domain_content_digest` | FEM CPU | source-visible; fixture PASS |
| five identity fields | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `LinearizationIdentityV2` | FEM CPU | source-visible |
| producer raw provenance | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `raw_material_provenance_from_eigen_plan` | FEM CPU | source-visible |
| independent replay | `scripts/fem_equilibrium_identity_replay.py` + `replay_preimage_json` | verifier | 10 interpreted tests PASS |
| main full identity gate | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` + `validate_r4_signed_sidecars` | verifier | 57 interpreted tests PASS; full 52-field check precedes helper |
| mutation coverage | `scripts/test_fem_equilibrium_identity_replay.py` + `class EquilibriumIdentityReplayTests` | verifier | 10 interpreted tests PASS |

Obecność helpera i zielone testy kontraktowe nie promują statusu do runtime
qualification. Do tego potrzebne są exact artefakty managed runnera, native
residualy, zbieżność i osobna walidacja fizyczna.
