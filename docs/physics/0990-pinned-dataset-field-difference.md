# Różnica dwóch przypiętych wycinków pola

(problem-statement)=
## Problem i zakres

Analiza historyczna porównuje zapisane wartości tej samej wielkości i przestrzeni.
Nie uruchamia solvera ani nie zastępuje brakujących próbek zerem. Właścicielem
numerycznym jest `fullmag-quantities`; session dostarcza zweryfikowane zakresy CAS.

(governing-equations)=
## Równania

```{math}
:label: eq-pinned-field-difference
d_{p,i}=\operatorname{fl}_{b}(a_{p,i}-c_{p,i})
```

Operator odejmuje lewy operand minus prawy, osobno dla każdej płaszczyzny.
Nie oblicza modułu, normy, względnego błędu ani renormalizacji. Odejmowanie
odbywa się w precyzji wejścia; przepełnienie do wartości niefinitywnej jest błędem.

(symbols-and-si-units)=
## Symbole i jednostki SI

Tabela dotyczy przykładu magnetyzacji znormalizowanej, o jednostce $1$.
Dla innych wielkości operator zachowuje dokładne metadane jednostki obu
zgodnych descriptorów; nie przelicza jednostek i nie nadaje im nowych wymiarów.

| Token | Znaczenie | Jednostka |
|---|---|---|
| $a_{p,i}$ | Wartość lewego zapisanego pola | $1$ |
| $c_{p,i}$ | Wartość prawego zapisanego pola | $1$ |
| $d_{p,i}$ | Różnica wartości w tej samej jednostce | $1$ |
| $p$ | Płaszczyzna values albo real/imaginary | $1$ |
| $i$ | Spłaszczony indeks skalarny: element i komponent wycinka w tym samym layout | $1$ |
| $b$ | Precyzja F32 lub F64 | $1$ |
| $\operatorname{fl}_{b}$ | Arytmetyka zmiennoprzecinkowa w zadanej precyzji | $1$ |

(assumptions-and-validity)=
## Założenia i granice

Wymagane są ready oraz quantitative, identyczne jednostki, frame, support,
sample location, axes, encoding, harmonic convention, modal semantics i layout.
Oba manifesty muszą odpowiadać pinned requestom i oczekiwanym digestom.
Opis pola jest osobno przypięty digestem. Zakres, całkowita liczba elementów,
liczba komponentów i precyzja muszą być identyczne. Sample/item IDs różnych
datasetów nie muszą mieć tej samej nazwy; ich wybór jest jawny w receipcie.
Zgodny layout nie dowodzi fizycznej zgodności dwóch eksperymentów.

Niezgodne przestrzenie wymagają faktycznie wykonanego projected payload.
Ten evaluator odmawia takiego porównania; sam receipt projekcji nie zmienia liczb.
Różnica wektorów jednostkowych nie jest wektorem jednostkowym. Wynik nie jest
automatycznie nowym polem wejściowym ani materializowanym datasetem.

(python-api)=
## Publiczny Python

Nie dodaje się publicznego konstruktora ani przykładu symulacji. Brak publicznego
wywołania tej analizy jest jawną otwartą integracją. Nie ma parametrów Python,
domyślnych ustawień solvera ani nowego lowering. Wewnętrzny request wymaga obu
pinned slice requests, SHA manifestu i descriptoru, budżetu wyniku i budżetu
żywych payloadów; wszystkie są obowiązkowe, bez domyślnego fallbacku.

Poniższy samodzielny przykład to referencja arytmetyczna w standardowym Python,
bez Fullmag API i bez solve. Nie jest dowodem wykonania Rust evaluatora.

```python
# %% Jawne zapisane wartości referencyjne (jednostka 1)
left = [1.0, -2.0]
right = [0.5, 3.0]
# %% Signed difference; brak normy i normalizacji
difference = [a - c for a, c in zip(left, right)]
assert difference == [0.5, -5.0]
```

(problem-ir)=
## ProblemIR i planner

