# Checkpoint generated-authoring v2 — odbiór wdrożenia

Użytkownik zatwierdził v2 i jedną kontynuację istniejących, niewykorzystanych limitów
jednego managed buildu3203 oraz jednej próby V/J/H na tej samej siatce.
Zatwierdzony patch:8e9fe5df53960b8e54726988b83548aab093da138d63d40f7644f0d00d23999e.
Zastosowano dokładnie te bajty po porównaniu obu bazowych hashy plików.

## Kod i testy

Commit4856334d57755a276be163b95df3ac92c7851e7a zawiera wyłącznie patch,
trwałe testy i ich krok CI. Wcześniejsze dirty zmiany launchera pominięto
w commicie, używając osobnego indeksu. Chronione63 wcześniejsze wpisy indeksu
pozostały identyczne SHA256:f8c8d727f21451b25db1d2050015b469ad6bdb00b07fdba84136095367eb6fd3.

RED nowych testów wykazał brak SCHEMA_V2. Po zastosowaniu patcha:17/17 PASS,
0skip. Obejmuje stare przypadki v1, wszystkie przypadki v2 oraz brak głównego
heartbeat i zmianę pola heartbeat_at zagnieżdżonego. Istniejące testy receipts
i retained history:76/76 PASS,0skip. Wykonano lekki Python w istniejącym backendzie;
bez lokalnej kompilacji Rust i bez operacji lifecycle w tych testach.

Świeży końcowy review: brak Blocker/Required. Osobny commit
cf7db0ddc58d0c6e546531d8c8046ff22ce4191f poprawia jedynie asercje czterech
obserwacji retry w trzech istniejących testach. Dwa wcześniejsze CI odmówiły
wymagania callbacku przed100/250ms; druga odmowa zawierała poprawny typ błędu.
Kod kończy oczekiwanie, jeżeli pierwsza operacja zużyje deadline. Test wymaga
teraz callbacku albo pomiaru rzeczywistego wyczerpania budżetu; nadal sprawdza
typed error, claim, lease, Start oraz rezerwacje. Produkcyjny helper bez zmian.
Bramka pełnego CI została zaliczona przed buildem; wynik i pin podano poniżej.

Odłożona drobna uwaga review: pomiar zewnętrzny obejmuje descheduling i sam
nie dowodzi wykonania callbacku; osobny kontrolowany zegar może uzupełnić test.
Istniejący writer-busy test nadal jawnie wymaga busy_count>0.
Nie dodawano nowej abstrakcji zegara ani nie zwiększano timeoutów.
Przeanalizowane źródła narzędzi:
https://doc.rust-lang.org/std/time/struct.Instant.html
https://tokio.rs/tokio/topics/testing

## Rzeczywisty preflight

Nowy checkpoint v2:
1f78a177f67d5996a55838895b54076b8d99ad4717f80e5908c864da5575faf7.
Zmieniły się wyłącznie schema i nazwa/wartość wersjonowanego pinu owner;
pozostałe piny z poprzedniego checkpointu zachowano i sprawdzono.
Rzeczywisty native preflight PASS:
ec1ac7b6c348797457cbbaf529c3ea2d2a952bffa98488c4df67bd91fb269bb5.
Obejmuje tę samą scenę i generated source przed/po, FMS, native ready owner,
profil storage, puste aktywne kolejki i dwa terminalne katalogi runów.
Cztery powiązane rezerwacje mają stan released.

Pełne dowody techniczne są w prywatnym wolumenie grupy:
verification/rt0-center-diagnostic-execution-20261108/stable-owner-v2-approved/.
Nie zmieniano .env, mountów, limitów, tolerancji ani historii wyników.
Pełne CI zakończyło się SUCCESS:
https://github.com/MateuszZelent/fullmag/actions/runs/42519781724.
Wykonano16 testów runnera,3 testy raportu workera i31 testów saved-authoring/history.
Oba wcześniej wadliwe testy callbacków przeszły w binariach runtime service
i accepted scheduler. Pełny log SHA256:
cd93144c78bf3a1448c2496e7e90b5bbe237d1e9aa55d4dd3120b001d2b88041.

## Aktualizacja i pojedyncza próba

Managed iteration43be7538f02e41158d91220456834c0a zakończyła się succeeded/exit0.
Kompilacja1126994ms;24 pliki pakietu. Nie był to cache-hit.
Nowy snapshot:e03f86278ae0900f27545eefdfb7c273c6565e4c4d750f931572f9989ecb3c87.
Provenance SHA:caf108da1cba04b667c34111cb71b8e7f6f3540bbee619d8a2ba772b8653a0fb.
Build receipt SHA:99634edd4866955a3133463fe4ee023d622ea057d4c1845e03de1e5616e2921b.
API, CLI i worker mają hashe zgodne z manifestem; marker diagnostyki jest
w rzeczywistym workerze. Nie uruchamiano drugiego API do kontroli wersji.
Scena i generated source po publicznym restore mają identyczne hashe jak
przed restartem. Profil exec:default@1 pozostał opublikowany.

Wykonano jeden Submit. Klient przekroczył30s bez potwierdzenia; nie powtórzono
POST. Pierwszy GET odmówił odczytu przy aktywnym writerze; kolejny GET200
potwierdził identyczny run oraz payload fingerprint
367163b12b208c5231dd36915e200f3b2d9d5e78c887d24043302e5389ca5a95
i pending_materialization. Przewidziana jedna materializacja zwróciła HTTP200.
Task:task-bbb58bc0dc7acd815d36f300e9cb94c8d9c8fa711beb288863e8cc4ff114e08d.
Jedna próba:attempt-3f8996a1f2a54c54b5d06763059c4c7d.
Run:run-d04ef5217d24a697985f08e449c0648bbc5629402b7be74f6292ce08abfe7046.

Runtime potwierdził40728 źródłowych Tet4, bez nowego meshowania.
Po 438,805 s wykonano 20/20 punktów H i rozpoczęto validating_result.
Próba zakończyła się Failed: pierwsza odmowa J w komórce 28881, oś y.
Świadek przetrwał worker exit receipt. Nie opublikowano accepted artifacts.
Minimum zgłoszenia:1CPU/4GiB; grant istniejącej polityki:3CPU/5,25GiB RAM
i7GiB scratch. Nie zmieniano polityki lub limitów kontenera.

Dane interpretacyjne są też na ext4 w
examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/.
Kopia captured-script SHA:d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148
pochodzi z immutable asset w archiwum; główne source manifestu projektu jest
null. Nie wykonano skryptu ponownie. Sam skrypt nie zastępuje requestu
i przygotowanych assetów. Odczyt rzeczywistej odmowy został wykonany:
[wynik i ograniczenia](2026-11-08-rt0-actual-center-failure-result.md).
Wszystkie 15 próbek J tej komórki odtworzono bitowo z momentów RT0.
Rozbieżność środka zapisanego i dokładnego wyjaśnia odmowę; nie kwalifikuje
całego źródła, pola H ani reprodukcji publikacji.

Oba lokalne lease i obie rezerwacje hosta są released; kolejka jest pusta.
Jest jeden worker attempt i jeden exit receipt, bez ponowienia. API odpowiada ok.
Historyczne katalogi zachowały SHA256. Wykorzystano dokładnie jeden build,
jeden Submit, jedną materializację i jedną próbę V/J/H. Brak dalszego Solve.
Kontrola wizualna po restore pozostaje NOT VERIFIED; nie zmieniano UI.
