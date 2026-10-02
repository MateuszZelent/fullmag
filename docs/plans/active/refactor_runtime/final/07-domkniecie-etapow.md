# Domknięcie etapów P1, P3, P3a i P5

Checkpoint 02.10.2026. Celem jest pełny odbiór istniejących etapów, bez
przenoszenia brakujących wymagań do innego etapu ani podnoszenia procentów
na podstawie samego źródłowego przyrostu.

| Etap | Najbliższy wymagany odbiór | Stan bieżący |
|---|---|---|
| P1 | Fizyczny Open/Save/Close w Tauri, recovery po awarii oraz startup bez blokowania edytora | Native UI niedostępne w tym hoście; historyczne browser/CLI/Python receipts zachowane. Modal nadal blokuje przygotowanie. |
| P3 | Procesowy publiczny `run-json`, pełny accepted flow FEM i transport cross-host | Produkcyjny build 197 zgłoszony z dokładnego commita; odbiór runtime otwarty. |
| P3a | Stale-scope runtime, przełączenia A→B, ownerzy adapterów zgodności | Dodana bramka ośmiu operacji workspace w prywatnym smoke API; regresje skryptu PASS, runtime NOT VERIFIED. |
| P5 | Accepted state/checkpoint/steering dla wymaganych adapterów i realizacji | Proste FDM mają wcześniejsze dowody; FEM, coupled/Frozen Spins, ogólne batch quantities oraz wymagane rekwalifikacje pozostają otwarte. |

Wskaźniki 98/94/90/99% są wcześniejszymi szacunkami implementacji. Nie są
odsetkiem wykonanych bramek ani wskazaniem małego kosztu pozostałej pracy.
Żaden z tych etapów nie został w tym checkpointcie odebrany w całości.

## Bramka P3a workspace

`scripts/verify_project_api_runtime.py` w istniejącej ścieżce
`--include-websocket` po utworzeniu prywatnej pustej sesji sprawdza
`GET/PUT` selection, active-node, ribbon i layout. Scope zachowuje session ID
i scientific epoch, ale zmienia request epoch. Każdy stale request musi
zwrócić 409 z `code=conflict` i `message=request_context_stale` zgodnie
z bieżącym serializerem `ApiError`, a ponowny odczyt aktualnym scope musi zachować cały zasób,
włącznie z rewizją. Helper jest podpięty do receiptu `workspace_scope`.
Nie dodano sztucznego klienta produkcyjnego ani nowego endpointu.

Lekkie regresje sterownika: **11/11 pytest PASS**, bez kompilacji Rust/unit
tests. Przypadki negatywne obejmują zaakceptowane stale request, zmienioną
rewizję i brak epoch. Pełny managed smoke wymaga osobnego wykonania;
wynik helpera testowego nie jest dowodem HTTP działającej aplikacji.

## Build produkcyjny

Build **197**, job `4275d899553b40ddb5b4fcf1a11caf2a`, profil
`fem-cpu-release`, źródło commit
`5d91ed2aa6337c2001abf2a208b0b6586125a3a7`, capture
`d477870c825a487dbe4946ace286f15d`, source digest
`1e05bb1ce17d4dbb9701267b410a0ee60e8918c394e09c89617d0d97970d0d50`.
Wynik końcowy: `succeeded`, exit 0, 119 zweryfikowanych artefaktów.
Build nie zawiera późniejszej poprawki skryptu scope.
Aktualny build/browser receipt: [P1 startup](p1/10-browser-empty-startup.md).

Pierwsza próba profilu `fdm-cpu-release` zakończyła się przed zgłoszeniem
jobu: brak definicji profilu w konfiguracji klienta (`KeyError`). Nazwa
dopuszczona przez koordynator nie dowodzi kompletnej konfiguracji. Dostępny
pakiet FEM CPU służy pozyskaniu produkcyjnych binariów; nie zastępuje
kwalifikacji FDM ani GPU. Nie zmieniono konfiguracji operatora.

## Uruchomienie i pusty problem

Kod udostępnia `Create simulation → New Problem` dla pustego FDM/FEM oraz
niezależny `New project`. Historyczne browser receipts dowodzą New/Open/
Save/Close bez solvera. `preserveMountedWorkspace` zachowuje zamontowany
workspace po pierwszym przygotowaniu, lecz `SimulationStartupOverlayView`
nadal jest pełnoekranowym modalem, a `WorkspaceDockLayout` stosuje `inert`.
Zachowanie mountu nie oznacza swobodnego używania edytora podczas przygotowania.

Po uruchomieniu gotowego pakietu UI działa na `http://localhost:3104/workspace`.
Pusty start i FDM przeszły live smoke, FEM działa po reloadzie. Wykryto
regresję zastąpienia sesji FDM przez FEM bez reloadu: Checking for sessions.
Nie zgłaszamy pełnej naprawy modalu podczas długiego meshingu ani startupu Tauri.

Aktualizacja startupu 02.10.2026: ACK scope i invalidacja replacement naprawione w źródłach; nowy build/browser NOT VERIFIED. Checkpointy BLOCKED: symlink w pierwotnym launcherze, a po jego naprawie nieobsługiwany filesystem Desktop 9p. Runner ma poniżej 8 GiB wolnego storage i wykrywa istniejący runtime. Sesja użytkownika na 3104 zachowana. Szczegóły: [raport startupu](p1/10-browser-empty-startup.md).
