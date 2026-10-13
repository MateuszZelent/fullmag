# Replay tożsamości materiału równowagi FEM

- Status: `source_visible / runtime_unvalidated`
- Właściciel: Fullmag FEM frequency-domain backend
- Data: 2026-10-01
- Zakres: ścisła walidacja i odtworzenie digestu preimage materiału
- Powiązane kontrakty: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`, `docs/physics/r4-accepted-field-replay.md`

(problem-statement)=
## 1. Domena fizyczna i cel

Tożsamość materiału jest częścią pochodzenia równowagi, z której budowany jest
operator modalny FEM. Ten kontrakt nie oblicza pola ani częstotliwości. Chroni
jedynie granicę, na której producent publikuje kompaktowy JSON materiału, a
konsument sprawdza, że podpis odnosi się do dokładnych bajtów tego JSON-u.

Wersja V1 opisuje materiał bez stałego pierwszego rzędu Ku. Wersja V2 opisuje
stałe Ku, jego kanoniczną oś oraz także przypadek jawnie zadany $K_u=0$.
Obecność pola Ku wybiera V2; wartość równa zero nie może zniknąć w migracji do
V1.

(governing-equations)=
## 2. Równanie digestu

Dla namespace `N` i opublikowanych bajtów UTF-8 preimage `p` konsument stosuje
to samo ramkowanie co producent:

```{math}
:label: eq-material-preimage-digest
D = \operatorname{SHA256}\!\left(N\;\Vert\;\mathtt{0x00}\;\Vert\;
\operatorname{LE}_{64}(|p|)\;\Vert\;p\right).
```

Konsument najpierw dekoduje payload do typu ścisłego, wybiera namespace z
`schema_version` i sprawdza wielkości fizyczne. Hashuje potem `p.as_bytes()`;
nie serializuje obiektu ponownie. Zmiana białych znaków albo leksykalnej
postaci liczby zmienia digest.

Kanoniczna oś V2 jest jednostkowa, ma pierwszy niezerowy składnik dodatni i
nie zawiera ujemnego zera. Oś przeciwną fizycznie identyfikuje producent przez
jedną reprezentację przed publikacją.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `N` | wersjonowany namespace ramki digestu | $1$ |
| `p` | dokładne bajty UTF-8 JSON preimage | $1$ |
| $\lvert p\rvert$ | długość preimage przekazana jako unsigned little-endian | $1$ |
| `D` | digest SHA-256 tożsamości materiału | $1$ |
| $M_s$ | jednorodne nasycenie magnetyczne | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | stała sztywności wymiany | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | stała pierwszego rzędu anizotropii jednoosiowej | $\mathrm{J\,m^{-3}}$ |
| $\mathbf u$ | kanoniczna oś jednoosiowa | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- V1 wymaga dokładnie własnych pól V1 i nie przyjmuje pól Ku ani osi.
- V2 wymaga stałego, skończonego Ku oraz osi $\mathbf u$ o normie jeden;
  jawne $K_u=0$ pozostaje V2.
- $M_s$ musi być skończone i dodatnie, a $A_{\mathrm{ex}}$ skończone i
  nieujemne. Opcjonalne pola materiałowe przechodzą tę samą kontrolę wartości;
  V2 odrzuca nawet pusty `saturation_magnetisation_field_a_per_m`, ponieważ
  stałe Ku wymaga jednorodnego $M_s$.
- Nieznane, brakujące, powtórzone lub mieszane pola są błędem deserializacji.
  Walidacja digestu nie ustala jeszcze długości pola względem konkretnej
  siatki; robi to późniejszy binder stanu równowagi.
- Ten kontrakt nie dowodzi zbieżności relaksacji, poprawności demaga, warunku
  Floqueta ani zgodności z COMSOL-em lub TetraX.

(python-api)=
## 5. Python API

Zmiana nie dodaje publicznego konstruktora ani parametru Python. Python tworzy
`ProblemIR`, a tożsamość materiału powstaje dopiero na granicy runnera. Poniższy
fragment jest niezależnym od solvera odczytem i testem ramki opublikowanego
preimage; nie uruchamia symulacji.

```python
# %%
from hashlib import sha256
from struct import pack

