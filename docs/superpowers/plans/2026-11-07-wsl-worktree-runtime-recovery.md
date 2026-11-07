# Poprawna grupa worktree na WSL — plan implementacji recovery

> Dla wykonawcy: po przeglądzie planu zastosować wybraną metodę `executing-plans` albo `subagent-driven-development`; testy RED → GREEN i niezależne review przed integracją.

**Cel:** bezpiecznie zamknąć diagnostyczny backend uruchomiony omyłkowo w grupie `fullmag-master`, zakończyć zachowaną próbę worktree i uruchomić właściwą grupę worktree na WSL.

**Architektura:** pierwszy brak dotyczy pochodzenia dowodu awarii: wariant `resume` zachowuje terminal i identyczny bajtowo sidecar, a nowy wariant wymaga jawnych SHA-256 terminalu `development` i receiptu procesu oraz oryginalnych sidecarów producenta `process-failure.json` i `readiness-failure.json`. Drugi brak dotyczy ponowienia przygotowanej, lecz nieopublikowanej transakcji zamknięcia pierwotnej awarii sieci. Nowa generacja dowodów zachowuje poprzednie pliki i ponawia wszystkie obserwacje; nie wykorzystuje starego dowodu do publikacji. Wszystkie istniejące kontrole izolacji, fence, PID, cgroup, właściciela i konsumentów pozostają obowiązkowe.

**Technologie:** Python 3.10, `argparse`, `unittest`, projektowy `BuildControl` i Docker Compose. Bez kompilacji na hoście.

**Specyfikacja:** `AGENTS.md`, sekcje „Build i dowody” i „Docker Compose”; `docs/guides/fullmag-build-storage-governance.md`; istniejący kontrakt `scripts/docker_volume_stop_bootstrap.py`. Przypadek regresyjny: terminal `development/3bc5835768f4483fb5c92b26a14084b2`, historyczny owner Ready z buildu `914c04ac`, nowy pakiet `eeb1e1fc`, diagnostyczne API i brak procesu native service.

## Potwierdzone wejścia do recovery (7 listopada 2026)

Po ponownym `git fetch origin master` worktree i `origin/master` wskazują `eeb1e1fcf6070021ac902ee8ecb01268e2cea9b9`. Odczyt z istniejącego backendu potwierdził poniższe hashe; przed wykonaniem operacji trzeba ponowić obserwację i sprawdzić wszystkie piny, ponieważ zapis w planie nie zastępuje kwalifikacji runtime.

| Dowód | SHA-256 |
| --- | --- |
| Żywy `process-tree.json` oraz identyczny bajtowo `process-failure.json` producenta | `9ac02d9bab4aee0b5b76c226b2d2f13fb32b1daa23d6ec76eba64000c6639fcf` |
| `readiness-failure.json` | `3618aed8bc936f96fcd873b8da7292088e60c7cdf20269756e6eac384c9eec1d` |
| `terminal.json` próby development | `1bdff741ab6df08db5711842a7b1e3313c336ba3df31e428242dc871cae634ef` |

Potwierdzono `terminal.error == readiness.error` oraz dokładną kopertę `Runtime admission failed; services retained: ` + `process.error[:4096]`. Readiness wskazuje backend `0caf4a69afd6e1e9b09895e8f560152ca0c3489bb8979a2bc73e78ceed6d2906` i `StartedAt=2026-11-07T06:58:18.856436076Z`. Stan terminalu to `failed-confirmed`, a procesu `failed_outcome_retained`; żaden z nich nie jest dowodem native drain.

## Ograniczenia

