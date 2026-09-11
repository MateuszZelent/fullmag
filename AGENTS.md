# Fullmag — instrukcje dla agentów

## Zakres i sposób pracy

Instrukcje dotyczą GPT-Astra, GPT-Sol, GPT-Luna oraz innych agentów pracujących w tym repozytorium. Zachowuj model i poziom rozumowania wybrane przez użytkownika lub hosta; nie zmieniaj ich na podstawie liczby plików.

- W granicach instrukcji systemowych i deweloperskich wykonuj intencję użytkownika. Jawne polecenia użytkownika mają pierwszeństwo przed wskazówkami skilli. Niniejszy plik określa zasady pracy; dokumenty naukowe określają zamierzoną fizykę, a bieżący kod i wyniki weryfikacji dowodzą stanu implementacji.
- Doprowadź autoryzowane zadanie do końca. Rutynowe, odwracalne decyzje rozstrzygaj na podstawie kodu i kontekstu. Pytaj, gdy brakująca odpowiedź istotnie zmienia zakres, publiczne zachowanie, bezpieczeństwo danych lub wcześniejszą decyzję użytkownika. Kontynuuj niezależne części pracy.
- Audyt lub plan bez zlecenia implementacji pozostaje tylko do odczytu. Jeżeli użytkownik zlecił również poprawki, nie zatrzymuj pracy na oddaniu planu ani na ponownym pytaniu o wykonanie.
- Przed edycją przeczytaj zmieniane pliki i ich istotnych konsumentów. Dla złożonej pracy podaj krótki plan z kryteriami weryfikacji. Dopasuj się do istniejących wzorców; poprawiaj przyczynę problemu, zachowując zakres zadania.
- Po powtarzającym się niepowodzeniu zmień hipotezę na podstawie dowodów. Sięgnij do aktualnej dokumentacji, gdy problem zależy od nieznanego narzędzia. Nie powtarzaj ślepo poleceń, nie wymagaj „100% pewności” ani resetu sesji jako rutynowej procedury.
- Raporty, plany, audyty i podsumowania artefaktów pisz po polsku. Komentarze kodu, nazwy zmiennych i komunikaty commitów pozostają po angielsku. Podawaj wynik, dowody i istotne ograniczenia bez pochwał, powtórzeń i ceremonialnych zakończeń.

## Ochrona pracy i uprawnienia

- Sprawdź tożsamość checkoutu i `git status --short`. Zachowaj cudze zmiany. Użyj izolacji dla szerokiej implementacji; jeżeli zadanie dotyczy aktywnej konfiguracji, edytuj wskazane pliki z kopią i kontrolą zmian.
- Dla zadania implementacyjnego w worktree użytkownik ustanawia domyślną autoryzację cyklu opisanego poniżej: commit, push brancha zadania, PR do `master`, merge i usunięcie wyłącznie zweryfikowanego worktree tego zadania. Jawne ograniczenie zadania (np. audyt, plan, tylko lokalnie, bez push/merge) ma pierwszeństwo. Pozostałe usuwanie danych, force-push i wiadomości zewnętrzne wymagają odrębnej autoryzacji. Nie obchodź sandboxa, branch protection ani automatycznej kontroli uprawnień.
- Przed każdym commitem w współdzielonym checkoutcie sprawdź `git diff --cached --name-only` w osobnym poleceniu. Rozwijaj skrócone identyfikatory przez `git rev-parse`. Nie wnioskuj o właścicielu worktree lub procesu wyłącznie z jego ścieżki.
- Nie usuwaj współdzielonych cache ani worktree bez sprawdzenia aktywnych użytkowników, procesów i mountów. Przed kasowaniem Cargo target uzyskaj aktualne potwierdzenie od każdego korzystającego agenta. Nigdy nie usuwaj worktree `target/`, gdy kontener bind-mountuje ten checkout.
- Nie zmieniaj tych instrukcji automatycznie po każdym błędzie. Dodawaj trwałe reguły na zlecenie użytkownika albo przy zmianie kontraktu w zakresie zadania; usuwaj duplikaty zamiast dopisywać kolejne ogólne zakazy.

## Obowiązkowy cykl pracy w worktree