# %%
namespace = "EquilibriumMaterialSignaturePreimage.v1"
preimage = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null}'
)
payload = preimage.encode("utf-8")
digest = sha256(namespace.encode("utf-8") + b"\0" + pack("<Q", len(payload)) + payload)
assert digest.hexdigest() == "5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af"
```

(problem-ir)=
## 6. ProblemIR i normalizacja

Nie zmienia się `ProblemIR`, jego jednostek ani obiektów sceny. Pole
`MaterialIR.uniaxial_anisotropy` pozostaje rozróżnieniem obecności V2; wartość
zero jest informacją autora, a nie brakiem interakcji. Producer zapisuje
istniejące pola V1, a dla V2 dopisuje Ku i kanoniczną oś w tym samym JSON-ie.
Żadna normalizacja po stronie konsumenta nie może przepisać preimage przed
hashowaniem.

(round-trip-and-failure-semantics)=
## 7. Round-trip, intent i błędy

Żądany `requested intent` użytkownika i `resolved execution` pozostają w istniejącym
provenance planu FEM. Ten przyrost dodaje tylko kontrolę artefaktu pomiędzy
producerem równowagi i konsumentem modalnym. Wymagane są: zgodny namespace,
ścisły typ, skończone wartości, dopuszczalna domena fizyczna, kanoniczna oś i
zgodny digest. `validation errors` obejmują nieznany schema, dodatkowe pole,
pole powtórzone, V1 z polami V2, niekanoniczną oś lub digest po zmianie bajtów
i kończą się `RunError`. `unsupported combinations` i nieznany schema są
odrzucane; konsument nie wykonuje fallbacku V2 do V1.

(discrete-realization)=
## 8. Realizacja dyskretna i backendy

### FEM CPU

Rust runner przechowuje historyczny producer V1/V2, a pomocnik replay używa
typed deserialization i dokładnych bajtów preimage. Managed CPU i natywne testy
nie zostały wykonane w tym przyroście.

### FEM GPU

Tożsamość materiału jest wspólnym artefaktem wejściowym i nie twierdzi nic o
rezydencji GPU, bibliotece ani parytecie. Dowód GPU wymaga osobnego runtime
receipt i pozostaje niezweryfikowany.

### FDM CPU i FDM GPU

Te lane'y nie konsumują FEM equilibrium material preimage. Ich status nie jest
zmieniany przez ten kontrakt.

(implementation-mapping)=
## 9. Mapowanie implementacji

Producer zachowuje `signature_digest_and_preimage`, w tym nazwy namespace i
historyczne bajty V1. `replay_equilibrium_material_signature` rozpoznaje
`schema_version`, wybiera V1 albo jawny decoder V2 i deleguje kontrolę wartości
do walidatorów. Dopiero po niej wykonuje ramkowanie z równania
`eq-material-preimage-digest` z `preimage_json.as_bytes()`.

Wersja V2 ma osobny replay decoder, ponieważ producerowy `flatten` służy
zachowaniu kolejności serializacji, natomiast ścisłe odrzucanie nieznanych pól
powinno być jawne dla całej mapy JSON.

(validation)=
## 10. Walidacja

Niezależny skrypt `scripts/test_equilibrium_material_preimage_replay.py`
sprawdza znane digesty V1 i V2, jawne Ku=0, długość little-endian, zmianę
białych znaków i zapisu liczby, pola nieznane/powtórzone, mieszany schema,
wartości niedopuszczalne oraz orientację osi. Kontrola źródła potwierdza, że
ścieżka replay nie używa ponownej serializacji.

Regresje Rust w `equilibrium_identity.rs` są przygotowane dla V1, V2, Ku=0,
whitespace, mixed schema, unknown fields i mutacji wartości. Nie kompilowano
ani nie uruchamiano testów natywnych, zgodnie z bieżącym zakazem worktree.
Managed runtime, binder siatki i kwalifikacja naukowa pozostają
`NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia i prace odroczone

- [x] Zachowanie istniejącego namespace i digestu V1.
- [x] Rozróżnienie V1/V2 oraz jawnego Ku=0.
- [x] Ścisłe typy, wartości fizyczne, unknown/duplicate fields i kanoniczna oś.
- [x] Niezależny interpreted replay check.
- [ ] Podłączenie helpera do pełnego binderu handoffu R4.
- [ ] Długość pól względem siatki i pełny accepted/recomputed replay.
- [ ] Managed FEM CPU/GPU receipt, zbieżność i porównanie COMSOL/TetraX.

(scientific-bibliography)=
## 12. Bibliografia

- NIST, *Secure Hash Standard (SHS)*, FIPS 180-4, DOI:
  [10.6028/NIST.FIPS.180-4](https://doi.org/10.6028/NIST.FIPS.180-4).
- Fullmag, `0831-fem-dynamic-pencil-modal-response-and-krylov.md`, bieżąca
  definicja tożsamości materiału modalnego i granic kwalifikacji.
- Fullmag, `r4-accepted-field-replay.md`, kontrakt accepted/recomputed state.

(source-code-index)=
## 13. Indeks źródeł

| Twierdzenie lub równanie | Ścieżka | Symbol | Odpowiedzialność | Dowód |
|---|---|---|---|---|
| Ramka digestu | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `equilibrium_material_signature_digest_from_preimage` | Hashowanie exact UTF-8 bytes po walidacji | source + interpreted |
| Publiczny punkt replay | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `replay_equilibrium_material_signature` | Porównanie obliczonego digestu z oczekiwanym | source |
| V1 schema | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `EquilibriumMaterialSignaturePreimageV1` | Historyczny Ku-free payload i strict fields | source + golden |
| V2 schema | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `EquilibriumMaterialSignatureReplayV2` | Jawne pola Ku i osi z deny-unknown-fields | source |
| Walidacja V2 | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `validate_material_preimage_v2` | Ku=0, uniform Ms i canonical axis | source |
| Regresje Rust | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `replay_accepts_published_v1_and_v2_including_explicit_zero_ku` | Przygotowane przypadki V1/V2/Ku=0 | prepared, native NOT VERIFIED |
| Regresja niezależna | `scripts/test_equilibrium_material_preimage_replay.py` | `main` | Oracle framingu i mutacji | PASS interpreted |

Źródło i testy natywne są przygotowane. Brak wykonania managed/native nie jest
promowany do dowodu solvera ani zgodności naukowej.
