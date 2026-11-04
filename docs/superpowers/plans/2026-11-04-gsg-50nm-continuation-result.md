# GSG 50 nm — wynik zatwierdzonej kontynuacji

## Wynik i zakres

Zatwierdzony patch metadanych capture 8→12 MiB został wdrożony przy zachowanej granicy kodu źródłowego 8 MiB. Jeden zarządzany build grupy 3203 oraz dokładnie jedna nowa próba V/J/H 50 nm zakończyły się powodzeniem. Publiczny odczyt 22/22 payloadów jest zgodny bajtowo z zachowanym pakietem/CAS. Wynik można oglądać bez ponownego Solve.

Cała kwalifikacja naukowa nie przeszła: prerejestrowane kryterium kontrakcji estymatora korekty prądu η jest niespełnione. Nie zmieniono progów. Nie wykonano retry, dodatkowego H-only, dziewięciu nowych referencji H ani LLG. Nie potwierdzono odtworzenia wyników publikacji.

## Tożsamość wykonania i odtwarzalność

| Element | Wartość / dowód |
|---|---|
| Build | `04a0fa4008524190b0fb63e073cda098`, Succeeded |
| Commit źródeł runtime | `fe958c6e992d978ad0f00cfe955913c211ef5819` plus dirty snapshot |
| Snapshot | `b6e447035ec862962aef5ec1f4a04eaba1efae5d7c1f182f8554a2cd89e8a74b` |
| Patch zatwierdzony | `4581df0a0922b415ee81fff101c7fd54a17d31211ccf85a1fc6207b43f85cb2a` |
| Run | `run-bc05bbf73072ea18dd6726455fe6f23f44fd7d3f3c2f624ec4630e5117a38e7e` |
| Task | `task-9c5a112cbb4f32964c1d698393bfa30e04217804d7dcedd61ac7a9f6f7ca1df6` |
| Attempt | `attempt-cce44c92e33c4a35a10aa170a37ef390`, epoch 1 |
| Pakiet CAS | `36eac68c08f9f5ef15f4d0d2ccae62eb35e67c6496b39702f359201e2d84fed2`, 258 821 008 bajtów |
| Backend | FEM CPU, double, strict; stały backend własnej grupy Docker w WSL |
| Siatka źródła | 72 911 Tet4, 23 730 węzłów |
| Sampling H | Te same 20 punktów / 24 Tet4 co 100 i 75 nm |
| Czas natywny | 1657,462 s = 27 min 37,46 s; bez utożsamiania z całym czasem kolejki i publikacji |

Pełny obwód GSG ma długość 20 µm, szerokość pasków 200 nm, szczeliny 250 nm, metal 90 nm, przewodność 3,5×10⁷ S/m i skok potencjału 1 mV. Połączenia końcowe stanowią uzgodnione przybliżenie obwodu; nie są kopią nieopublikowanych padów autorów. Sampling obejmuje x = −2; −0,45; 0; 0,45; 2 µm, y = ±50 nm, z = −22,4 i −5 nm. To nośnik kontrolny, nie siatka całej próbki ani gęste Universe.

Publiczny prepare zachował cały zamrożony model. Formatowany request ma 81 708 445 bajtów, kompaktowy HTTP 53 327 647 bajtów i mieści się w dotychczasowym limicie 64 MiB. Timeout klienta Submit rozstrzygnięto odczytem dokładnego fingerprintu, bez ponownego Submit. Dokładnie jedna materializacja i jedna nowa próba natywna.

## Odczyt i kontrole wyniku

Jeden zaakceptowany właściciel V/J/H, zamrożone węzły, stabilne ID, komórki i lokalne ślady J są zgodne z archiwum. Natywny certyfikat rangi odpowiada niezależnej kontroli: 72 929 wierszy, ranga 72 928, pominięty `divergence:1:61:7447:10091`, residual 0.

