# Przyrost 44 — opis pola i wycinek z przypiętego tensora

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i kontrakty: `aea6f1923178df6613c630250c976d127726d399`, opublikowany na remote master.

## Wynik

`TensorDescriptor` otrzymuje opcjonalny, strict `TensorFieldBinding`.
Dokładny root CAS obejmuje opis semantyczny i tożsamość
dataset/sample/item/field, grupę, producenta oraz rolę płaszczyzny.
Nie powstają dodatkowe krawędzie CAS ani magazyn Results. Rooty bez bindingu
zachowują istniejącą serializację i odczyt; nowy adapter pola odmawia
odgadywania ich semantyki.

`read_pinned_solution_field_slice` łączy istniejący resolver właściciela
z bounded adapterem wycinków. Caller podaje request i dokładne źródła,
a opis pola pochodzi wyłącznie z rootu. Para real/imag wymaga tej samej
rewizji/membera/RunSpec, różnych rootów i artefaktów, zgodnego accepted state,
identycznej grupy/producenta/opisu pola i layoutu. Request musi odpowiadać
dataset/sample/item/field z bindingu. Wynik zachowuje oryginalne statusy
wykonania oraz ocenę naukową każdego właściciela.

Wspólny `DatasetFieldDescriptor::validate` deleguje do istniejącego walidatora.
Binding wymaga dokładnych osi/długości, F32/F64 little endian oraz
element-major skalaru albo wektora. Nie wykonuje projekcji ani normalizacji.
Publikacja, recovery, GC i FMS dla typed SolutionSet stosują tę walidację
przez istniejący parser rootu. Walidator descriptorów checkpointów także
sprawdza binding; historyczny budżet odczytu checkpointów nie jest tutaj
kwalifikowany jako bounded typed-SolutionSet route.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| Produkcyjne źródła API/session/quantities | PASS, exit 0, `source_changed_during_run=false` |
| Fingerprint końcowego modułu względem receipt | PASS |
| Scoped rustfmt parser/check i staged diff | PASS |
| Niezależny bounded source review | PASS dla readera; warunek producenta pozostaje otwarty |

Receipt końcowych źródeł:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/8bb805bd32a243e18df3de49a1da6c51/receipt.json`.
Pierwszy receipt `3e7cb641dcb64218bb798a02363ef78c` przeszedł dla wersji
sprzed poprawki typów w source-only regresji; końcowy receipt odpowiada
bieżącemu modułowi. Kontrola produkcyjna nie kompiluje tych regresji.

Review nie wskazał blokera bieżącego readera. Wskazał P1 jako warunek
następnego etapu: producent FEM H1 P1 musi jawnie emitować pełne osie
`[element, component]` i dowodzić element-major ordering. Istniejący
ogólny DatasetFieldDescriptor dopuszcza także descriptor bez osi albo
z samą osią component; nowy binding celowo nie przyjmuje takich danych.

Regresje źródłowe pozostają **NOT COMPILED / NOT RUN** zgodnie z zakazem
kompilacji testów jednostkowych. Runtime, FMS round-trip, RAM, science
i release pozostają **NOT VERIFIED**.

## Granice i następny etap

To jest przypięty field-owner reader, a nie pełny MaterializedDataset.
Żaden istniejący writer nie emituje jeszcze bindingu. CAS integrity oraz
identyfikator producenta nie dowodzą fizycznej prawdziwości metadanych.
Starszy strict reader odrzuca nowe rooty z bindingiem; reader musi zostać
wdrożony przed włączeniem writera. Nie dopisuje się metadanych do zamkniętej
rewizji ani nie modyfikuje istniejących rootów.

Audyt producentów wskazał pierwszy planowany vertical slice: zapisane
magnetization state `m` w FEM H1 P1, z jawnym wersjonowanym envelope
semantycznym producenta. Obecny codec `fullmag.runner.field_json@v1`
nie zawiera kompletnego `DatasetFieldDescriptor`; planowane rozszerzenie
codec v2 wymaga walidacji producer → application → runtime-control,
binarnych tensorów i publikacji przed terminal close. Nie uznaje się v1
za gotowe pole ilościowe na podstawie samych jednostek i topologii.

Dalej pozostają trwały manifest datasetu, publikacja signed-difference,
API/generated client i consumer istniejącego UI oraz bramki runtime/P7/P8.

Kontrakty: [przypięty tensor](../../../../../specs/pinned-solution-tensor-v1.md)
i [ADR 0029](../../../../../adr/0029-analysis-result-dataset-and-slice-selection.md).

Aktualizacja po przyroście 45: zgodne rozszerzenie `layout.field_semantics`
w codec v1 zastąpiło planowany codec v2. Producent i zapis tensoru zostały
podłączone w [checkpointcie 45](45-recorded-fem-state-tensor-materializer.md);
powyższy opis braku writerów przedstawia stan przyrostu 44.