Brak zmiany ProblemIR, Python→IR ani capability solverów. Dane wynikowe nie
stają się wejściem solvera. Requested/resolved/executed pozostają w źródłach;
analiza zachowuje obie tożsamości zamiast wybierać bieżącą sesję.
Requested intent oraz resolved execution pozostają niezmienione.
Validation errors są odmową obliczenia. Unsupported combinations obejmują różne layouty,
jednostki, precyzje i brakujące dane; żadna z nich nie uruchamia nowego solve.

(round-trip-and-failure-semantics)=
## Identity i odmowy

Checksum obejmuje dokładne zakresy odczytu. Manifest oraz descriptor mają
osobne hashe typowanego JSON. Brak danych, corrupt, stale revision, checksum
mismatch, preview, inne units/layout/precision/range i wynik infinity/NaN
przerywają obliczenie. Nie publikuje się częściowej różnicy ani wyniku zerowego.
Output zawiera little-endian bytes, plane hashes i receipt obu źródeł.
`output_semantics=unnormalized_signed_difference` jawnie odróżnia wynik od
normalizacji wejścia. `input_descriptor` opisuje wyłącznie operand.
Digest jest `sha256:<64 lowercase hex>` z compact JSON `serde_json::to_writer` typowanej
struktury w wersji kontraktu 1.0.0, z kolejnością pól tej struktury.
Nie jest hashem oryginalnej whitespace reprezentacji ani RFC 8785.
Serializacja jest streamowana do hashera z limitem 4 MiB per manifest/descriptor,
bez pełnej kopii JSON. Tensor porównania ma najwyżej 16384 chunks per plane.
Limit chunków dotyczy wejścia porównania; samodzielny istniejący reader ma
odrębny, nadal otwarty limit metadanych. Hashowanie TensorDescriptor w adapterze
sprawdza tylko budżet serializacji, bez oczekiwanego digestu tego descriptoru.
Przypięte hashe dotyczą DatasetFieldDescriptor i zwróconego manifestu slice.
Caller musi rozwiązać powiązanie dataset→tensor przez zaufanego właściciela;
materializer/API realizujący tę granicę nie jest jeszcze zaimplementowany.

(discrete-realization)=
## Realizacje

| Solver | Device | Wsparcie i kwalifikacja |
|---|---|---|
| FDM | CPU | Nie dotyczy wykonania solvera; CPU post-processing zapisanych danych, runtime unqualified |
| FDM | GPU | Nie dotyczy wykonania GPU; CPU post-processing zapisanych danych, brak dowodu lane |
| FEM | CPU | Nie dotyczy wykonania solvera; CPU post-processing zgodnego layout, runtime unqualified |
| FEM | GPU | Nie dotyczy wykonania GPU; CPU post-processing zapisanych danych, brak dowodu lane |

Nie ma materialnej różnicy operatora między lane'ami: są to dane już zapisane.
Device analizy jest CPU i nie zastępuje requested GPU solvera. F32/F64 i real/imag
pozostają rozdzielone; nie konwertuje się harmonic convention ani fazy.
Adapter tensorów wymaga element-major row layout `[elements, components]`
z osią komponentów na końcu albo scalar `[elements]`. Osi i shape obu operandów
oraz wszystkich planes muszą być identyczne. Component-major wymaga jawnej
transformacji, ponieważ istniejący range reader indeksuje ciągłe elementy.

(implementation-mapping)=
## Mapa implementacji

- Równanie: `crates/fullmag-quantities/src/dataset_difference.rs` + `compare_dataset_field_slices`.
- Przypięcie/budżety: ten sam plik + `DatasetDifferenceRequest::validate`.
- Ready/quantitative: ten sam plik + `validate_dataset_difference_sources`.
- Typed JSON/digest: ten sam plik + `dataset_comparison_digest`.
- Semantyka: `crates/fullmag-quantities/src/dataset.rs` + `validate_field_compatibility`.
- Odczyt/identity/checksum: `crates/fullmag-quantities/src/dataset_slice.rs` + `DatasetFieldSlice::decode_part_bytes`.
- CAS: `crates/fullmag-session/src/dataset_slice_adapter.rs` + `compare_tensor_dataset_slices`.