| Wielkość | Wartość |
|---|---|
| Prąd odniesienia | 17,544135186 µA |
| Norma H na 20 targetach | 0,07444933245–24,46131342 A/m |
| Norma J w środkach komórek | 47 857,77363–1 480 283 958 A/m² |
| Potencjał | −0,0003439754463–0,0006560245537 V |
| Względny residual ładunku | 2,239774563×10⁻¹⁴ |

Bilans i ranga są kontrolami dyskretnymi, nie dowodem zbieżności do rozwiązania ciągłego ani poprawności całego pola.

## Trzy poziomy siatki

| Rozmiar nominalny | Liczba Tet4 | Prąd [µA] | η |
|---|---:|---:|---:|
| 100 nm | 14 299 | 17,535281560 | 0,04909710 |
| 75 nm | 25 516 | 17,541916132 | 0,03828854 |
| 50 nm | 72 911 | 17,544135186 | 0,03496045 |

Dla 75→50 nm zmiana I wynosi 0,0126484%, maksymalna względna zmiana pełnego wektora H na wszystkich 20 targetach 0,0166899%, a H/I 0,00407274%. Mieszane progi H, H/I i I oraz kontrole malejących przyrostów albo poziomu podłogi przechodzą. Uzupełniono brakującą w pierwszym skrypcie jawną kontrolę malejącego przyrostu I; przechodzi i nie zmienia odmowy η.

Ilorazy η wynoszą 0,7798534 i 0,9130786. Drugi przekracza prerejestrowaną granicę 0,8. Sam spadek η poniżej 0,05 nie wystarcza. Całkowity wynik bramki: FAIL. Nie wyznaczamy GCI z trzech nienested siatek; zmiany pomiędzy siatkami nie są błędem względem rozwiązania dokładnego.

Postprocessing zachowanych wyników rozdzielił licznik i mianownik istniejącego estymatora po jawnych częściach obwodu. Partycja pokrywa wszystkie komórki dokładnie raz, a sumy energii są zgodne z pełnym źródłem w arytmetyce Decimal120 (kontrolowana różnica grupowania poniżej 10⁻¹⁰⁰ względnie). Nie uśredniano lokalnych η. Diagnostyka trwała 81,676 s i nie uruchamiała Solve.

Dla 50 nm połączenia inlet/outlet odpowiadają za 99,89775% energii korekty, przy lokalnych η około 0,08712 i 0,08568; proste paski mają η około 0,00120–0,00125. To lokalizacja dyskretnej korekty, nie oszacowanie błędu H ani dowód konkretnej przyczyny fizycznej. Następna kontrola siatki powinna skoncentrować się na połączeniach i przejściach; nowej próby nie uruchomiono.

## UI i granice dowodu

Zapisany H 50 nm jest widoczny w przeglądarce: 20 próbek, legenda 3D 0,07445–24,46 A/m, aktywny WebGL, drawing buffer 840×423 px, 20 glyphów i 0 klatek / 2,01 s idle. Przekrój XZ przy y = 0 pokazuje wektory i zakres rekonstrukcji 0,08929–23,66 A/m. Pionowe powiększenie ×100 jest jawnie opisane jako wyłącznie prezentacyjne. Rekonstrukcja z 20 punktów nie dodaje nowych obliczonych próbek. J 291 644 lokalnych węzłów i V odczytano publicznie; ich pełnego nowego renderingu 50 nm nie kwalifikowano w tej kontroli.

Izolacja właściciela kolorów: 215 testów, TypeScript i lint przeszły. Rzeczywiste przełączenie J→H dotyczyło zapisanego 75 nm; wymuszony wyścig zakończeń workerów sprawdzają deterministyczne testy hooka. Screenshoty pokazano inline; wcześniejszej blokady trwałego eksportu plikowego nie obchodzono. Nie zaliczamy jeszcze pełnej czytelności długiego obwodu w 3D.

## Zachowanie danych, retencja i integracja