- Wykonawca zmian: bieżący agent; źródła: worktree `regional-physics-fixes`, branch `codex/regional-physics-fixes-20261106`.
- Build i docelowy runtime: wyłącznie `fullmag-worktree-fullmag-eacd36ead0850e14`, z własnym portem i prywatnym wolumenem. `fullmag-master` służy teraz wyłącznie do odczytu i kontrolowanego zamknięcia omyłkowo uruchomionych usług.
- Nie usuwać `OWNER.json`, markerów, sesji, wyników ani lease. Nie wytwarzać sztucznego terminalu `resume` i nie zmieniać stanu native execution z Unknown na Drained.
- Nie pomijać ani nie osłabiać kwalifikacji obcych mountów. Nie nadpisywać istniejących przygotowanych dowodów i nie ponawiać transakcji, która rozpoczęła publikację CAS.
- Stop obejmuje dokładnie przypięty diagnostyczny backend, po ponownej obserwacji pod blokadą. Jawne `--stop-frontend`, dostępne wyłącznie w nowym wariancie, zatrzymuje także dokładnie przypięty frontend po potwierdzonym stopie backendu. Nie usuwa kontenerów ani danych.
- Po stopie main pozostaje zatrzymany z zachowanymi danymi i stanem native execution Unknown. Plan nie uruchamia replacement main, nie deklaruje archiwizacji ani genuine drain tego historycznego namespace.
- Istniejące dane i cudze zmiany są chronione. Zgoda użytkownika obejmuje zatrzymanie Overleaf i usunięcie martwych aliasów we wskazanym katalogu; nie obejmuje innych grup.

## Ryzyka do sprawdzenia

1. Pomieszanie pochodzenia `development` i `resume`: wzajemnie wykluczające się argumenty; zachowany obowiązek sidecaru dla `resume`.
2. Podrobiony lub niepasujący terminal: dokładne SHA-256, faza, stan `failed-confirmed`, source, Compose, image, cgroup, ID i inkarnacja backendu.
3. Zmiana procesu/fence podczas operacji: identyczny fingerprint przed blokadą, pod blokadą i bezpośrednio przed sygnałem stop.
4. Działający native owner, scheduler, sesja lub dodatkowy konsument: bezwarunkowa odmowa zgodnie z istniejącym probe.
5. Wynik stopu udający drain: wymagane zachowanie starego ownera i raport `shutdown_unknown`; dalsze archiwizowanie tylko istniejącą zarządzaną receptą.

## Zadanie 1: dowód pochodzący z bezpośredniego startu

**Pliki:** `scripts/docker_dev.py`, `scripts/docker_volume_stop_bootstrap.py`, nowy `scripts/test_docker_volume_stop_bootstrap.py`.

**Interfejs CLI:** istniejące `--resume-attempt <uuid>` albo nowe `--development-terminal-sha256 <sha256>` wraz z `--process-receipt-sha256 <sha256>`. Nowy wariant opcjonalnie przyjmuje `--stop-frontend`; użycie tej flagi z `resume` powoduje odmowę. Brak, mieszanie lub niepełne piny powodują odmowę. `--attempt`, `--config-sha256`, `--source-root` i `--port` zachowują znaczenie.

**Interfejsy wewnętrzne:** `_validate_failure_origin(args) -> str` zwraca wyłącznie `resume` albo `development`. `_validate_development_failure(args, control, selected, previous, inputs, terminal_raw, process_raw) -> dict` dostarcza jawne `failure_origin` (faza, próba, ścieżka terminalu i obu sidecarów, ich SHA oraz SHA procesu) oraz istniejące piny image/container/start-time/cgroup. `_load_pins` i `_probe_evidence` używają wspólnego `failure_process_raw`. Oba warianty wymagają oryginalnego sidecaru procesu producenta identycznego bajtowo z żywym receiptem; po stopie ten sidecar pozostaje niezmieniony. Receipt v1 dla `resume` pozostaje zgodny; bezpośrednia awaria otrzymuje receipt v2 z jawnym `failure_origin`, bez pól udających resume.

