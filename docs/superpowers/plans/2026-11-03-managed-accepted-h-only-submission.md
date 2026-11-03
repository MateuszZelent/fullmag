# H-only przez publiczne API w działającej grupie Docker — 03.11.2026

## Wynik i granice

Zatwierdzona kontynuacja recreate oraz build zakończyły się poprawnie.
Nowa próba H-only przeszła przyjęcie publicznym API, materializację,
przygotowanie FEM i start workera. Operator pola zakończył się odmową
`surface RT0 named work limit exhausted`, przed ukończeniem pierwszego z 275 punktów.
Nie ma nowego pola Universe ani podstaw do ogłoszenia odtworzenia publikacji.

Nie zmieniono fizyki, tolerancji, budżetu operatora, CPU/RAM kontenerów ani
zachowanego prądu. Nie wykonano drugiego Submit ani drugiego Solve.
Rezerwacja zakończonej próby została zwolniona przez runtime; API pozostaje
zdrowe, kolejka jest pusta. Nie wykonano kwalifikacji przeglądarki/WebGL.

## Tożsamości i dowody

| Element | Wartość |
|---|---|
| HEAD źródeł pakietu | `b683b10fbde6de3570151330485fcdb938af682b` + dirty snapshot |
| Snapshot natywny | `8cc0720824d64c9bd02c7bf3b3ea66a4b11ef176987d471e6b5d4a41315b7911` |
| Udany build development | `6e0ad3f585e14fc2ab68e9e8129852fe` |
| Konfiguracja Compose SHA256 | `4587192e0a358bd8b1a00f506586916930f7552cf3970a0d255049fdbf8eddd4` |
| Run | `run-33b2777c3cbdb7d70efee4f752d094862079bbc4bcacd3316915ba7fa83a3b44` |
| Task | `task-b4cf5568860d3ec072adbbd1e73d9a6fe9e8155432ec8565b2507333ed30c4f5` |
| Attempt | `attempt-34af1c0fd1fa4c6a8865e99324c0de2b`, epoch 1 |
| Fingerprint RunIntent | `105305e5a734f360fa9ada6df7b632b4f15016aa792f2a9ebb8f7790c15c886a` |
| Przygotowany request SHA256 | `5ed9742ed885d30e879d5da72d02fdae358c5e723d03a792faf64c649f4df323` |
| Zachowany parent CAS SHA256 | `78c081976051b3681e186ca415404f8e0743875cba54ab5dd0f797b1e89624a9` — potwierdzony bez zmian |

Grupa: `fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1`.
Backend kompilował i uruchamiał aplikację w tym samym stałym kontenerze.
Nowy wrapper jest osobnym, interpretowanym narzędziem orkiestracji; nie stanowi
części powyższego snapshotu natywnego i nie wymaga jego ponownej kompilacji.

Dowody znajdują się w prywatnym control volume grupy, pod:
`verification/retained-current-h-only-20261102/accepted-store-v2/producer-dispatch-build/lock-scope-fix-build/public-retry-03/`.

- `request-validation.json`: 1979 zasobów zgodnych z hashami; identyczny fizyczny
  ProblemIR i execution plan; study plan różni się wyłącznie sprawdzoną tożsamością runu.
- `submission-and-materialization-regressions.json`: 17 lekkich testów PASS,
  hashe stabilnych źródeł, pełny log. Nie kompilowano testów Rust/C++.
- `terminal-and-budget-audit.json`: pełne zakończenie, profil, postęp i zwolniona
  rezerwacja; SHA256 `e220c22ae286ddd1f858b9083e00842c02cbd522050905b5abbeabaf777618f1`.
- Piny pojedynczych mutacji i logi CLI:
  `verification/accepted-submissions/80883511692b4a43e18371fdcc955493ab36f4caa3f8aa254e1dee9a23046bef/`.

## Naprawione uruchamianie

Publiczny CLI wykonuje Submit, a następnie osobny POST materializacji.
Odpowiedź Submit może przekroczyć 30-sekundowy timeout klienta mimo trwałego
przyjęcia runu. W tej próbie tak się stało. Odczyt kanonicznego GET potwierdził
projekt, run i fingerprint. Sam Submit nie tworzy katalogu zadań.

Dodano dwa jawne wejścia `just`, działające wyłącznie w zweryfikowanym backendzie:

1. `docker-dev-submit-accepted`: jeden publiczny `run-json --submit-only`.
2. `docker-dev-materialize-accepted`: zgodny GET runu, następnie tylko brakujący
   POST `/v2/persistence/projects/{project_id}/runs/{run_id}/materialization`.

Oba wymagają przypięcia udanego development attempt, konfiguracji, źródłowego
snapshotu, ścieżki requestu w `verification/` i jego SHA256. Materializacja
wymaga dodatkowo fingerprintu RunIntent. Istniejący resolver i walidator grupy
sprawdzają Compose, kontenery, sieć, źródła i receipt. Powłoka `just` rozpoznaje
pełną postać argumentów; nie przekazuje polecenia do `eval`.

