# GSG: wynik publikacji profilu i jednej próby V/J/H — 7.11.2026

## Wynik odbioru

Profil exec:default@1 opublikowano bez zmiany definicji. Dokładnie jedno nowe zgłoszenie V/J/H zostało przyjęte; zadanie osiągnęło succeeded. Zachowany wynik odczytano przez publiczne API bez powtórzenia transportu lub pola. Nie potwierdzono reprodukcji publikacji ani kwalifikowanej bazy do LLG.

| Kontrola | Wynik |
|---|---|
| Profil | HTTP201, rewizja1, defaults{}; katalog zgodny |
| Submit | Dokładnie1; CLI timeout po31,102s, przyjęcie potwierdzone GET i fingerprintem |
| Materializacja katalogu tego samego runu | Dokładnie1, just docker-dev-materialize-accepted, exit0/HTTP200 |
| Solver | FEM CPU/double/strict; task succeeded; worker exit0 |
| Siatka źródła |34243Tet4/12589węzłów, gotowe przygotowanie, bez nowego meshowania |
| Nośnik H |20węzłów/24Tet4;20/20targetów |
| Pakiet |124406331B; zapisany CAS i publiczny solution_set revision2 |
| Odczyt |11wybranych payloadów; SHA/długości, skończone V/J/H, bitowa normalizacja H/I — PASS |
| Domknięcie zasobów | Worker zakończony, exit receipt istnieje, kolejka pusta; solver reservation nadal quarantined |
| Nauka | NOT VERIFIED; bez nowego LLG, odpowiedzi fal spinowych i reprodukcji publikacji |

Nie było buildu, restartu, nowego H-only, retry Submit, zwiększenia limitów lub zmiany historii wcześniejszych prób.

## Tożsamość

- Worktree:/home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011.
- HEAD przed operacją:661a3cb2d3013d8b0588cef2a9ab15b82658d990.
- Native snapshot:42d570eca01aac3227a40056198a15605b983bd5b669b1530818f2ce694fd23a.
- Request:50b1accd824a7e1fec5e64bea44ad347de5b088f282a2f7c542a21c9cfb051eb.
- Run:run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e.
- Task:task-902544fbad21c9da53757ca22786517f6866733c15a4e24dd380524b0c4cd859.
- Attempt:attempt-b7eaad04933643379cd377462f2899b6, ownership_epoch1.
- Payload fingerprint:eb99dec34c8d57a5b733cba4ecaf61e0c8d63b48a61220768db9eb097af33135.
- Pakiet CAS:f3974e680be1fb2b039d41beddf8d2bff62dfa941b01ec2aba92754d6dd1a645.
- Przyjęty potencjał:3e825a6e3346495727767318c93c0f368071041ac62e8e8ed596322905795d9f.
- Przyjęty prąd RT0:008fb7903740ac82fa98037e8b34fb41f12bbc7fc46ce89edb52a7385028843b.
- Certyfikat:a5246c9d878743700dfd0fe5f02563626a672d27bad5bf1d57f541d9a1c95509.
- Solution_set:solution-ec3ff57de86a03259fae6ae6acf46efb3d45a77b87b6ed8bc9f571b3c9b36e1d, revision2.

Publiczny odbiór metadanych wykonał istniejącą kontrolę full_cold_bundle. Osobno pobrano11/22payloadów: V, Jcenter, Jlocal, H, H/I, punkty H, certyfikat, dowód całkowania, komórki, przewodność i stabilne ID. Nie deklarujemy osobnego pobrania wszystkich22payloadów. Potwierdzono wspólnego ownera, wiązanie H z przyjętym prądem, jednostki, długości, SHA, skończoność danych i bitową normalizację H/I.

## Odczytane liczby

| Wielkość | Wartość |
|---|---:|
| Zadany skok potencjału |0,001V |
| Zmierzony skok |0,0010000000000000007V |
| Prąd źródła |17,54421457522968µA |
| Maksymalna norma H na20targetach |24,46142348189356A/m |
| Maksymalna norma J w środkach komórek |1508464190,4848983A/m² |
| Residual ładunku |2,0626810745826558e-14 |
| Maksymalny residual bilansu komórki |8,470329472543003e-22A |
| Skok strumienia ściany / strumień zewnętrzny |0A /0A |
| Scaled KKT residual |2,5290153026060407e-20 |
| Ranga |34260przy34261wierszach i1pominiętej zależności |
| Pary źródło–target / kernel evaluations |684860 /26279328 |
| Niezbieżne pary całkowania |0 |

