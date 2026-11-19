# Trwały odbiór control i pełne zapisane Universe — 27.10.2026

## Wynik etapu i ograniczenia

Poprawiono atomowość przyjmowania Heartbeat/Stop; zarządzany build i start API przeszły. Po restarcie rzeczywisty klient, hook zasobów i adapter viewportu odczytały niezmienione V/J/H. Nie uruchomiono nowego Solve, nie zmieniono historycznego Failed na Succeeded i nie nadano bazie kwalifikacji fizycznej.

Pięć nowych testów Rust pozostaje **niekompilowanych i nieuruchomionych** zgodnie z zakazem repo. Nie ma jeszcze deterministycznego dowodu kontencji na nowym runtime. Parsowanie, review i build nie zastępują takiego dowodu. Browser/WebGL oraz screenshoty UI nadal **NOT VERIFIED**.

## Przyczyna i poprawka

Journal pełnej próby `run-5654db21201dd6c660f7ecae78baf8588477fe2a7d90480d9d64b30e4d050080` zawiera ostatni HeartbeatAck685 o 07:30:30 UTC, pending command688/lease heartbeat686 i brak jego ACK. Native ukończył obliczenie; Completing zapisano 07:46:54, a Failed z StoreWriterBusy 07:46:59. Kolejność journalu, inboxu i źródeł wskazuje wyczerpanie writera między pending a applied w pętli control. Nie ma osobnego stack trace, więc nie przypisujemy konkretnej instrukcji CPU. Główny publisher miał już własny writer i retry; nie dodano kolejnego.

`crates/fullmag-runtime-control/src/worker_inbox.rs::DurableWorkerInbox::receive_control` dopuszcza tylko Heartbeat/Stop, nabywa writer własnego `self.store` przed zmianą inboxu i zachowuje go przez pending → krótki efekt w pamięci → applied. Wewnętrzne transakcje używają tego samego uchwytu/threadu. `crates/fullmag-api/src/accepted_study_worker.rs::consume_worker_control_commands_with_inbox` korzysta z metody w dwóch miejscach. Guard jest zwalniany przed osobnym ACK writerem.

Claim, ID, sequence, lease heartbeat, stary pending, replay, Start/Prepare/Release, osobny ACK i limit 120 s pozostają bez zmian. Nie powtarza się automatycznie całego consume, solvera ani niepewnego efektu. Poprawka usuwa okno konkurencji między dwoma checkpointami tych krótkich efektów; nie gwarantuje uczciwości flock ani powodzenia przy blokadzie przekraczającej istniejący limit.

## Build i zachowanie danych

Recepta: `just docker-dev-restart-idle` w istniejącym worktree WSL i grupie `fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1`, port3203, z przypiętym attempt/config i dotychczasowym grantem `FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples`.

- Attempt: `0c57357ce1f04d47b62a3cd0b6024569`, succeeded.
- Baza: `2b831cbc1315721141970963691332c2415d678f`, snapshot `20a4d87f97ed3497dd1d084ae73c77b6acf473e3cd5ef0ab48cb13fca1041576`.
- Te same kontenery backend `cc32cb682ae5` i frontend `0dacc07deb1e`.
- Oba skompilowane pliki mają dokładnie hashe z review/source-freeze; nie opieramy tego wyłącznie na numerze commita dirty pakietu.
- Scena i logiczna sesja identyczne; wszystkie 43 katalogi runów, 1391 plików pełnej próby i dwa pliki odzyskanego SolutionSet identyczne.
- Nowa instancja API `dde9c87e-feaf-4fe5-86d4-e2a316978e50` obsłużyła 15 rzeczywistych GET metadanych/geometrii/topologii/supportu/FMDS. H1145×3, V677×1, J7424×3; wszystkie f64 mają SHA256 identyczne z oryginalnym bundle.
- Bufory: 1145 strzałek H, zero dla skalarnego V, istniejący limit2048 dla J. SSR bez żądań, brak dodatkowych żądań podczas250ms bezczynności i odrzucenie obcego layoutu.

Nowe połączenie diagnostyczne do WSL przejściowo zgłosiło WSAETIMEDOUT podczas buildu. Zachowany handle launchera nadal działał; odczyt tego samego kontenera przez Windows Docker potwierdził running/bezOOM, a potem Ready. Nie restartowano WSL ani buildu. Po zakończeniu dostęp WSL wrócił. Nie ustalono przyczyny tego przejściowego problemu transportu.

## Pełna siatka i wspólne próbki

Odczytowa kontrola istniejącego `verify_antenna_universe_result.py::read_inputs` oraz `compare_payloads` potwierdziła wszystkie1145 współrzędnych wraz z kolejnością oraz6428 Tet4 zamrożonego Global. Wszystkie sześć tablic źródła V/J/geometrii/ID/przewodności i20 wspólnych H są bajtowo identyczne z wcześniejszym udanym runem `run-bb36bd56d49ba6da9201623cd8d5566f141e292f0c7d474e4c9f897c0cebb6a1`.

Jest to kontrola kompletności/reprodukowalności odzyskanych danych. Nie zastępuje niezależnego orakla fizycznego ani statusu succeeded pełnego zadania. Zapisana ocena pozostaje **Unassessed**.

## Dowody

W backend control volume:

- `verification/normal-inspection-publication-contention-20261027/`: historyczny journal/inbox, raport przyczyny i source-freeze. Patch SHA256 `ad7b1f90e2cbecb4b7270cfc7e51331ad72c76d44f9cdccf03cfb55c19711cf8`.
- `verification/worker-control-atomic-receive-20261027/`: review(0Required/0Optional), prebuild-state, state-before-build i postbuild-verification.
- `iteration/attempts/0c57357ce1f04d47b62a3cd0b6024569/`: terminal, provenance i backend-build-receipt.
- `verification/recovered-universe-frozen-parity-20261027/report.json`: PASS, SHA256 `89e1689457d58880ef6fe22d56c7adcf797ceb43b13e27269dbd2d5aa619169c`.

W frontend volume: `verification/worker-control-cold-saved-fields-20261027/verify.mjs` i `report.json` — odczyt po restarcie, bez mocków i bez Solve. Wcześniejsze raporty zachowano w odrębnych katalogach.

## Retencja

Brak skilla `fullmag-build-stage-cleanup` w bieżącym repo; zastosowano zasady governance. Przed buildem zero aktywnych lease/procesów solvera, dwa historyczne Accepted/blocked bez attemptu pozostawiono bez zmian. Zachowano cache, bieżący pakiet, rollback, wyniki i dowody; nie wykazano zbędności konkretnej generacji. Bez prune/usuwania. Docker VM free:333779415040 →331179905024B. Named volumes nie stanowią quota; ogólna kwalifikacja retencji nadal NOT VERIFIED.

## Kolejne wymagania pełnego planu

Accepted compiler odrzuca FieldBasis przed Submit, mimo że ścieżka skryptowa oraz loadery/projection/waveforms istnieją. Brakuje typed accepted handoff FieldBasis→kolejne etapy i rzeczywiście kwalifikowanego publicznego assetu E3–E5. Synthetic ledger fixture nie kwalifikuje fizyki. Nie promować odzyskanego inspection H do bazy LLG.

Użytkownik zlecił pokazanie przekroju poprzecznego w UI. Następny krok to zapisane H → wspólne próbkowanie Tet4 → istniejący widok2D/Inspector, z regulowanymX i jawnymi jednostkami, bez przypisania do obcej sceny live i bez nowego Solve.
