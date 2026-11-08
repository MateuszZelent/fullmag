# Fullmag MCP — rejestr źródeł, decyzji i granic dowodowych

**Data opracowania:** 31 października 2026 r.  
**Repozytorium:** `MateuszZelent/fullmag`  
**Przypięty commit:** `f95aa31e1d216008513770afe6b0ea9fad1b5260`  
**Rodzaj pracy:** zdalny, statyczny audyt wybranych granic integracji oraz projekt wdrożenia; bez zmian repozytorium.

## 1. Jak czytać dowody

`VERIFIED-SOURCE` oznacza wyłącznie odczyt wskazanego kodu lub schematu. `CONTRACT` oznacza regułę zapisaną w dokumentacji projektu. `DESIGN` oznacza zalecaną zmianę, której nie należy przedstawiać jako istniejącej implementacji. `NOT VERIFIED-RUNTIME` oznacza brak wykonania odpowiedniej ścieżki runtime w tym audycie. `NOT ESTABLISHED` oznacza, że w badanym wycinku nie udało się ustalić danego faktu.

Źródła repozytorium są przypięte do SHA. Numeracja zakresów poniżej dotyczy pliku źródłowego, nie numerów wierszy opakowania odpowiedzi konektora. Przy skróconym odczycie podano dokładny zakres; nie odtwarzano brakujących fragmentów. Rejestr nie jest kopią repozytorium. Odsyłacze mogą wymagać zalogowania do GitHuba.

Źródła zewnętrzne odczytano przez narzędzie internetowe. Strony wersjonowane wskazują wersję protokołu, ale nie zastępują przypiętego wydania SDK. Informacji z ruchomego `main` nie wolno używać jako lockfile ani dowodu zgodności kompilacji.

## 2. Źródła Fullmaga

<a id="r01"></a>
### R01 — Punkt odniesienia: master

