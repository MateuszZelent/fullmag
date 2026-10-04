# P6-49 — przypięty zasób MaterializedDataset

Data: 01.10.2026. Status: **przyrost źródłowy opublikowany; P6 IN PROGRESS, 52%**.
Cel P0–P8 pozostaje aktywny.
Kod: `9555a55388980a439363979d2269899c5e716fae`, remote master.
Baza: `40ff360fa8945cc58bcd510b2aa3ede77cb69c2f`.

## Zakres

Wspólny reader magazynu odczytuje jeden wybrany manifest z dokładnej rewizji
SolutionSet. Weryfikuje accepted-submit provenance z bounded RunIntent,
następnie manifest CAS, containing member i dokładnego bieżącego lub
historycznego ownera, a dopiero potem tensor oraz chunky. Błędny owner nie
jest ukrywany przez wcześniejszy błąd odczytu chunków. Nie ma fallbacku do
CURRENT lub aktywnej sesji ani pełnego skanowania niepowiązanych tensorów.
RunIntent ma limit 16 MiB zarówno przy odczycie, jak i publikacji.

Nowy GET należy do istniejącej rodziny project/run/SolutionSet/revision:
`.../members/{member_id}/artifacts/{artifact_id}/materialized-dataset`.
[Kontrakt API](../../../../../specs/materialized-dataset-resource-v1.md)
określa pełną ścieżkę, błędy i limit odpowiedzi 1 MiB. JSON zawiera pełny
opis naukowy pola, coverage, dataset, definicję i dokładne źródło; nie
zawiera wartości numerycznych ani referencji chunków.

Containing revision i owner revision są oddzielne. Wszystkie nowe u64 są
stringami, zachowując dokładność także powyżej 2^53. `integrity=verified`
oznacza weryfikację wybranego grafu CAS; status wykonania i ocena naukowa
pochodzą z dokładnego ownera. Ready nie zamienia Running/Unassessed w
kwalifikowany wynik.

Wygenerowane OpenAPI, typy i transport są źródłem centralnego facade.
Resource hook używa wszystkich sześciu składników tożsamości oraz rootu
manifestu jako rewizji cache. Sprawdza również nested source, tensor root,
identyfikatory dataset/definition/sample/item/field, canonical revisions,
owner ≤ containing i budżet manifestu. Zmiana źródła anuluje stary request.
Facade i hook odrzucają lookup IDs przekraczające 1024 bajty UTF-8.

## Dowody

Receipty znajdują się pod kanonicznym
`storage/builds/fullmag-0950f4dca4ffe38f`; poniżej podano profil, trasę i run ID.
Każdy receipt ma `state=passed`, `exit_code=0` oraz
`source_changed_during_run=false`.

| Bramka | Profil / trasa | Run ID |
|---|---|---|
| Kompilacja źródeł API | windows-api-source-check / api-source-check | e8d180cb80f74960865cdd419b444d46 |
| Generacja OpenAPI | windows-api-source-check / api-openapi-codegen | 17d9004483f24e9db09f97f886875840 |
| Generacja klienta | windows-control-room-source-check / generate-client | c0e1e232b6704ae0afb2fc12dd29cef1 |
| Produkcyjny TypeScript | windows-control-room-source-check / production-source | 8dc7be0cbb6145e9a7fc3be9b8b2ccb4 |
| Higiena API | windows-control-room-source-check / api-hygiene | 4fd34021245e4e13b04df437dd5350c8 |

Wstępna kompilacja wykryła brak Clone na współdzielonym accepted-state DTO;
poprawka jest w tym samym commicie, a końcowy source check przeszedł.
Review źródeł nie wykazał obejścia owner/project/run/revision/CAS.
Bounded RunIntent przed manifestem jest dodatkową bramką provenance;
manifest i exact owner nadal poprzedzają tensor/chunks.

Zakres commita obejmuje 17 plików. Dla trzech plików z obcym formatowaniem
zbudowano minimalne kandydaty z HEAD i porównano ich kanoniczne ciała Rust
z working tree. Staged diff check przeszedł. Zachowano 107 obcych dirty
ścieżek i pusty index po commicie.

Commit hook React Doctor zgłosił dwa istniejące sekwencyjne odczyty
topology range oraz klonowanie małego fixture JSON w teście. Te pierwsze
nie są zmianą tego przyrostu; fixture służy izolacji mutacji negatywnego
przypadku i nie jest runtime resource. Ostrzeżenia nie dowodzą regresji
produkcyjnej ani nie zmieniają granic poniższych bramek.

## Granice i dalsza praca

| Bramka / zakres | Status |
|---|---|
| Źródła i generacja | PASS |
| Dodane regresje Rust/TypeScript | NOT COMPILED / NOT RUN |
| Odczyt HTTP na managed runtime | NOT VERIFIED |
| Browser / WebGL dla nowego datasetu | NOT VERIFIED |
| Peak RAM, nauka, cztery realizacje solvera, release | NOT VERIFIED |
| ResultsNavigator / Inspector dla przypiętego datasetu | OPEN |
| Binarny bounded slice pola i renderer | OPEN |
| Materializacja wielopunktowa / osie / transformacje | OPEN |

Źródła regresji obejmują current/historical owner, brak membera/artefaktu,
niezgodną strukturę, provenance, kolejność błędów przed chunk payloadem,
budżet RunIntent, kodowanie URI i wszystkie części cache key, u64 >2^53,
status Running/Unassessed oraz nested identity fences. Nie są dowodem
wykonania: obowiązuje zakaz kompilacji testów jednostkowych.

Następny wycinek: jawna selekcja przypiętego datasetu w istniejącym Results
oraz Inspector metadanych przez ten resource hook. Selekcja musi zachować
project/run/set/containing revision/member/artifact i root manifestu;
rewizja datasetu nie zastępuje rewizji SolutionSet. Odczyt wartości wymaga
osobnej binarnej trasy z bounded slice i exact source, bez mutable tables
lub live preview fallbacku. Dalej pozostaje poprawka markerów native FEM
z [audytu 48](48-native-region-marker-followup-audit.md), po wymaganej
aktualizacji not naukowych, oraz managed runtime i kwalifikacja P0–P8.