(validation)=
## Bramki walidacji

Regresje: signed difference, complex F32, stale revision/digest, corrupt bytes,
jednostki/layout/preview/unavailable, budget i overflow. Testy Rust pozostają
NOT COMPILED / NOT RUN podczas zakazu kompilacji jednostkowej. Kontrola źródeł
oraz dokumentacji nie zastępuje wykonanych regresji, managed runtime ani RAM.

(limitations)=
## Ograniczenia i dalsza praca

Budżet liczy live payload bytes: dwa inputy, dwa decoded inputy i output.
Nie jest pomiarem RSS; nie obejmuje metadata, allocator overhead ani obcych
kopii callera. Przed odczytem CAS używa konserwatywnych maksymalnych budżetów
requestów. Output nie ma publikacji CAS/dataset, API ani consumer UI. Projekcja,
materializer, plot/export recipes i pomiary dużych danych pozostają wymagane.

(scientific-bibliography)=
## Bibliografia

David Goldberg, *What Every Computer Scientist Should Know About Floating-Point
Arithmetic*, ACM Computing Surveys 23(1), 1991, DOI `10.1145/103162.103163`;
[reprint w Numerical Computation Guide](https://docs.oracle.com/cd/E19957-01/802-5692/802-5692.pdf).
Źródło opisuje rounding i cancellation; nie stanowi dowodu runtime Fullmag.

(source-code-index)=
## Indeks kodu i dowodów

| ID | Path + symbol | Odpowiedzialność | Lane / dowód |
|---|---|---|---|
| difference | `crates/fullmag-quantities/src/dataset_difference.rs` + `compare_dataset_field_slices` | Odejmowanie i receipt | CPU analysis, runtime unqualified |
| budget | `crates/fullmag-quantities/src/dataset_difference.rs` + `DatasetDifferenceRequest` | Pinned sources i limity | Wszystkie zapisane lane, source only |
| source-status | `crates/fullmag-quantities/src/dataset_difference.rs` + `validate_dataset_difference_sources` | Ready/quantitative i digest descriptoru | CPU analysis, regresje NOT RUN |
| metadata-digest | `crates/fullmag-quantities/src/dataset_difference.rs` + `dataset_comparison_digest` | Streamowany typed JSON, SHA i limit | CPU analysis, source only |
| compatibility | `crates/fullmag-quantities/src/dataset.rs` + `validate_field_compatibility` | Odmowa niezgodnej semantyki | Wszystkie lane, regresje NOT RUN |
| decode | `crates/fullmag-quantities/src/dataset_slice.rs` + `decode_part_bytes` | Checksum i finite decode | F32/F64, regresje NOT RUN |
| cas | `crates/fullmag-session/src/dataset_slice_adapter.rs` + `compare_tensor_dataset_slices` | Rzeczywisty odczyt tensorów | CPU analysis, runtime NOT VERIFIED |

Źródła przypięto do commita `1cd01d25f34c689219b084c91c965e7c48d06efb`:

- [difference](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset_difference.rs#L184) — `compare_dataset_field_slices`.
- [budget](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset_difference.rs#L29) — `DatasetDifferenceRequest`.
- [compatibility](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset.rs#L790) — `validate_field_compatibility`.
- [decode](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset_slice.rs#L270) — `decode_part_bytes`.
- [cas](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-session/src/dataset_slice_adapter.rs#L57) — `compare_tensor_dataset_slices`.
- [source-status](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset_difference.rs#L262) — `validate_dataset_difference_sources`.
- [metadata-digest](https://github.com/MateuszZelent/fullmag/blob/1cd01d25f34c689219b084c91c965e7c48d06efb/crates/fullmag-quantities/src/dataset_difference.rs#L144) — `dataset_comparison_digest`.