**Źródło:** [https://github.com/MateuszZelent/fullmag/commit/f95aa31e1d216008513770afe6b0ea9fad1b5260](https://github.com/MateuszZelent/fullmag/commit/f95aa31e1d216008513770afe6b0ea9fad1b5260)  
**Odczyt:** Odczyt branches/master; pełny SHA i metadane commita.  
**Znaczenie:** Master odczytany podczas audytu wskazywał ten commit. Data commita: 2026-10-30T23:24:49Z. Nie jest to obietnica, że master nie zmienił się później.

<a id="r02"></a>
### R02 — Zasady repozytorium

**Źródło:** [AGENTS.md](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/AGENTS.md)  
**Odczyt:** Istotne początkowe sekcje oraz zakres 65–220; nie deklarujemy odczytu każdego wiersza całego pliku.  
**Znaczenie:** Audyt/plan tylko do odczytu; jeden DSL/IR; cztery lane; grupy Compose, dwie stałe usługi, ograniczenia storage; tymczasowy zakaz kompilowania testów jednostkowych.

<a id="r03"></a>
### R03 — Workspace Rust

**Źródło:** [Cargo.toml](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/Cargo.toml)  
**Odczyt:** Cały plik.  
**Znaczenie:** Istniejące crate aplikacji; axum 0.7 i Tokio. W manifeście workspace nie ma crate fullmag-mcp. Sam manifest nie dowodzi braku dowolnego adaptera w całym repozytorium.

<a id="r04"></a>
### R04 — Kontrakt aplikacji

**Źródło:** [.agents/instructions/contracts.md](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/.agents/instructions/contracts.md)  
**Odczyt:** 1–150.  
**Znaczenie:** Kanoniczny DSL, ProblemIR, provenance, jeden control plane/data plane. Dokument normatywny, nie wynik testu.

<a id="r05"></a>
### R05 — Kontrakt backendów

**Źródło:** [.agents/instructions/backend.md](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/.agents/instructions/backend.md)  
**Odczyt:** 1–110.  
**Znaczenie:** Legalny FDM CPU reference, CUDA FDM oraz produkcyjne ścieżki FEM MFEM; zakaz cichego fallbacku i rozdzielenie modeli demagnetyzacji.

<a id="r06"></a>
### R06 — Kontrakt frontend/API

**Źródło:** [.agents/instructions/frontend.md](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/.agents/instructions/frontend.md)  
**Odczyt:** 1–130.  
**Znaczenie:** apps/control-room, typowany klient v2, resource hooks, schematy. Starsza sekcja storage wymaga interpretacji z nowszym AGENTS.md.

<a id="r07"></a>
### R07 — Resource-first API governance

**Źródło:** [.agents/skills/resource-first-api-check/SKILL.md](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/.agents/skills/resource-first-api-check/SKILL.md)  
**Odczyt:** Cała udostępniona treść.  
**Znaczenie:** Dokładne ścieżki generatorów i typów; HTTP jako źródło snapshotów, WebSocket jako kanał zdarzeń i invalidacji. Polecenia testów podlegają ograniczeniom z AGENTS.md.

<a id="r08"></a>
### R08 — Router v2

**Źródło:** [crates/fullmag-api/src/router_v2/mod.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/mod.rs)  
**Odczyt:** 1–650 i 850–1370; zakres 651–849 nie był przedmiotem odczytu.  
**Znaczenie:** Zarejestrowane rodziny zasobów, mutacje modelu i runtime, trwałe projekty/runy/batche, solution sets, middleware. Istnienie trasy nie dowodzi poprawnego wykonania ani parytetu solverów.

<a id="r09"></a>
### R09 — Pin instancji API

**Źródło:** [crates/fullmag-api/src/router_v2/middleware/version.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/middleware/version.rs)  
**Odczyt:** Cały udostępniony plik.  
**Znaczenie:** x-fullmag-api-instance, API_INSTANCE_MISMATCH i x-api-contract-version. Brak nagłówka zachowuje ścieżkę legacy.

<a id="r10"></a>
### R10 — Scope aktywnej sesji

**Źródło:** [crates/fullmag-api/src/router_v2/middleware/session_scope.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/middleware/session_scope.rs)  
**Odczyt:** 1–220.  
**Znaczenie:** Parser session/epoch/request_scope_epoch i task-local scope. Brak nagłówka jest dopuszczony. Parser sam nie dowodzi atomowości wszystkich konsumentów.

<a id="r11"></a>
### R11 — Schematy poleceń

**Źródło:** [crates/fullmag-api/src/schemas/commands.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/schemas/commands.rs)  
**Odczyt:** 1–240.  
**Znaczenie:** Opcjonalne preconditions i target, Run/Relax/Pause/Resume/Stop/Solve/MeshBuild/FdmGridRefresh, polityki integratorów. Enum nie jest dowodem dostępności na wszystkich lane.

<a id="r12"></a>
### R12 — Wysyłanie poleceń

**Źródło:** [crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs)  
**Odczyt:** 1–240.  
**Znaczenie:** Capture/validation context, tokio::spawn po odłączeniu klienta, cache odpowiedzi, transition fence i accepted-run path. Nie przeczytano wszystkich funkcji pomocniczych ani dalszej części pliku.

<a id="r13"></a>
### R13 — Warstwa aplikacyjna

**Źródło:** [crates/fullmag-application/src/lib.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-application/src/lib.rs)  
**Odczyt:** Cały udostępniony plik.  
**Znaczenie:** Eksporty lifecycle, batch, coordinator, lease/epoch, typed run intent, przygotowanie i artefakty. Eksport symbolu nie zastępuje testu jego realizacji.

<a id="r14"></a>
### R14 — Niemutowalne RunSpec i zasoby

**Źródło:** [crates/fullmag-application/src/run_spec.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-application/src/run_spec.rs)  
**Odczyt:** 1–260.  
**Znaczenie:** Snapshot/hash, requested execution, walidacja zasobów; cpu_millis to pojemność CPU (threads × 1000), nie czas CPU. Nagłówek wskazuje in-memory ledger w tej warstwie; trwałość musi zapewniać adapter.

<a id="r15"></a>
### R15 — Trwały transport projektów

**Źródło:** [crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs)  
**Odczyt:** 1–220.  
**Znaczenie:** Deklarowany durable submit bez bezpośredniego schedulowania workera; StoreWriterBusy/RunBacklogFull; tożsamość task/attempt/epoch i bounded CAS manifest. Nie wykonano testu crash-consistency.

<a id="r16"></a>
### R16 — Import projektu z Pythona

**Źródło:** [crates/fullmag-api/src/router_v2/handlers/persistence/script_project.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/handlers/persistence/script_project.rs)  
**Odczyt:** 1–210.  
**Znaczenie:** Import wykonuje Python; wymaga consent.executed_by_user. Opisuje ograniczenia fidelity scene↔script. Odnotowuje limity wejścia i redakcję komunikatów, ale ten wycinek nie dowodzi izolacji procesu.

<a id="r17"></a>
### R17 — Przypięcie profili wykonania

**Źródło:** [crates/fullmag-api/src/router_v2/handlers/persistence/execution_profile_submission.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/handlers/persistence/execution_profile_submission.rs)  
**Odczyt:** Cały udostępniony plik.  
**Znaczenie:** Walidacja opublikowanego profile_id@version i porównanie snapshotów; execution_profile_reference_conflict / execution_profile_snapshot_conflict.

<a id="r18"></a>
### R18 — Capabilities i health

**Źródło:** [crates/fullmag-api/src/router_v2/handlers/platform/system.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/handlers/platform/system.rs)  
**Odczyt:** 1–190.  
**Znaczenie:** Capabilities powstaje z RuntimeRegistry::discover; health sprawdza stan API/runtime fence. To nie certyfikat poprawności naukowej; log endpoint w tym fragmencie klonuje listę logów.

<a id="r19"></a>
### R19 — CORS

**Źródło:** [crates/fullmag-api/src/router_v2/middleware/cors.rs](https://github.com/MateuszZelent/fullmag/blob/f95aa31e1d216008513770afe6b0ea9fad1b5260/crates/fullmag-api/src/router_v2/middleware/cors.rs)  
**Odczyt:** Cały plik.  
**Znaczenie:** FULLMAG_API_CORS_ALLOWED_ORIGIN może ograniczyć origin; przy braku konfiguracji allow_origin(Any), dowolne metody/nagłówki. Nie jest to kompletny audyt auth i ekspozycji sieciowej.

## 3. Oficjalne źródła MCP i SDK

<a id="m01"></a>
### M01 — MCP 2026-07-28: wersjonowanie

**Źródło:** [MCP 2026-07-28: wersjonowanie](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)  
**Znaczenie:** Normatywna specyfikacja; rozróżnienie modern/legacy/dual-era.

<a id="m02"></a>
### M02 — MCP 2026-07-28: Streamable HTTP

**Źródło:** [MCP 2026-07-28: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)  
**Znaczenie:** Normatywna specyfikacja transportu; POST, metadata, Origin i anulowanie żądania.

<a id="m03"></a>
### M03 — MCP 2026-07-28: tools

**Źródło:** [MCP 2026-07-28: tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)  
**Znaczenie:** Schematy, structuredContent, resultType, charakter adnotacji i błędów narzędzi.

<a id="m04"></a>
### M04 — MCP 2026-07-28: authorization

**Źródło:** [MCP 2026-07-28: authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)  
**Znaczenie:** OAuth/resource metadata i rozdzielenie HTTP od stdio.

<a id="m05"></a>
### M05 — Oficjalny Rust SDK

**Źródło:** [Oficjalny Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)  
**Znaczenie:** README w dniu odczytu deklaruje RMCP 3.x oraz specyfikację 2026-07-28 z kompatybilnością 2025-11-25. To źródło ruchome; konkretny release wymaga przypięcia podczas wdrożenia.

<a id="m06"></a>
### M06 — Manifest RMCP

**Źródło:** [Manifest RMCP](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/crates/rmcp/Cargo.toml)  
**Znaczenie:** Źródło ruchome. Tower/HTTP body jako granica integracji; axum 0.8 jest w dev-dependencies, nie dowodzi konieczności migracji całego Fullmaga.

<a id="m07"></a>
### M07 — MCP Tasks extension — draft

**Źródło:** [MCP Tasks extension — draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks)  
**Znaczenie:** Rozszerzenie io.modelcontextprotocol/tasks, nie obowiązkowy fundament Fullmaga. W audycie odczytano wersję oznaczoną Draft; przed użyciem konieczny pin i conformance.

<a id="m08"></a>
### M08 — MCP Security Best Practices

**Źródło:** [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)  
**Znaczenie:** Oficjalne omówienie m.in. token passthrough, SSRF, confused deputy i state-handle hijacking.

<a id="m09"></a>
### M09 — MCP 2026-07-28: stdio

**Źródło:** [MCP 2026-07-28: stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)  
**Znaczenie:** Framing wiadomości, stdout/stderr, zamknięcie procesu i zgodność wersji.

<a id="m10"></a>
### M10 — MCP 2026-07-28: resources

**Źródło:** [MCP 2026-07-28: resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)  
**Znaczenie:** URI, odczyt, stronicowanie, widoczność zależna od uprawnień i subskrypcje zasobów.

## 4. Rejestr wyszukiwań i ograniczeń

| Operacja | Wynik | Granica wniosku |
|---|---|---|
| Odczyt `branches/master` | Pełny SHA przypięty przed analizą | Nie monitorowano dalszych zmian mastera |
| Wyszukiwanie `MCP` w repozytorium, pierwsze 20 trafień | Dokumentacja narzędzi deweloperskich, shadcn i trafienia tekstowe typu memcpy; bez potwierdzonego adaptera symulacyjnego | To nie pełnotekstowy, wyczerpujący dowód nieistnienia serwera |
| Odczyt manifestu workspace | Nie ma zadeklarowanego `fullmag-mcp` | Ewentualny adapter poza workspace mógłby istnieć |
| Wyszukiwanie `Router::new`, `get_capabilities`, `CorsLayer`, `idempotency` | Zlokalizowano źródła użyte w audycie | Snippet służył nawigacji; istotne wnioski oparto na odczytach wskazanych wyżej |
| Próba bezpośredniego dostępu sieciowego kontenera | Brak rozwiązywania DNS | Kod czytano przez konektor; nie utworzono lokalnego checkoutu ani pełnego indeksu repozytorium |
| Odczyty źródeł przez GitHub | Wybrane pełne pliki i jawne zakresy | Nie pobrano całych binarnych artefaktów CI ani pakietu runtime |
| Budowanie, testy solverów, GPU, UI | Nie wykonywano | Wszystkie takie ścieżki w pakiecie mają status NOT VERIFIED-RUNTIME |

Nie sprawdzono stanu roboczego checkoutu użytkownika, bo audyt nie korzystał z jego lokalnego katalogu Git. Nie wolno zastępować tej informacji stwierdzeniem „working tree clean”. Nie wykonano commitów, komentarzy, PR, merge ani zmian ustawień repozytorium.

## 5. Decyzje architektoniczne proponowane do zatwierdzenia przy wdrożeniu

| ID | Decyzja projektowa | Uzasadnienie i warunek zmiany |
|---|---|---|
| D01 | Adapter Rust oparty na oficjalnym RMCP; domena pozostaje w Fullmagu | Pasuje do aktualnego Rust API i zachowuje jeden kontrakt. Zmiana języka wymaga wykazania korzyści bez duplikacji walidacji i stanu |
| D02 | Endpoint MCP w istniejącym procesie API; stdio jako cienki klient transportowy | Zachowuje dwie stałe usługi aplikacji w DEV. Osobny publiczny gateway dopiero w odrębnym profilu release |
| D03 | Podstawą kontroli są trwałe project/run/attempt i CAS, nie aktywna sesja przeglądarki | Pozwala odłączać agenta bez utraty kontroli nad symulacją |
| D04 | Edycja live tylko z przypiętym instance/scope/revision; żadnego niejawnego przełączania projektu | Chroni jednoczesną pracę użytkownika i agentów |
| D05 | Domyślny transport docelowy 2026-07-28, jawny profil zgodności 2025-11-25 | Starszych klientów nie utożsamiamy z klientami nowej bezstanowej wersji |
| D06 | Zwykłe narzędzia submit/get/control działają bez rozszerzenia Tasks | Trwałość obliczeń nie zależy od opcjonalnego rozszerzenia protokołu |
| D07 | Python wykonywany wyłącznie w izolowanym workerze kompilacji/importu | Boolean pochodzący od modelu nie jest zgodą właściciela, a parser AST nie jest sandboxem |
| D08 | Brak ogólnego shell/exec/arbitrary-http/read-file/write-file | Pełna kontrola naukowa nie oznacza administracji systemem hosta |
| D09 | Preflight nie zmienia fizyki, lane ani precyzji bez jawnej nowej wersji żądania | Zapobiega „naprawom” zmieniającym badany problem |
| D10 | Potwierdzenie przyjęcia, ukończenie procesu i poprawność naukowa są oddzielne | Agent nie może uznać statusu completed za walidację fizyczną |
| D11 | Parytet i kwalifikacja odrębne dla FDM CPU/GPU i FEM CPU/GPU | Wykrycie GPU lub istnienie endpointu nie dowodzi poprawnego wykonania |
| D12 | Rozszerzenia storage i idempotency współpracują z istniejącym SessionStore | Nie powstaje drugi scheduler ani rozbieżna baza stanów runów |

Są to rekomendacje autora dokumentacji, a nie wcześniej zatwierdzone przez użytkownika decyzje implementacyjne.

## 6. Nierozstrzygnięte kwestie z jednoznacznym sposobem zamknięcia

| ID | Co trzeba ustalić | Właściciel / dowód zamknięcia | Zachowanie do czasu zamknięcia |
|---|---|---|---|
| Q01 | Dokładny release RMCP, MSRV i zgodność body/Tower z axum 0.7 | Zadanie I02: przypięty lockfile i conformance na dozwolonej ścieżce builda | Nie migrować globalnie axum i nie deklarować kompatybilności |
| Q02 | Wszystkie stany accepted-run i moment automatycznej materializacji/release | I01/I16: ślad wywołań i test hold/after_admission | Narzędzia uruchamiania wyłączone |
| Q03 | Trwałość kluczy idempotency i konfliktów payloadu w każdej użytej ścieżce | I06: test ponowienia po restarcie i awarii w oknie publikacji | Brak automatycznego ponowienia mutacji bez reconciliation |
| Q04 | Dostępny izolator procesu Python w profilu hosta | I12: test ucieczek, mountów, sieci, zasobów i logów | `fm_script_compile` niewystawione; structured authoring pozostaje dostępne |
| Q05 | Obsługa pause/resume/checkpoint dla konkretnego lane i integratora | I18/I21/I29: natywne ACK, checkpoint i test kontynuacji | Zwracać UNSUPPORTED_OPERATION, nie emulować zapisaniem samego m |
| Q06 | Aktualna polityka uwierzytelniania całej ekspozycji API | I04/I31: inwentaryzacja ingress i test ominięcia MCP przez REST | Brak zdalnej ekspozycji mutacji |
| Q07 | Zakaz kompilowania testów jednostkowych | Jawna zmiana instrukcji użytkownika lub nadal obowiązujący gate | Nie uruchamiać kompilacji tych testów; wymagane dowody oznaczyć BLOCKED |
| Q08 | Dostępność funkcji fizycznych i analitycznych per lane | I27/I29: manifest kwalifikacji związany z buildem i workloadem | `unknown` lub `unsupported` z powodem; żadnych deklaracji zbiorczych |
| Q09 | Bezpieczeństwo użycia istniejących current-scoped handlerów poza HTTP task-local | I05/I10: jawny ExecutionContext oraz test race | Zakazać bezpośredniego wywoływania handlerów z pominięciem fence |

## 7. Reguła aktualizacji dokumentacji

Przed rozpoczęciem implementacji utrzymać ten raport jako historyczny baseline, zapisać nowy SHA i wykonać delta-audyt wyłącznie zmienionych punktów integracji. Nie podmieniać automatycznie dowodów z tego commita opisem bieżącego mastera. Każda nowa deklaracja PASS ma wskazywać polecenie/receptę, źródła, środowisko, wynik i niezmienne artefakty dowodowe.