- [x] Dodać test RED poprawnego bezpośredniego terminalu i procesu odpowiadającego faktycznej awarii; uruchomić `python3 -B -m unittest discover -s scripts -p test_docker_volume_stop_bootstrap.py -v`.
- [x] Dodać odmowy: zła faza/stan/error, inny source/config/image/container/start-time/cgroup, niezgodny terminal SHA lub process SHA, pomieszane warianty oraz brak któregokolwiek wymaganego sidecaru.
- [x] Znormalizować pochodzenie awarii. Dla `development` wymagać `terminal.error == readiness-failure.error`, dokładnych ID/start-time backendu w readiness sidecarze i dokładnej koperty producenta `Runtime admission failed; services retained: ` + `process.error[:4096]`. Nie wymagać nieprawidłowego `terminal.error == process.error`. Pełny process/fence nadal musi spełniać `_matches_target_build_failure`. Inne odmiany awarii pozostają poza tym wariantem.
- [x] Dodać regresję rzeczywistej różnicy komunikatów i limitu 4096 znaków. Zachować wszystkie oryginalne sidecary i uwzględnić ich hashe w fingerprintach oraz kontroli po stopie.
- [x] Zachować dotychczasowy receipt dla `resume`; dla bezpośredniej awarii zapisać jawne pochodzenie `development`, bez pól udających resume. Nie zmieniać runtime probe ani jego wymagań.
- [x] Dla jawnego `--stop-frontend` ponownie sprawdzić ID/image/start-time i pełny zbiór konsumentów po zatrzymaniu backendu; zatrzymać wyłącznie frontend tej samej grupy przez Compose. Potwierdzić zatrzymaną inkarnację i zachowanie danych; nie zgadywać wyniku po timeout. Dodać odmowy dla zmiany inkarnacji, błędnego wariantu i niejednoznacznego wyniku.
- [x] Uruchomić testy GREEN oraz istniejące testy `test_docker_volume_stop_diagnostic.py`, parsera `test_docker_dev_up.py` i statyczne sprawdzenie diffu.

## Zadanie 2: wznowienie przygotowanej transakcji awarii sieci

**Pliki:** `scripts/docker_volume_network_failure_reconcile.py`, `scripts/test_docker_volume_network_failure_reconcile.py`.

**Stan regresyjny:** próba `21294d69464d4230a09574eb9ea79649` zachowała `unknown-receipt.json` oraz komplet `reconciliation/{network-failure-proof,result,prepared}.json`. SHA przygotowania: `e8a9ff00fcfb220418b90e6869f6483d9ab809d802a6f534b89eeae9e4334a73`. Ostatnia obserwacja wykryła zmianę obcego bind mountu, więc terminal nie został opublikowany. Oryginalny helper nadal posiada blokadę.

**Interfejs CLI:** opcjonalna kompletna para `--resume-prepared-sha256 <sha256>` i `--recovery-id <32 lowercase hex>`, obok istniejących pinów pierwotnej próby. Brak pary zachowuje obecne wymaganie pustego przygotowania.

**Interfejsy wewnętrzne:** `_load_prepared_recovery(control, args, original_raw) -> dict | None` waliduje poprzednie przygotowanie i jego pełne powiązanie z oryginalnym receiptem, compose, proof i result. `_publication_paths(attempt, recovery_id=None) -> dict[str, str]` wyznacza wyłącznie dozwolone ścieżki. Nowa generacja trafia pod `reconciliation/recoveries/<recovery-id>/`; wynik wiąże `recovery_id` i SHA poprzedniego przygotowania. `_cas_script` sprawdza także poprzednie przygotowanie i świeżą generację przed publikacją do niezmienionych kanonicznych ścieżek receipt/current/terminal.

