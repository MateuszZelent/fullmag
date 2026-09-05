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
- Nie wykonuj commitów, push, merge, force-push, usuwania danych ani wysyłania wiadomości na zewnątrz bez autoryzacji dla tej czynności. Sam przykład w skillu nie udziela uprawnienia. Nie obchodź odmowy sandboxa ani automatycznej kontroli uprawnień.
- Przed każdym commitem w współdzielonym checkoutcie sprawdź `git diff --cached --name-only` w osobnym poleceniu. Rozwijaj skrócone identyfikatory przez `git rev-parse`. Nie wnioskuj o właścicielu worktree lub procesu wyłącznie z jego ścieżki.
- Nie usuwaj współdzielonych cache ani worktree bez sprawdzenia aktywnych użytkowników, procesów i mountów. Przed kasowaniem Cargo target uzyskaj aktualne potwierdzenie od każdego korzystającego agenta. Nigdy nie usuwaj worktree `target/`, gdy kontener bind-mountuje ten checkout.
- Nie zmieniaj tych instrukcji automatycznie po każdym błędzie. Dodawaj trwałe reguły na zlecenie użytkownika albo przy zmianie kontraktu w zakresie zadania; usuwaj duplikaty zamiast dopisywać kolejne ogólne zakazy.

## Kontrakt Fullmag

- Jeden publiczny Python DSL w `packages/fullmag-py`, jeden `ProblemIR`, wspólne jednostki SI, semantyka i provenance. UI musi eksportować kanoniczny, edytowalny skrypt.
- Oddzielaj cztery realizacje: FDM CPU, FDM GPU, FEM CPU, FEM GPU. Zachowuj requested intent i resolved execution. Wymuszone GPU nie może mieć cichego fallbacku CPU. `auto` nie może znikać z provenance.
- `docs/physics/` opisuje fizykę; `docs/specs/` i `docs/adr/` kontrakty aplikacji. `docs/architecture/backend-golden-masterplan.md` określa architekturę backendów. Sprzeczność dokumentów zgłoś i rozstrzygnij w jej zakresie; dokument planu nie jest dowodem działającego runtime.
- Przed dodaniem lub zmianą fizyki/numerics uzupełnij notę naukową. Dla tworzenia, zmiany, przeglądu lub publikacji dokumentacji naukowej agenci MUST use `scientific-documentation-contract`. Zachowaj równania, jednostki, parametry, Python→IR, mapy źródeł i bramki walidacji.
- Encje sceny mają oddzielne niezmienne `object_id`, nazwę użytkownika `name`, prezentacyjny `type` i jawnie zadane moduły fizyki. Nazwa lub typ nie aktywują fizyki.
- Control Room ma jeden workspace, jeden viewport, jeden klient typowany i warstwę resource hooks. JSON control plane jest cienki i revision-driven; pola i topologia używają binary data plane. Komponenty nie tworzą własnych endpointów ani osobnych drzew FDM/FEM.

## Build i dowody

- Przed wyborem polecenia builda czytaj `justfile`. Natywne FEM/MFEM/CUDA/hypre/libCEED używa od początku container-backed `just`, np. `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just fem-gpu-headless ...` lub właściwego managed recipe. Hostowe `cargo`, `cmake`, ręczny Docker i bezpośrednie binaria są diagnostyką, nie kwalifikacją FEM.
- Windows: `scripts/windows/run_fullmag.ps1` dla natywnej trasy; `scripts/windows/run_fullmag_fem.ps1` i Docker Desktop dla FEM. Windowsowy launcher nie wywołuje WSL. Buildy, cache, pnpm i przeglądarki trzymaj poza checkoutem, zgodnie z `FULLMAG_WINDOWS_*_ROOT`.
- Przed buildem, uruchomieniem lub porządkowaniem storage przeczytaj [reguły backendu i wykonania](.agents/instructions/backend.md), w tym dokładne ścieżki Linux/Windows. Linuxowy runner nigdy nie buduje bezpośrednio na CIFS. Prune jest domyślnie tylko dry-run przez `FULLMAG_RUNTIME_DRY_RUN=1`; usunięcie wymaga autoryzacji.
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
