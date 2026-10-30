# Recovery input identity — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for the bounded implementation tasks below.

**Cel:** recovery odtwarza dokładny authored input zapisany w RunIntent, dzięki czemu terminalny Stop zamyka się w tym samym dzienniku i UI. Zachować aktywne sesje, wyniki oraz wszystkie grupy innych zadań.

**Architektura:** nowy RunIntent zachowuje authored SceneDocument w definicji projektu, a wyprowadzony execution profile pozostaje w niezmiennym Study/ExecutionPlan. Historyczny dokument z automatycznie dopisanym dokładnym profilem `legacy_live_execution_profile()` może zostać odtworzony bez tego pola wyłącznie wtedy, gdy pełny versioned input identity staje się identyczny z pinem RunIntent. Bez wyłączania digestów, scene/session/run fence ani ręcznej edycji katalogów i dzienników.

**Technologie:** istniejące Rust API/SessionStore, Docker Compose, HTTP v2 oraz przeglądarka Control Room. Bez zmiany schematu OpenAPI ani fizyki.

**Specyfikacja:** bezpośrednie polecenie użytkownika oraz operacyjny raport `recovery/master-20261028/stop-diagnosis.md`; kontrakty `docs/specs/command-lifecycle-v1.md` i SceneExecutionInputIdentity.

## Ograniczenia

- Jeden branch `codex/recovery-input-identity-20261028`; aplikacja narzuca managed ext4 worktree `/home/kkingstoun/.codex/worktrees/recovery-input-identity-20261028/fullmag`.
- Żadnego zatrzymywania innych grup ani implicit Solve/Compute. Build aplikacji wyłącznie w grupie wybranego checkoutu.
- Nie kompilować lokalnie testów jednostkowych. Regression cases pozostają wykonywalne; dotychczasowa autoryzowana bramka GitHub CI oddzielona od lokalnego buildu aplikacji.
- Nie zmieniać istniejących RunIntent/CAS/dzienników w miejscu. Bieżącej sesji mastera nie zastępować testowym modelem.

## Ryzyka do review

- Jawnie zadany profil domyślny musi pozostać jawny, jeśli zgadza się z pinem.
- Zmieniona geometria, materiał, stage/runtime/output albo dowolny inny input nadal musi być odrzucony.
- Historyczne sceny bez versioned identity nadal wymagają dokładnej revision; nie wolno zgadywać ich authored input.
- Nieprawidłowy schema/digest nie otwiera ścieżki kompatybilności.
- Projekcja Stop nadal wymaga dokładnego run/session i dowodów anulowania wszystkich zadań; nie omijać naukowych guardów.

## Kroki

- [x] Zapis źródłowego authored SceneDocument zamiast effective clone w nowo materializowanym projekcie.
- [x] Wspólny helper recovery: najpierw dokładna walidacja, potem jedyna dopuszczona rekonstrukcja historyczna z pełnym porównaniem digestu. Wywołanie przy odczycie niezmiennej definicji przed publikacją API.
- [x] Regression cases: nowa scena, profil migrowany, profil jawny/custom, zmiana fizyki, malformed pin, legacy revision; odzyskany input przechodzi istniejący terminalny Stop projector i journal completion.
- [ ] Review diffu, adekwatna weryfikacja źródłowa i CI, commit → PR → wymagane kontrole → merge → FF master.
- [ ] Bezpieczne wdrożenie zarządzaną ścieżką z zachowaniem istniejącej sesji i wyników; weryfikacja Stop w izolowanej kopii/teście bez mutacji naukowych mastera.
- [ ] Niezależna kontrola FDM H_demag w powietrzu: najpierw istniejące dane i Ms=0/full-domain, potem screenshot/WebGL; żadnego obliczania bez potrzeby.
- [ ] Receipty, raport i kwalifikowany cleanup własnych zasobów. Jeżeli app blokuje archiwizację aktywnego primary worktree, zachować go i opisać konkretny powód.

## Checkpoint po przerwaniu Docker Desktop

- Pierwszy commit implementacji: `0dfbb69bfafb2cf3a718eb44fc4b7260e5806f17`;
  synchronizacja mastera i poprawka kompilacji testu: `493604b6390e2bb7db03dd7cc9591ff313c13e19`.
- W CI regression `recovered_legacy_profile_completes_stop_in_snapshot_and_durable_journal`
  przeszedł. Uruchomienie pełnego filtra ujawniło nieaktualne oczekiwanie tekstu błędu
  w istniejącym teście failed-run; dopasowano je do obecnego szczegółowego komunikatu.
- Obie usługi mastera zakończyły się kodem 255 podczas przerwy Desktop/Engine.
  Bieżąca sesja zawiera dwie sfery, 18 runów i run oczekujący bez Solve. Kontrola
  46 pinów po przerwie nie wykazała zmian.
- Dawny isolated snapshot przy zwykłym wznowieniu wskazywałby poprzedni model.
  Dodano jawny successor verified-copy po potwierdzonym admission poprzednika;
  nowe piny obejmują natywne admission oraz current/verified/terminal poprzednika.
  Kontrole źródłowe i niezależny review przeszły. Podgląd runtime potwierdził
  16 runów terminalnych, 2 held-manual i 1272 pliki; nie wykonał kopii ani startu.
- Własna grupa testowa zbudowała pakiet, lecz nie ukończyła hostowego Linux admission.
  Pozostał lease po zniknięciu launchera. Odrębna, ścisła ścieżka fail-only reconciliation
  ma zachować certyfikat, owner, pakiet i wszystkie dane; dopiero potem wolno wznowić build.
- Integracja, native admission, Stop w przeglądarce i widoczny H_demag w pustych
  komórkach aktualnego renderera nadal wymagają dowodów runtime.

## Checkpoint integracji i diagnostycznego poprzednika

- PR #316 scalony jako `9c6253fd81b94781a2969bb22643bac02dd5f70b`.
  Wszystkie trzy workflow dla head `f19e5863d5f5d3a4cebe47e6c6c97e37b4fa5aea`
  przeszły; niezależny review bez pozostałych P1/P2.
- Lifecycle i Git MAIN należą do skoordynowanego właściciela mastera. Jego
  aktualny failed-confirmed terminal nie zawiera ID usług. Oddzielny adapter
  przyjmuje wyłącznie jawnie przypięty typed journal bezpiecznego Stop i uzupełnia
  brakujące ID w pamięci. Oryginalne dokumenty pozostają niezmienione i przypięte
  do CAS; każda obserwacja pary sprawdza również jej inkarnację.
- Testy adaptera i integracji: 54 Python regression cases, exit 0; niezależny
  review bez P1/P2. Realny journal przeszedł preflight, a pełny readonly preview
  potwierdził 16 terminalnych i 2 held-manual runy bez kopii, startu ani Solve.
  Apply i ponowny start pozostają u właściciela grupy.
- Własna grupa 3318 zakończyła build aplikacji i admission na f19. Zwykły recreate
  zachował historyczny held run, ale nie publikuje go automatycznie jako bieżącej
  sesji. Nie zastępuje to testu odtworzonego Stop w UI; nie odtwarzać skryptu w celu
  udawania tej weryfikacji. Publiczny test nowego Stop i FDM jest osobnym dowodem.