- [x] Dodać test RED obsługi kompletnego przygotowania przed CAS oraz odmowy dla złych hashy, nonce, niekompletnego zestawu i niezgodnej próby/projektu/engine.
- [x] Dopuszczać wyłącznie zachowany oryginalny receipt, brak current/verified/terminal i brak pliku blokady CAS. Każdy ślad rozpoczętej lub częściowej publikacji pozostaje odmową wymagającą osobnej diagnozy.
- [x] Sprawdzić hashe wszystkich poprzednich plików, tożsamość niezmienionego oryginalnego helpera i oryginalnej blokady. Starego wyniku nie publikować ani nie modyfikować.
- [x] Zweryfikować przygotowanie przed pierwszą obserwacją i przekazać dokładne `allowed_archive=original_raw` do wszystkich trzech wywołań `_observe` tej ścieżki. Test musi zaczynać od istniejącego kompletnego przygotowania i dochodzić do CAS świeżej generacji; brak zaakceptowanej kopii archiwalnej nadal powoduje odmowę.
- [x] Powtórzyć dwie pełne obserwacje oraz trzecią bezpośrednio przed CAS, z identycznymi dotychczasowymi kontrolami Windows/WSL i konsumentów. Nowe dowody i wynik zapisać niezmiennie pod nowym nonce.
- [x] Przed CAS sprawdzić zarówno piny starego przygotowania, jak i nowej generacji. Oryginalny helper pozostaje jedynym procesem zwalniającym `active` po publikacji terminalu.
- [x] Dodać testy zmiany dowodów przed CAS, kolizji nonce, częściowej publikacji i zachowania wszystkich oryginalnych plików. Sprawdzić również niezmienioną świeżą ścieżkę bez wznowienia.
- [x] Uruchomić `python3 -B -m unittest discover -s scripts -p test_docker_volume_network_failure_reconcile.py -v` i kontrolę diffu; zachować wykonywalną regresję.

## Zadanie 3: integracja i wykonanie

**Pliki:** `.github/workflows/bootstrap.yml`, `docs/guides/docker-development-architecture.md` oraz ten plan.

- [x] Dodać testy do istniejącej bramki Python CI i opisać oba warianty recovery oraz obowiązkowe dowody.
- [ ] Przeprowadzić niezależne review, zapisać spójny commit i wypchnąć branch/PR do `master`; zachować wymagane kontrole.
- [ ] Użyć nowej recepty z `--stop-frontend` do kontrolowanego zatrzymania obu usług diagnostycznego `fullmag-master`, potwierdzając zachowanie ownera, sesji, lease i namespace. Zachować istniejące dane main oraz jego pakiet/rollback; w rejestrze pozostawić native execution Unknown i warunek ponownej kontroli przed przyszłym recovery main. Nie uruchamiać main ponownie i nie zgłaszać jego archiwizacji ani genuine drain.
- [ ] Zamknąć starą nieudaną próbę worktree rozszerzonym reconcilerem z jawnymi pinami przygotowania i nowej generacji dowodów z zadania 2, po pełnej kwalifikacji. Nie ponawiać pierwotnego `--apply` nad istniejącym przygotowaniem ani nie uruchamiać nowej próby nad aktywną blokadą.
- [ ] Uruchomić `just docker-dev-toolchain` i `just docker-dev` z katalogu worktree, z jawnym worktree/source, osobnym wolnym portem, wymaganym GPU i kontraktem `fem-demag-poisson`.
- [ ] Sprawdzić receipt, rzeczywiste mounty/etykiety obu usług, API, natywny kontrakt i zarządzany browser QA `--canvas-only`. Dopiero te wyniki kwalifikują docelową grupę worktree.
- [ ] Potwierdzić integrację kodu na `master`, wykonać adekwatną retencję i zapisać faktyczny stan oraz ewentualne aktywne zasoby w rejestrze.

## Integracja z kontraktem group-local P22

Po scaleniu zakres obserwacji tego initial-failure recovery obejmuje logicznych konsumentów własnego projektu i wolumenu oraz bezpośrednie bindy. Zatwierdzony kontrakt P22 zastępuje w tej ścieżce wcześniejsze wymaganie fizycznej kwalifikacji cudzych mountów. Wznowienie przygotowanej generacji wymaga nadal tego samego żywego helpera i nie łączy się z `--recover-absent-helper`. Stara generacja pozostaje niezmienna; świeża generacja i kanoniczne publikacje przechodzą pod wspólnymi blokadami transakcji. Testy scalonego kontraktu: 38/38; direct bootstrap stop: 6/6.
