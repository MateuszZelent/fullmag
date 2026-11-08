# Odbiór restartu wygenerowanego authoringu i jednej próby corner25

Data:08.11.2026. Audyt wykonania, bez zmiany równań lub kryteriów.
Właściciel fizyki i granic odtwarzania publikacji:
[nota0951](../../physics/0951-sushruth-2020-forward-volume-reference.md).
Wynik naukowy tej próby: **NOT VERIFIED**. Nowego V/J/H nie opublikowano.

## Wynik zatwierdzonej sekwencji

Użytkownik zatwierdził naprawę preflightu i dokładnie jedną sekwencję według
[projektu](2026-11-08-generated-authoring-restart-preflight-proposal.md),
SHA256 e9307db2649cbc2f052c23ccf9f7f1fbad90a7ea6ce345cfd43f2095e2ee34c8.

| Odbiór | Stan i rzeczywisty dowód |
|---|---|
| Poprawka generated-authoring | Wdrożona, commit c15f3072f7378b0693580b5c219aeb4e5b442d6e |
| Testy | 6 nowych i65 istniejących regresji PASS; rzeczywisty pełny preflight PASS |
| Jeden managed update/build3203 | Succeeded, exit0; iteration99705446a054490e996e10338f84bca1 |
| Przywrócenie | Ta sama scena i identyczny wygenerowany Python, bez wykonania skryptu |
| Zachowane wyniki | 63 odczyty HTTP PASS, dokładne payloady H275 i V/J/H100/75/50nm |
| Jedno Prepare corner25 | Succeeded, publiczny compact request odebrany, exit0 |
| Jeden Submit | Przyjęcie potwierdzone GET i fingerprintem po timeout CLI; bez ponowienia |
| Materializacja przyjętego runu | Dokładnie1, HTTP200, ten sam run |
| V/J/H | Worker exit1, task failed podczas walidacji J po zgłoszeniu20/20 H |
| Nowy wynik / porównanie eta | Brak opublikowanego solution_set; nie wyliczono nowego eta |
| Rozliczenie zasobów | Oba lease lokalne i obie rezerwacje hosta released, z proof |
| Browser | NOT VERIFIED w tym odbiorze; nie zmieniano kodu UI |

Nie wykonano drugiego Submit/Solve, retry, H-only, LLG, nowego recovery,
zmiany limitów, geometrii, tolerancji, .env lub usuwania danych.
Kwalifikowana automatyka cache zakończyła się sukcesem i zachowała current
oraz direct-rollback. Nie uruchamiano ręcznego czyszczenia.

## Pakiet, scena i zachowanie danych

Managed just w WSL zakończył aktualizację po1428,094s, około23min48s.
To czas całej operacji, nie benchmark samego kompilatora.
Wersja:0.1.0-dev.20261108.gc15f3072f737.dirty.s044404bea253+9808.
Native snapshot:044404bea25340ded0322ab4ed0d8b666fa4312cb3c8e680570be7cb494644f1.
Build receipt:35318db6558658d4b8912197b3b497c4a6da92647f74d3361321499f4a9f83d5.
Runtime provenance:fb83d368d97c96128b03a695bced6462fb49ff16541cbd0d265594fb37b43ef9.
API:a806e35f724c5d0b1a1f36d044e1eaf7d49783ea6a3571eafdcb77ee00812f8b.
CLI:681b9601e6fdaa271a239d6610b46fa1d33320e30f2e37138846bb552de549b9.
Hash uruchomionego procesu API jest zgodny z publikowanym binarium.

Po restarcie nie było aktywnej sesji. Istniejące publiczne persistence/open,
sessions, model/transactions i model/syncs przywróciły zachowany projekt
w nowej sesji session-18e62046a1f6ca4a00004dbe.
Scena revision1 ma dokładnie SHA256
5a78f67548162c0e33c78324573ebf680b9bf6f4de9d0cd2aa0cc6600173c864.
Wygenerowany Python5483B nadal ma SHA256
d6c8d55caf95638089ba71b5a0f326f7f00094520bf79bd810f0f4aa7c0b2e94.
Zachowano oryginalny i nowy FMS. Nie wykonywano ich skryptów do odtworzenia UI.

## Odebrane przygotowanie

Operation9440b363eda74047ba4d768dac1baaa1.
Controller:e721b84fd2be2b6fae34c35fbedbd058656164bf9fb98b94d31570fce0eac3b8.
Result:27b9deabef045186ca8a6de127e1563a08ed5a1c0a9476f1a41be35e052f7906.
Compact request47551988B:
80b177c9f483ae5288c9d7dc80cc121bc63d6e3ebde25a8bf28faa262bc2a8d0.

Pełne pięcioczęściowe GSG,40728Tet4,14194węzły po cięciu i18par źródła.
Te same materiały35e6S/m i skok1mV. Zadane rozmiary:25nm w narożach,
50nm w połączeniach,75nm na paskach. Wszystkie10wejść zachowało piny.
40728<72911;814560par źródło–target mieści się w4mln.
Te same20punktów H i24Tet4 nośnika; binary64 XYZ są bitowo identyczne
z local50, SHA256 d22b100caf3c09f8ae484809ba4cef267d80c6a9d24415dc0153e52377da0684.
Nowy mesh nie jest poprzednim mesh40703; nie deklarujemy cache hit.
Przygotowanie samo nie kwalifikuje źródła ani fizyki.

## Jedna próba i dokładna odmowa

Run:run-0b9ca0bef7df4faf91113e00e2702cdb61b8b65098159fca9ac4e12b6e82e807.
Task:task-c8d8d21eb721294cd4524cbae67183f48b8944b32df4d22bde0118cf7d833de8.
Attempt:attempt-a78a30fa05034ecbb18c159a27644f37, epoch1.
Fingerprint:65f8b252c9deb04748b017f52f9199f84d6eadd1abcec9f15501e9bc142be628.

