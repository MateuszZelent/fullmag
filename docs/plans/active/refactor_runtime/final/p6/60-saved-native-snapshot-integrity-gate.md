# P6-60 — bramka integralności zapisanego snapshotu FEM

Data: 01.10.2026. Baza: `f84037d59becf6481d9b2fc6ab055f64585aea84`.
Status: przyrost źródłowy. P6 około **52%**, cały plan około **49%**.

## Implementacja

Ukryta komenda repozytoryjna `fullmag runtime verify-saved-fem-snapshot`
przyjmuje jawny `--store`, plik `--source` z `PinnedSolutionTensorSource`
oraz `--source-artifact-id`. Otwiera istniejący magazyn przez `open_existing`;
nie tworzy repozytorium, nie naprawia danych i nie zmienia aktywnej sesji.

Runtime control wybiera published source i dokładny manifest jego historycznej
próby: run, task, attempt, ownership epoch, step, port, case i CAS hash muszą
się zgadzać. Nie używa aktualnie aktywnego tasku ani latest SolutionSet.
Manifest pochodzi ze zweryfikowanego CAS, nie z JSON dostarczonego przez caller.
Duplikat manifestu, brak źródła i niezgodność to błąd przed wynikiem PASS.
Jawny source artifact musi być równy `field_binding.item_id` pinned tensora.
Sprawdzany jest też dokładny member historycznej rewizji (task, attempt,
epoch, stage, case), carrier manifestu w metadata member tej samej próby
oraz pełny `AcceptedStateId` manifestu względem tensora. Katalogowy typ
artefaktu musi odpowiadać typowi output w manifeście.

Istniejący exact reader następnie sprawdza wskazaną immutable rewizję/member,
źródłowy artefakt, binding tensora, wszystkie bajty F64, mapę lokalnych
węzłów, canonical periodic classes i indexed geometry. Ta bramka wymaga
receiptów mapy i geometrii; legacy pozostaje czytelne przez dotychczasowy
reader, lecz nie otrzymuje PASS nowej bramki.

Limity wejść: pinned source 16 KiB, katalog artefaktów 16 MiB,
manifest próby 1 MiB. Limity źródłowego pola, mapy i chunków pozostają
te same co w P6-56–59. Są to limity odczytu, nie pomiar peak RAM.
Wynik jest JSON z dokładnym pinned source, source artifact i native receipt.
Nie zmienia `representation_evidence`; nauka i archive roundtrip pozostają
oznaczone `not_verified`. Komenda nie uruchamia solvera ani publicznej trasy
authoringu, nie dodaje endpointu ani nowego CAS root.

## Weryfikacja

Dodano stałą trasę `just check-cli-source`, z resolverem, lockiem storage,
source identity i terminalnym receiptem. Polecenie to wyłącznie
`cargo check --locked -p fullmag-cli --bin fullmag`; nie kompiluje unit tests
ani natywnego solvera. Adapter shell dopuszcza dokładnie tę nazwę trasy,
zachowując odrzucanie nieznanych tras.

Production source check: **PASS**, exit 0, source unchanged,
receipt `f81eab12d69c4aa79c58e2c4b7df4507`, katalog
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/cli-source-check/`.
Dwa lekkie testy Python: stała komenda source-only oraz odrzucenie nieznanej
trasy — **2 passed**. Nie zbudowano ani nie uruchomiono Rust/C++ unit tests.
Pierwszy review wykrył dwie luki P1 w powiązaniach historical owner/accepted
state; poprawiono je przed commitem. Wynik końcowego review i checku poniżej.
Końcowy production source check po poprawkach: **PASS**, exit 0,
source unchanged, receipt `6d2c3c53d0e84227a3d28d2cbf1eb9ec` w tej samej
trasie storage. Kontrola spójności repozytorium i zmienionych linków: PASS.
Ponowny niezależny review: **brak P0/P1**; obie wcześniejsze luki zamknięte.
Dodano źródła regresji correct lineage, obcego attempt, rozbieżnej case
lineage oraz duplikatu outputu; pozostają niekompilowane zgodnie z zakazem.
Świadome ograniczenie tej bramki: manifest próby większy niż 1 MiB jest
odrzucany, nawet gdy inny ogólny reader dopuszcza większy dokument.

## Pozostałe bramki

Aktualizacja 01.10.2026 13:16 UTC: build 189 zakończony exit 0, wszystkie
113 artefaktów zweryfikowane; dotyczy tylko P6-55. Build 191 już running,
192 nadal queued. Procedura Archive roundtrip i dokładny zakres dowodów:
[P6-61](61-saved-fem-archive-roundtrip-route.md). Niższe stany kolejki opisują
historyczny checkpoint zgłoszenia.
Późniejszy odczyt: build 191 terminalny **failed**, exit 2 w native-build;
compiler widzi starsze quantities/IR metadata mimo obecności nowych modułów
w źródłach. Diagnoza nadal otwarta; build 192 pozostaje queued. Nie traktować
wcześniejszego stanu running ani source check PASS jako sukcesu native buildu.

Build 189 (`529ac93e81744c5faf50494306d50a11`) nadal **running**;
191 (`78d0c52ecb0245aa85f9411d76f8b914`) nadal **queued**.
191 przypięty do P6-59 nie zawiera nowej komendy P6-60.
Nie zatrzymano żadnego z tych zadań.

Implementacja P6-60: `fa7378e72018e8d98157ff37a27861c48f670626`,
zacommitowana i wysłana na remote master. Build **192**,
`5d750ed66e584869ab6e88e48c457c86`, profil `fem-cpu-release`, źródło commit
dokładnie powyżej, `source_snapshot_dirty=false`, bez dirty paths.
Request key: `p6-60-fa7378e72018e8d98157ff37a27861c48f670626`.
Capture: `c15e562ab48e46d0a82999afc2cc2494`.
Source capsule SHA-256: `de865d2422d8f2e5ba7f1d4979128512701cc0157770f8016af7555cbb328d49`.
Native source snapshot SHA-256: `540bb2ff7be94c4b6a21efb31b73a66c65346d89b41c12a1a9f0b8a75a3f7934`.
Odczyt po zgłoszeniu: **queued**, coordinator/exit code null. Ten build ma
dostarczyć binarium komendy P6-60. Build 191 zachowano jako osobną bramkę
kompilacji natywnego przyrostu P6-59. Żaden queued build nie jest PASS.

Wykonać bramkę na rzeczywistym accepted FEM run po produkcyjnym buildzie
zawierającym tę komendę, następnie porównać wynik przed eksportem i po imporcie
FMS do oddzielnego magazynu oraz sprawdzić odrzucenie uszkodzonych kopii.
Runtime tej komendy i pełny roundtrip: **NOT VERIFIED**. Dalej pozostają
binary geometry API, resource hooks, renderer/browser, pozostałe lane'y,
nauka i release. Nie zwiększono procentów na podstawie source checku.