Ostatni zegar fazy publikacji wynosi983,979s, około16,4min. Nie jest to pełny czas od Submit do trwałego exit receipt; proces zakończył się później. Najdłużej obserwowano rekonstrukcję J.

Plan operacyjny opisał1CPU/4GiB jako zasoby próby, ale request zawierał je jako minimum, nie twardy limit. Istniejący scheduler przydzielił3CPU,5637144576B RAM i7516192768B storage. Nie zmienialiśmy polityki ani limitów kontenera. Requested i resolved należy raportować osobno; nie deklarujemy wykonania ograniczonego do1CPU/4GiB.

## Analiza korekty prądu

Istniejący scripts/antenna_gsg_current_correction.py::weighted_rt0_h1_correction wykonano na uwierzytelnionych, publicznie odczytanych V/J, komórkach, przewodności i stabilnych ID. To postprocessing Decimal120,23,133s, bez Solve.

- η=0,03464604656814306.
- Energia korekty=2,1084481126176998e-11W; energia H1=1,7565299056355858e-8W.
- Wszystkie34243komórki rozliczone.
- Wcześniejsza globalna50nm:η≈0,03496045; spadek około0,90%.
- Iloraz do wcześniejszej75nm≈0,90487: pomocnicze porównanie, nie nowa prerejestrowana seria.

Nowa siatka ma bulk75/local50nm w połączeniach; nie jest kolejnym globalnym poziomem50nm. Niewielki spadek η nie usuwa wcześniejszego FAIL kontrakcji0,913>0,8. Pole w20punktach nie jest gęstą mapą całej próbki. Nie wykonano nowych niezależnych referencji H. Brak podstaw do deklarowania zgodności z Fig.3 lub wzbudzenia fal spinowych.

Wartość correction_norm_mw w certyfikacie nie jest bezpośrednio η. Raport odczytu używa dokładnej nazwy z backends/fem/cpu/mfem/transport/conservative_current_view.cpp::encode_balance_certificate. η wyliczono osobnym istniejącym estymatorem.

## Timeout, blokady i pozostały problem runtime

CLI wykonał Submit tylko raz. Po timeout GET potwierdził dokładnie project/run/payload_fingerprint i pending_materialization. Jedna istniejąca materializacja katalogu pozwoliła wykonać to samo zgłoszenie. Oba fence zachowano.

Przy wielokrotnych HTTP500 potwierdzono konflikt shared-read z aktywnym writerem. Rozważone kierunki:1)ograniczony ponowny GET po oczekiwaniu — zastosowany, uzyskano200;2)skrócenie sekcji zapisu;3)rozdzielenie odczytu bieżącego runu i archiwum;4)ograniczone oczekiwanie na shared-lock w API. Kierunki2–4wymagają osobnego przeglądu kodu i regresji. Nie zmieniano ochrony. Semantykę sprawdzono w [dokumentacji Rust File](https://doc.rust-lang.org/std/fs/struct.File.html); lokalną przyczynę potwierdza crates/fullmag-session/src/writer.rs::ReadTransaction::acquire.

Worker PID179373nie istnieje; trwały worker_process_exit_receipt.v1 potwierdza exit0/status_success, bez timeout lub żądania stop. Kolejka pusta. Host ledger nadal ma solver reservation=quarantined; przygotowanie=released. Pełny log schedulera wskazuje worker_error_after_task_settlement: release exact worker resource lease after terminal exit: session store writer is busy.

Succeeded i pusta kolejka nie dowodzą zwolnienia tej rezerwacji. Nie wykonano recovery, ręcznego release, restartu lub usuwania. To problem odrębny od zapisanego wyniku i wymaga domknięcia przed kolejnym uruchomieniem.

## Dowody i dalszy krok

Control volume grupy3203: verification/gsg-junction-solve-20261107/.

Dowody: approved-profile-publication.json, profiles-after-approved-publication.json, approved-managed-submit-recipe.json, approved-managed-materialization-recipe.json, terminal-run-observation-2.json, terminal-inspection-catalog-2.json, accepted-inspection-metadata.json, public-vjh-readback.json, current-correction-analysis.json, post-solve-settlement-readback.json, host-reservation-post-solve.json, final-solutions.json, progress-observations.jsonl.

Następny krok naukowy: ocena wpływu siatki połączeń i dalsza kwalifikacja przy zachowanych kryteriach. Następny krok operacyjny: domknięcie dokładnie tej rezerwacji po pełnym preview. Zgoda na jedną próbę została wykorzystana; dalszego Solve nie wykonano. Odtworzenie publikacji pozostaje priorytetem i nie jest ukończone.