CLI zgłosił timeout po30,544s. GET potwierdził dokładnie ten fingerprint
i pending_materialization. Jedna istniejąca materializacja utworzyła task;
nie wysłano ponownie zgłoszenia. Zasoby requested są minimami:
1000mCPU,4GiB RAM,512MiB storage,0GPU.
Rzeczywisty przydział solvera:3000mCPU,5637144576B RAM,7516192768B storage.
Nie opisujemy go jako wykonania ograniczonego do1CPU/4GiB.

Obserwacja natywna dotarła do validating_result,20/20targetów,
elapsed434,659940888s. Jest to postęp obliczeń, nie dowód przyjęcia wyniku.
Trwały exit receipt potwierdza exit1, bez timeout, stop_requested lub OOM:
execute canonical full-volume inspection: RunError:
closed-loop identity refused: cell-local J interpolation mismatch.

Publiczny task jest failed; solution-sets jest puste, a katalog inspection
nie istnieje. Nie mamy nowego przyjętego H, certyfikatu ani eta do porównania
z publikacją. Nie zamieniamy informacji20/20 na deklarację udanego Solve.
Historyczne wyniki pozostają dostępne; końcowa sesja UI awaiting_command,
run=null. Oba zasoby próby są released, bez ręcznego recovery.

## Wąska diagnoza i następny dowód

| Źródło | Symbol i odpowiedzialność |
|---|---|
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs | verify_owned_geometry: porównanie średniej czterech J z J w środku, budżet128epsilon64 razy skalę składowej |
| backends/fem/cpu/mfem/transport/closed_loop_source_snapshot.hpp | export_closed_loop_source_snapshot: osobne próbkowanie J w wierzchołkach i zaokrąglonym centroidzie |
| backends/fem/cpu/mfem/transport/affine_rt0_element.cpp | AffineRt0Element::retained_current_at: dokładne próbkowanie zamrożonego pola RT0 |
| scripts/docker_gsg_mesh_preparation.py | mesh_report / guest / run: odbiór źródła, nośnika i przygotowanego requestu |
| scripts/docker_dev_submit_accepted.py | submit_once / materialize_once: trwałe fence i brak ponownego Submit |
| scripts/verify_archived_solution_http.py | verify_http: zgodność historycznych tensorów przez publiczne HTTP |

Pewna jest konkretna bramka i jej warunek, nie przyczyna numeryczna.
Komunikat nie zawiera numeru elementu, osi, obu J ani przekroczenia budżetu;
nie zachowano zaakceptowanego snapshotu z tej próby.
Rozbieżność pomiędzy próbkowaniem w zaokrąglonym centroidzie a średnią
wierzchołków jest hipotezą do sprawdzenia. Nie wykluczono błędu nośnika
lub innego błędu producenta. Nie zwiększać tolerancji na podstawie komunikatu.

Następny diagnostyczny krok wymaga pokazania konkretnego elementu, osi,
obu wartości J, ich różnicy, aktualnego budżetu i błędu centroidu, następnie
regresji odtwarzającej przyczynę. Nowy build lub Solve jest poza wykorzystaną
jedną sekwencją; w tym odbiorze ich nie wykonano.
Odtworzenie Fig.3, kwalifikacja źródła i napęd LLG nadal pozostają otwarte.

## Zachowane dowody

Prywatny control volume grupy3203:
verification/generated-authoring-restart-20261108/.
execution-evidence-manifest.json przypina35plików:
ffec348a98dbf3be06967956c0c57ac03d88399bac5a6d65899904243e81a8fd.

| Dowód | SHA256 |
|---|---|
| post-build-archived-readback.json | ff5416b2c4e7509c5515fb3f0ac5b22d43e672050c6e131a5d9635a53d32d630 |
| terminal-native-evidence.json | 9440ce2a8bbc691b74e80e49306dfd5b004bd25e38abb480cd4bd953ddb60dce |
| terminal-host-reservations-full.json | ab4d70cba9d0c498d7962326bbd5a8536b1df08da8aa5ce38b96163c47419bfa |
| terminal-run.json | ad27a146767c0c895fce9665185893192441340539697108cdd2910dfc8c2b09 |

Request, cache i pełny result przygotowania pozostają pod:
verification/gsg-junction-preparation-20261106/attempts/9440b363eda74047ba4d768dac1baaa1/.
Dokument rozlicza wykonanie; nie ustanawia nowego kontraktu fizyki lub recovery.


Kopia wejść naukowych na ext4 WSL:
 /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011/examples/sushruth_2020_closed_gsg/corner25_9440b363_20261108/
Zawiera skrypt, nośnik, cache siatki i frozen prepared request:4pliki,
49455258B. Manifest64d416521ab1ffa924f4abf96d82bff4b2d1712706e7b2e9eae2397d14c5d02f.
Request odwołuje się do innych asset_paths; nie jest samodzielnym pakietem.
Nie opisujemy tych wejść jako wyniku V/J/H.

Niezależna eksploracja tylko do odczytu potwierdziła hipotezę centroidu,
lecz nie przyczynę konkretnej odmowy. Live ABI kopiuje tablice bez JSON;
walidacja closed_loop_v2.rs::build poprzedza tworzenie artefaktów.
Katalog temp jest pusty, katalog wyników nowego runu nie został opublikowany.
Nie znaleziono zachowanej próbki niezgodnej komórki. Następna diagnostyka
powinna zachować bity pierwszej odmowy; nie zastępować center J średnią
wierzchołków i nie poluzowywać progu bez dowodu.