Przed każdą mutacją powstaje osobny, trwały zapis zamiaru z wyłącznym utworzeniem.
Po timeout lub utracie klienta wrapper nie ponawia żądania. Dalsze rozstrzygnięcie
odbywa się odczytem dokładnie tego samego runu. Nie resetować tych zapisów ani nie
stosować nowego idempotency key jako obejścia nieznanego wyniku.

Rzeczywista materializacja odpowiedziała HTTP 200, catalog revision 1.
Preparer zakończył się kodem 0. Start workera z protokołem v7 przeszedł.
Cała próba używała FEM CPU double, bez magnetów, Relax i Run LLG.

## Audyt budżetu operatora

Parametry zachowują istniejącą politykę caller-supplied RT0 i profil
`volume_inspection_v1`. Wszystkie poniższe liczniki są bezwymiarowe; czas jest w s.

| Parametr | Wartość |
|---|---:|
| Komórki źródłowe Tet4 | 14 304 |
| Punkty Universe | 275 |
| Pary source–target | 3 933 600 |
| Dopuszczalne pary łącznie | 4 000 000 |
| `sqrt_calls` na punkt | 1 250 000 |
| `sqrt_calls` łącznie | 125 000 000 |
| Czas maksymalny punktu | 90 s |
| Czas maksymalny całości | 10 800 s |
| Czas odmowy operatora według profilu | 37,891 s |
| Ukończone punkty | 0 |

Minimalna praca potrzebna do ukończenia jednej ściany, nawet bez binary64:

- dwie obowiązkowe wysokie precyzje: 2 × 7 norm = 14 pierwiastków;
- akumulacja trzech wektorów fan w obu precyzjach: 2 × 3 = 6;
- trzy normy lokalnej różnicy precyzji: 3;
- dwie normy różnicy whole-face/fan: 2.

Łącznie co najmniej 25 pierwiastków na ścianę, 100 na Tet4.
To daje co najmniej **1 430 400 na punkt** i **393 360 000 łącznie**.
Obie wartości przekraczają obecne limity jeszcze przed doliczeniem binary64,
końcowej redukcji i serializacji. Zgodność limitu par nie dowodzi zgodności
wszystkich nazwanych limitów.

To dowód niespójności budżetu z rozmiarem źródła, nie identyfikacja pierwszego
przekroczonego licznika: obecny natywny błąd podaje tylko ogólną nazwę odmowy.
Nie wiadomo z zachowanego komunikatu, który licznik jako pierwszy wywołał wyjątek.
Nie wolno przedstawiać tych dolnych ograniczeń jako zmierzonego pełnego kosztu.

## Mapa źródeł

| Ścieżka i symbol | Rola |
|---|---|
| `scripts/docker_dev_submit_accepted.py::submit_once` / `materialize_once` | Jawne pojedyncze mutacje w tej samej grupie |
| `scripts/docker_dev_defaults.py::_discover_pins` | Istniejąca walidacja działającej grupy |
| `crates/fullmag-cli/src/accepted_run_transport.rs::submit_run_request` | Submit, timeout, osobna materializacja |
| `crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs::materialize_run` | Publiczny katalog zadań |
| `backends/fem/cpu/mfem/interactions/oersted/surface_rt0.cpp::Work::charge` | Odmowa nazwanej pracy |
| `backends/fem/cpu/mfem/interactions/oersted/surface_rt0.cpp::Arithmetic::norm`, `face_pass`, `FieldSum::add`, `evaluate_surface_rt0` | Naliczanie obowiązkowych pierwiastków |
| `backends/fem/cpu/mfem/interactions/oersted/surface_rt0.cpp::preflight` | Obecny preflight sprawdza pary i formuły, ale nie dolne ograniczenie `sqrt_calls` |

Audyt dotyczy realizacji FEM CPU operatora RT0. Nie jest dowodem parytetu FEM GPU,
FDM ani BORIS. Publiczny Python/ProblemIR i semantyka pola nie zostały zmienione.
Odniesienie fizyczne pozostaje w nocie 0950 w `docs/physics/`.

## Kolejność dalszej naprawy

1. Uzupełnić diagnostykę odmowy o konkretny licznik, wartość, limit i indeks punktu;
   zachować brak wyniku przy niepełnym obliczeniu.
2. Rozszerzyć preflight o pewne dolne ograniczenia obowiązkowej pracy, aby ten
   przypadek odmawiał przed kosztownym przygotowaniem i oceną.
3. Zmierzyć możliwość ponownego wykorzystania geometrii niezależnej od targetu,
   zachowując wszystkie precyzje, formuły, tolerancje i zakres wizualizacji.
4. Dopiero na podstawie pełnego budżetu rozstrzygnąć zmianę jawnego profilu
   obserwacyjnego. Zmiana wersjonowanej polityki wymaga osobnego konkretnego
   przeglądu; w tej pracy nie podniesiono limitów.
5. Po tej naprawie jedna nowa, jawna próba H-only; następnie odczyt artefaktu,
   wizualizacja Universe i niezależna kontrola pola. Kwalifikacja bazy, LLG i
   ilościowe odtworzenie publikacji pozostają osobnymi wymaganymi etapami.
