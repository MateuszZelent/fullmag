# Fullmag MCP — audyt i pakiet projektu wdrożenia

**Opracowano:** 31 października 2026 r.  
**Repozytorium:** `MateuszZelent/fullmag`  
**Odczytany master:** `f95aa31e1d216008513770afe6b0ea9fad1b5260`  
**Tryb:** audyt tylko do odczytu oraz dokumentacja projektowa. **Nie wdrożono serwera MCP i nie modyfikowano repozytorium.**

## Dokumenty główne

| Plik | Zawartość |
|---|---|
| [01_AUDYT_GOTOWOSCI_MCP.md](01_AUDYT_GOTOWOSCI_MCP.md) | Audyt kodu i kontraktów: mapa istniejących zasobów, 22 ustalenia A01–A22, priorytety P0–P2, cztery lane i granice dowodowe |
| [02_PLAN_ARCHITEKTURY_MCP.md](02_PLAN_ARCHITEKTURY_MCP.md) | Docelowy produkt i architektura: 15 wymagań, granice komponentów, protokół, tożsamości, authoring, bezpieczeństwo, run lifecycle, dane i eksploatacja |
| [03_PLAN_WDROZENIA_MCP.md](03_PLAN_WDROZENIA_MCP.md) | Osobny plan realizacji: 34 zadania I00–I33, zależności, pliki, interfejsy, testy, bramki F0–F6, rollout i rollback |

## Załączniki wykonawcze

| Plik | Zawartość |
|---|---|
| [04_KATALOG_NARZEDZI_I_KONTRAKTOW.md](04_KATALOG_NARZEDZI_I_KONTRAKTOW.md) | 46 projektowanych narzędzi, wspólne typy, operacje modelu, schemat submit, błędy, URI i przykładowe przepływy |
| [05_MACIERZ_TESTOW_I_KWALIFIKACJI.md](05_MACIERZ_TESTOW_I_KWALIFIKACJI.md) | 100 rodzin scenariuszy T001–T100, testy naukowe czterech lane, chaos, security, client compatibility i format receipts |
| [06_REJESTR_ZRODEL_I_DECYZJI.md](06_REJESTR_ZRODEL_I_DECYZJI.md) | 19 wpisów źródłowych repozytorium, 10 oficjalnych źródeł MCP/SDK, 12 decyzji i 9 pytań do zamknięcia |

Zalecana kolejność lektury: audyt → architektura → plan wdrożenia; katalog i macierz testów należy mieć otwarte podczas realizacji. Odsyłacze `[Rxx]` i `[Mxx]` prowadzą do rejestru źródeł. Wzajemne linki działają po rozpakowaniu całego pakietu do jednego katalogu. Schematy Mermaid można oglądać w edytorze Markdown z obsługą Mermaid; nie są niezbędne do zrozumienia tekstu.

**Kontrola pakietu:** [07_WALIDACJA_PAKIETU.md](07_WALIDACJA_PAKIETU.md) opisuje lokalne sprawdzenia dokumentacji. Nie jest raportem testów Fullmaga.

## Najważniejsza rekomendacja

Zbudować **cienki adapter MCP w Rust, wewnątrz istniejącego backendu Fullmaga**, oparty na oficjalnym SDK i wspólnej fasadzie aplikacyjnej. Zachować istniejące RunIntent, profile, native coordinator, SessionStore i CAS. Nie budować serwera jako zestawu wrapperów do powłoki, osobnego Python runnera ani mechanicznej kopii każdego endpointu REST. Repozytorium już zawiera rozbudowane fundamenty potrzebne do takiej integracji. [R03] [R08] [R13] [R14] [R15]

Aktualny projekt wire uwzględnia MCP `2026-07-28` oraz jawny profil zgodności `2025-11-25`. Trwały stan symulacji nie jest stanem połączenia protokołu. Rozszerzenie Tasks pozostaje opcjonalne, a SDK wymaga przypięcia i testu integracji zamiast pobierania ruchomego main. [M01] [M05] [M07]

Najważniejsze bramki to: bezpieczne wykonanie Python; mandatory identity/revision guards dla agenta; autoryzacja całej ekspozycji, nie tylko MCP; idempotentny durable submit; kontrola kosztu; zachowanie source/scene fidelity; niezależna kwalifikacja FDM CPU/GPU i FEM CPU/GPU. „Pełna kontrola” nie oznacza praw administratora ani udawania obsługi funkcji, której dana realizacja nie potwierdza.

**Weryfikacja runtime produktu:** `NOT_RUN`.

## Co rzeczywiście wykonano

Przypięto SHA mastera i przeczytano wybrane pliki/zakresy przez konektor GitHub. Zweryfikowano oficjalne źródła protokołu i SDK. Przygotowano dokumentację i wykonano lokalne kontrole struktury pakietu Markdown opisane w raporcie walidacji.

**Nie wykonano:** builda Fullmaga, uruchomienia API/UI/solverów, testu GPU, testów protokołu z działającym Fullmagiem ani benchmarków. Nie potwierdzono czystego stanu lokalnego worktree użytkownika. Nie utworzono commitów, PR ani zmian na GitHubie. Wszelkie T001–T100 są planem, nie wynikami PASS.

## Warunki rozpoczęcia wdrożenia

Najpierw wykonać I00/I01: odczytać aktualny AGENTS, sprawdzić lokalne zmiany, przypiąć nowy baseline i zamknąć pełną sekwencję accepted→materialization→admission→native execution. Wymagany jest istniejący workflow Docker DEV; nie dodawać trzeciej stałej usługi aplikacji. Obowiązujący zakaz kompilowania testów jednostkowych pozostaje wiążący. [R02]

Wszystkie nazwy `fm_*`, nowe moduły i schematy w planie mają status **DESIGN**. Przykładowe identyfikatory i hashe w JSON są demonstracyjne, z wyjątkiem jawnie podanego SHA baseline. Plan nie zawiera sekretów ani danych uwierzytelniających.

## Kryterium wartości projektu

Po wdrożeniu agent ma móc przeprowadzić kompletne badanie w ramach nadanej delegacji i przekazać nie tylko wynik, ale także dokładne wejście, konwencje fizyczne, faktyczny backend, historię prób, jakość naukową i odtwarzalne artefakty. Gdy warunek nie jest spełniony, interfejs ma zwrócić sprawdzalną odmowę lub ograniczenie — nigdy milcząco zmienić badany problem.


## Odsyłacze źródłowe

[R01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r01
[R02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r02
[R03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r03
[R04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r04
[R05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r05
[R06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r06
[R07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r07
[R08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r08
[R09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r09
[R10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r10
[R11]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r11
[R12]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r12
[R13]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r13
[R14]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r14
[R15]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r15
[R16]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r16
[R17]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r17
[R18]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r18
[R19]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r19
[M01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m01
[M02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m02
[M03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m03
[M04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m04
[M05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m05
[M06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m06
[M07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m07
[M08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m08
[M09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m09
[M10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m10