- Przed implementacją odczytaj [pełną procedurę](docs/guides/fullmag-build-storage-governance.md#cykl-integracji-zadania) oraz skill `using-git-worktrees`. Ustal główny checkout przez Git; użyj lub utwórz jedno `worktrees/<task-id>` obok niego, branch `codex/<task-id>`, i zapisz właściciela, bazowy commit oraz cel w rejestrze. Buildy kieruj przez resolver do `storage/builds/<worktree-id>/<profile-id>`.
- Zakończenie implementacji uruchamia `finishing-a-development-branch`: wymagane testy i review → commit zmian zadania → push brancha → PR do `master` → wymagane kontrole i akceptacje PR → merge PR → przejście do głównego checkoutu na `master` i aktualizacja fast-forward → weryfikacja integracji → usunięcie worktree zadania przez `git worktree remove` → końcowy wpis w rejestrze. Nie kończ na „kod gotowy” ani na samym otwarciu PR, jeżeli pozostałe kroki są wykonalne.
- Nie wykonuj drugiego lokalnego merge po scaleniu PR. Zachowaj cudze zmiany w głównym checkoutcie. Przed usunięciem potwierdź scalenie PR, czysty worktree, brak unikalnej niezintegrowanej pracy i brak korzystających procesów/kontenerów/mountów. Nie stosuj `--force`, zbiorczego prune ani usuwania cache lub wyników jako skutku ubocznego.
- Jeżeli CI, review, uprawnienia, dirty checkout lub aktywne zasoby blokują cykl, zapisz `blocked`/`review` z dokładną ścieżką, branchem, HEAD, linkiem PR, przyczyną i następnym krokiem. Zgłoś niedokończoną integrację; nie porzucaj worktree bez wpisu i nie oznaczaj całego zadania jako ukończonego.

### Commity w trakcie implementacji

- Commituj na branchu zadania po każdym ukończonym, spójnym fragmencie, który przeszedł adekwatną weryfikację; nie odkładaj wszystkich commitów do końca zadania. Jeden commit obejmuje jeden logiczny cel wraz z potrzebnymi testami i dokumentacją. Granicę wyznacza działający etap, nie liczba plików ani upływ czasu. Zmiany zależne, które osobno łamią build lub kontrakt, pozostają razem.
- Przed każdym commitem przejrzyj diff i wyniki kontroli, stage'uj wyłącznie zmiany tego fragmentu, a następnie w osobnym poleceniu sprawdź `git diff --cached --name-only` oraz staged diff. Nie dołączaj cudzych zmian, sekretów ani artefaktów builda. Komunikat po angielsku opisuje cel zmiany; w checkpointcie zadania zapisz pełny hash, zakres i dowody weryfikacji.
- Dla poprawki zachowania użyj odpowiednich testów; dla dokumentacji wystarczy adekwatna kontrola tekstu/linków/parsera. Nie powtarzaj niezmienionych zielonych testów wyłącznie z powodu commita. Zielony test fragmentu pozwala zapisać fragment, ale nie zastępuje wymaganych bramek integracji, runtime ani nauki przed merge. Nie nazywaj nieweryfikowanego WIP ukończonym etapem.
- Ta sama autoryzacja zadania obejmuje kolejne commity etapów; nie pytaj o każdy osobno. Commit etapu nie uruchamia osobnego merge ani usunięcia worktree: PR i integracja dotyczą całego uzgodnionego zadania. Jawne polecenie „bez commitów” ma pierwszeństwo.

## Kontrakt Fullmag

- Jeden publiczny Python DSL w `packages/fullmag-py`, jeden `ProblemIR`, wspólne jednostki SI, semantyka i provenance. UI musi eksportować kanoniczny, edytowalny skrypt.
- Oddzielaj cztery realizacje: FDM CPU, FDM GPU, FEM CPU, FEM GPU. Zachowuj requested intent i resolved execution. Wymuszone GPU nie może mieć cichego fallbacku CPU. `auto` nie może znikać z provenance.
- `docs/physics/` opisuje fizykę; `docs/specs/` i `docs/adr/` kontrakty aplikacji. `docs/architecture/backend-golden-masterplan.md` określa architekturę backendów. Sprzeczność dokumentów zgłoś i rozstrzygnij w jej zakresie; dokument planu nie jest dowodem działającego runtime.
- Przed dodaniem lub zmianą fizyki/numerics uzupełnij notę naukową. Dla tworzenia, zmiany, przeglądu lub publikacji dokumentacji naukowej agenci MUST use `scientific-documentation-contract`. Zachowaj równania, jednostki, parametry, Python→IR, mapy źródeł i bramki walidacji.
- Encje sceny mają oddzielne niezmienne `object_id`, nazwę użytkownika `name`, prezentacyjny `type` i jawnie zadane moduły fizyki. Nazwa lub typ nie aktywują fizyki.
- Control Room ma jeden workspace, jeden viewport, jeden klient typowany i warstwę resource hooks. JSON control plane jest cienki i revision-driven; pola i topologia używają binary data plane. Komponenty nie tworzą własnych endpointów ani osobnych drzew FDM/FEM.

## Build i dowody

- Na hoście z konfiguracją `Fullmag_build_runner` domyślnie zlecaj pełne buildy przez jego kolejkę — zarówno dla `mastera`, jak i branchy/worktree. Użyj skilla `local-build-runner` i [instrukcji runnera](docs/guides/local-container-runner.md). Jeden koordynator obsługuje cały projekt; nie twórz runnera per branch i nie uruchamiaj starego hostowego wykonawcy ani równoległego ciężkiego builda poza kolejką.
- Jawnie wybierz katalog źródeł oraz `snapshot` albo pełny SHA commita. Katalog klienta nie musi być katalogiem budowanego kodu: przy zewnętrznym kliencie podaj `--worktree <absolutny-checkout>`. Brak dostępnego zatwierdzonego klienta, niezdrowy runner lub nieobsługiwany profil oznacza blokadę tej trasy, nie zgodę na cichy fallback. Nie zamieniaj żądanego GPU na CPU. Testy lekkie i odrębne bramki runtime/nauki zachowują swoje recepty; sukces buildu nie zastępuje ich dowodów.

- Nowy worktree na tym samym hoście nie potrzebuje własnego `.env`: resolver ustala główny checkout przez Git i czyta jego plik. Instrukcja i `.env.example` są wersjonowane; wartości hosta pozostają lokalne. Dla nowego klona na innym hoście przed pierwszym buildem skonfiguruj `.env` głównego checkoutu według `.env.example`, zachowując istniejące ustawienia. Jeśli lokalizacja storage nie została określona, uzyskaj ją od użytkownika; nie kopiuj ścieżki z innego hosta ani nie traktuj fallbacku resolvera jako konfiguracji operatora.

- Fizyczną lokalizację storage hosta deklaruj przez `FULLMAG_PROJECT_STORAGE_ROOT` w lokalnym `.env` głównego checkoutu (szablon: `.env.example`). Worktree korzystają z tej samej konfiguracji przez resolver. Nie wpisuj stałych ścieżek Windows/Linux do instrukcji ani skilli i nie kopiuj całego `.env` do worktree. Buildy są podkatalogami rozwiązanego storage; jawne zmienne procesu, w tym mapowanie kontenera, mają pierwszeństwo i podlegają tej samej walidacji.

- Przed wyborem polecenia builda czytaj `justfile`. Natywne FEM/MFEM/CUDA/hypre/libCEED używa od początku container-backed `just`, np. `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just fem-gpu-headless ...` lub właściwego managed recipe. Hostowe `cargo`, `cmake`, ręczny Docker i bezpośrednie binaria są diagnostyką, nie kwalifikacją FEM.
- Windows: `scripts/windows/run_fullmag.ps1` dla natywnej trasy; `scripts/windows/run_fullmag_fem.ps1` i Docker Desktop dla FEM. Windowsowy launcher nie wywołuje WSL. Wszystkie nowe kontrolowane dane kieruj do kanonicznego `storage` projektu; `FULLMAG_WINDOWS_*_ROOT` pozostaje wyłącznie zwalidowanym adapterem zgodności i nie może tworzyć alternatywnych rootów poza konfiguracją.
- Przed buildem, uruchomieniem lub porządkowaniem storage przeczytaj [reguły backendu i wykonania](.agents/instructions/backend.md), w tym dokładne ścieżki Linux/Windows. Linuxowy runner nigdy nie buduje bezpośrednio na CIFS. Prune jest domyślnie tylko dry-run przez `FULLMAG_RUNTIME_DRY_RUN=1`; usunięcie wymaga autoryzacji.
- Obowiązująca polityka worktree, profili buildów, `justfile`, cache, runów i sprzątania znajduje się w [Fullmag build-storage governance](docs/guides/fullmag-build-storage-governance.md). Resolver wyprowadza project root ze wspólnego katalogu Git głównego checkoutu; `storage` i `worktrees` są jego rodzeństwem. Przed utworzeniem worktree sprawdź rejestr i użyj istniejącej izolacji; bez automatycznego `fetch`/`pull`/bootstrapu.
- Każdy build/run z `justfile`, również ręczny, musi wykonać preflight ścieżek i zarejestrować stan końcowy przed zgłoszeniem zgodności. Instrukcje dokumentują kontrakt, lecz wrapper, preflight i sandbox są właściwą granicą techniczną; brak podpięcia danej recepty oznacz `NOT VERIFIED`.
- Dobierz testy do zmiany i wykonaj obowiązkowe bramki projektu. Dla błędu nietrywialnego zachowaj wykonywalny regression check. Dla zmiany tekstu lub formatowania stosuj adekwatny diff/parser/render check zamiast testu powtarzającego implementację.
- Odczytaj wynik i exit code. Ponawiaj lub rozszerzaj zielone testy tylko po istotnej zmianie, awarii albo nierozstrzygniętej obawie. Wynik pozostaje dowodem dla niezmienionych źródeł, wejść i warunków; nie trzeba uruchamiać go ponownie w każdej wiadomości.
- Rozdzielaj testy źródeł/kontraktów, managed runtime, browser/WebGL, walidację fizyki i kwalifikację wydania. Brakująca wymagana ścieżka to `NOT VERIFIED`. Testy lokalne, zbudowana siatka i wykryte GPU nie dowodzą wykonania ani parytetu.
- Zmiany viewportu wymagają dowodu z przeglądarki: widoczny canvas, niezagubiony kontekst WebGL i niezerowy drawing buffer. Zmiany mutacji Inspectora wymagają stabilności panelu i kontroli Object/Airbox opisanych w regułach frontendowych.

## Szczegółowe reguły — ładuj według zakresu

Poniższe pliki są wiążącym rozwinięciem tego AGENTS.md. Przed zmianą lub oceną danego obszaru przeczytaj właściwe sekcje; nie ładuj całego zestawu dla każdego zadania. Ścieżki kodu zapisane w backtickach są względem repozytorium.

| Zakres zadania | Reguły do odczytu |
|---|---|
| Architektura, publiczny Python/IR, runtime, planowanie, cross-layer refaktor, kryteria ukończenia | [Kontrakty aplikacji](.agents/instructions/contracts.md) — sekcje właściwe dla zmiany |
| Backend, FEM/FDM, siatka, relaksacja, integratory, eigensolve, build, launcher, storage | [Backend i wykonanie](.agents/instructions/backend.md) |
| `apps/control-room`, API v2, resource hooks, workspace, Inspector, wykresy, viewport | [Frontend i API](.agents/instructions/frontend.md) |
| Fizyka, metody numeryczne, dokumentacja naukowa, publiczne przykłady i referencje | [Publikacje i przykłady](.agents/instructions/scientific.md) oraz właściwy skill domenowy |

W `.agents/skills` wybierz skill pasujący do konkretnej czynności. Dla backendów używaj `backend-golden-masterplan`, dla obecnego FEM również `fem-native-backend-architecture`; dla API/workspace `resource-first-api-check` i tylko właściwe `frontend-v2-*`; dla Python/IR odpowiednio `python-api-class` i `problem-ir-design`.

## Kontekst, delegacja i review

- Czytaj skill wskazany przez użytkownika lub istotny dla zadania. Nie ładuj go ponownie bez zmiany treści ani równocześnie z jego duplikatem pluginowym. Referencje w skillu ładuj, gdy konkretny krok ich potrzebuje; nie uruchamiaj łańcucha wszystkich workflow.
- Jeśli skill rzeczywiście powoduje zatrzymanie lub dodatkowe pytanie, wskaż dokładny plik i regułę oraz wyjaśnij ich zastosowanie. Nie interpretuj sugestii jako dodatkowego wymogu zatwierdzenia.
- Preferuj `rg`, ograniczone odczyty i wspólne wykonanie niezależnych wyszukiwań. Zachowuj pełny istotny błąd, ale nie drukuj całych katalogów, sekretów i niepowiązanych logów. Narzędzia dostępne w sesji są źródłem prawdy o możliwościach hosta.
- Deleguj istotne, niezależne podzadanie, gdy host pozwala i podział oszczędza czas lub poprawia jakość. Nie twórz agentów dla formalności. Przekaż zakres, ograniczenia, pliki i wymagane dowody; koordynuj wspólne zapisy, staging i zasoby builda. Zachowaj ustawienia modeli użytkownika.
- Długą pracę kontynuuj z krótkiego checkpointu: cel, decyzje, zakończone kroki, dowody i pozostałe zadania. Nie powtarzaj ukończonej pracy po kompakcji.
- Dla review, PR, commit description i odpowiedzi na review używaj `google-eng-review-practices`. Sprawdź poprawność, zakres, kontrakty i dowody. Rozmiar pliku jest sygnałem do review, nie automatycznym nakazem podziału.