Scena po próbie jest identyczna z odtworzoną sceną sprzed Solve. Worker procesu 22096 już nie istnieje, jest receipt zakończenia i opublikowany wynik. Odczyt ujawnił jednak `observation=reconciling` oraz jedną rezerwację solvera nadal `committed` (102 inne `released`). Zakończenie lifecycle nie jest zatem dowodem pełnego zwolnienia zasobów. Log istniejącego compute schedulera potwierdza `worker_error_after_task_settlement`: `persist confirmed worker process exit; supervisor slot retained`, po błędzie `session store writer is busy`. Katalog `worker_process_exit_receipts` nie powstał. `accepted_study_supervisor.rs::persist_worker_process_exit_receipt` kończy po wyczerpaniu retry przed reconciliation/release. Istniejące `succeeded_worker_recovery.rs::run` wymaga dokładnie jednego trwałego exit receipt i terminalnych dzieci runtime ownera; bieżący przypadek tego nie spełnia. Nie resetowano blokad, nie zmieniano historii ani nie zwalniano rezerwacji ręcznie. Cztery późniejsze odczyty blokad i deskryptorów nie wykazały trwałej blokady ani otwartego WRITER.lock. `writer.rs::ReadTransaction::acquire` blokuje writer współdzielonym odczytem bez aktualizacji rekordu właściciela, więc observed_owner_released=true nie identyfikuje historycznego blokującego. Długi odczyt podczas publikacji jest hipotezą zgodną z kodem, nie potwierdzonym pomiarem z chwili awarii. Samo zwiększenie retry nie zabezpiecza trwałości zaobserwowanego zakończenia procesu po wyczerpaniu czasu oczekiwania.

Wszystkie 55 starszych katalogów są identyczne bajtowo; katalogów jest teraz 56.

Po publikacji builda kwalifikowana retencja usunęła 14 399 837 248 bajtów plików roboczych; pakiety current i bezpośredni rollback pozostały. D: po buildzie miał 105 211 219 968 bajtów wolnych; nie jest to dowód zmniejszenia VHDX. Bez globalnego prune i bez usuwania wyników.

Spójny fragment capture zapisano w commicie `cd3a505a7dfe1224e17a3b5c56fddd2dafb52d7d` (dwa pliki Rust i osobny raport capture). Wszystkie 47 pozostałych staged wpisów i ich diff zachowano bajtowo. Runtime nadal wskazuje wcześniejszy commit plus snapshot; commit nie oznacza nowego buildu. Brak push/merge tego fragmentu. Szersze zmiany UI i E0–E12 nadal wymagają integracji.

## Właściciele nauki i dowody

To wewnętrzny raport wykonania, nie nowa nota publikacyjna ani nowy model fizyczny. Kanoniczne równania, jednostki, granice quasistatyczne i mapowanie Python→ProblemIR pozostają w [nocie 0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md). Estymator realizuje `scripts/antenna_gsg_current_correction.py::weighted_rt0_h1_correction`; certyfikat backendu: `backends/fem/cpu/mfem/transport/conservative_current_view.cpp::analyze_physical_constraint_rank`. Prerejestracja: [eksperyment 100/75/50](2026-11-03-gsg-source-convergence-experiment-proposal.md). FEM CPU/double jest jedyną ocenianą tutaj lane; FEM GPU, FDM CPU i FDM GPU nie były częścią tej próby i nie uzyskują przez nią kwalifikacji.

Źródło publikacyjne: [Sushruth et al., Physical Review Research 2, 043203 (2020)](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.2.043203). Niniejsze wyniki dotyczą źródła V/J/H, nie odtworzenia transmisji z pracy, wzbudzonych modów ani m(k,ω).

Dowody w prywatnym wolumenie kontrolnym grupy 3203: `verification/gsg-50nm-approved-20261104/`, w szczególności `50nm-new/complete-public-verification.json`, `50nm-new/rank-certificate-verification.json`, `three-level-comparison-complete.json`, `part-current-correction.json` i `capture-commit-result.json`. Dziewięć referencji H, kwalifikowana baza, pole na właściwym mesh magnetycznym, LLG i ilościowa reprodukcja publikacji pozostają nieukończone.
