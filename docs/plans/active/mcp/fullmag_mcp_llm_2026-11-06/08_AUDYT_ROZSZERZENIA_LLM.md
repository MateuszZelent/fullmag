# Fullmag Assistant — audyt rozszerzenia MCP o lokalny LLM

**Data:** 6 listopada 2026. **Baseline uzupełnienia:** `914c04ac93b64d16268c62978b44b155c0609f10`.  
**Status:** ukierunkowany audyt statyczny i projekt; bez zmian repozytorium, treningu lub uruchomienia modeli.  
**Poprzedni audyt:** [pakiet MCP z 31.10.2026](mcp_2026-10-31/00_README.md), SHA `f95aa31e1d216008513770afe6b0ea9fad1b5260`. [G01]

## 1. Wniosek wykonawczy

Rozszerzenie jest zasadne, lecz produktem powinien być **Fullmag Assistant: wbudowany host agentowy z lokalnym modelem, będący klientem serwera MCP Fullmaga**. Nie zalecamy zaszycia konkretnego LLM w każdym handlerze MCP ani przekazania modelowi nieograniczonego dostępu do Pythona, powłoki i GPU. Rozdzielenie host/klient/serwer odpowiada architekturze MCP. [S01]

Użytkownik otrzymuje jeden panel rozmowy, ale pod nim działają cztery niezależnie weryfikowane warstwy: interpretacja intencji, wiedza o danej wersji produktu, kontrolowane operacje aplikacji oraz solver naukowy. Dostrojenie modelu polepsza zachowanie pierwszej warstwy; nie zastępuje trzech pozostałych. Jest to rekomendacja projektowa, a nie stwierdzenie osiągniętej niezawodności.

**Rekomendacja do pierwszego porównania:** Qwen3.5-4B, Qwen3.5-9B oraz Gemma 4 E4B; Gemma 4 E2B jako eksperyment oszczędnościowy. Pierwsze dwa mają role odpowiednio Lite i Workstation, natomiast Gemma jest pełnoprawnym konkurentem, nie dodatkiem marketingowym. Ostateczny wybór następuje dopiero na benchmarku Fullmaga. Modele istnieją w oficjalnych katalogach; brak własnych wyników. [S02] [S03] [S04] [S05]

## 2. Zakres i granice dowodu

Przeczytano cały wcześniejszy README, strukturę trzech głównych dokumentów, katalog tools, wspólne referencje, zasady wdrożenia i rejestr źródeł; pozostałe części pakietu służą jako plan bazowy, nie świeżo dowiedziona implementacja. Z GitHuba odczytano pin mastera, manifest Rust, wybrane fragmenty reguł aplikacji, frontend/API, importu Python, typów wykonania i capabilities. Pełną listę zakresów zawiera [rejestr](14_ZRODLA_I_DECYZJE_LLM.md).

Nie wykonano klonowania całego repozytorium, globalnego statycznego skanu wszystkich plików ani testów integracyjnych. Wyszukiwania `fullmag-mcp`, `llama`, `Qwen` przez connector na domyślnej gałęzi nie zwróciły trafień; wynik indeksu nie dowodzi całkowitego braku prototypów. Workspace nie deklaruje nowych crate MCP/Assistant. Nie należy zatem zakładać, że poprzedni plan MCP został już wdrożony. [G03]

**Poziomy dowodu:** `CODE_READ` — odczyt wskazanego kodu; `CONTRACT_READ` — normatywny opis; `UPSTREAM_DOCUMENTED` — deklaracja producenta; `DESIGN` — propozycja; `NOT_RUN` — brak uruchomienia. Tych etykiet nie wolno redukować do jednego „obsługiwane”.

## 3. Co zmieniło się względem pakietu bazowego

| Obszar | Stan bazowy | Stan uzupełnienia / działanie |
|---|---|---|
| Commit | Audyt 31.10 na `f95aa31…` | Nowy pin `914c04a…`; nie podmieniono historycznych źródeł |
| Agent | Zewnętrzny klient MCP | Dodatkowy lokalny host LLM, nadal przez tę samą granicę operacji |
| Katalog | 46 projektowanych narzędzi | Zachowujemy ich nazwy i semantykę; host wybiera mniejszy zestaw do pojedynczej inferencji |
| Storage DEV | Starsza dokumentacja topologii | Obowiązuje nowy ADR 0076: jeden prywatny volume grupy, zachowany rozdział subpaths i shared stores [G04] |
| Testy | Historyczny zakaz unit-build | W odczytanej bieżącej sekcji Build i dowody nie ma tego zdania. Nie uznajemy tego za odwołanie ewentualnej odrębnej instrukcji użytkownika; L00 ustala aktualne zasady [G02] |
| Wiedza agenta | Tools/resources/prompts | Dodatkowy wersjonowany indeks wiedzy, zbiór trajektorii i kwalifikacja modeli |
| Zasoby | Admission solverów | Trzeba objąć planowaniem również preemptible inference, bez drugiego schedulera symulacji |

## 4. Wymagania wynikające z celu użytkownika

„Programowanie językiem naturalnym” obejmuje tworzenie nowego problemu, poprawianie istniejącego, wyjaśnianie skutków zmian, budowę siatki, wybór realizacji, planowanie study, wykonanie, monitorowanie, kontrolę, analizę i reprodukcję. Wynikiem nie może być tylko opis albo skrypt bez związku z aktualnym projektem.

„Znać Fullmaga na wylot” przekładamy na mierzalne obowiązki: korzystanie z aktualnego schematu, rozpoznawanie ograniczeń realizacji, poprawne jednostki, odszukanie odpowiedniej dokumentacji, wykorzystanie stanu projektu zamiast zgadywania identyfikatorów oraz zdolność przerwania procesu i zadania pytania, gdy brakuje informacji fizycznej. Nie deklarujemy, że dowolny mały model bezbłędnie rozwiąże dowolny problem.

„Dowolna kontrola” oznacza pełne **pokrycie legalnych operacji** dostępnych w konkretnym wydaniu i grancie. Nie oznacza uprawnień administratora, implementowania nieistniejącej fizyki w trakcie rozmowy, automatycznego zmieniania kodu solvera ani omijania walidacji.

## 5. Ustalenia audytu

### LA01 — MCP nie jest środowiskiem inference — P0, DESIGN

MCP porządkuje dostęp do operacji i danych. Model potrzebuje hosta, który buduje kontekst, prowadzi pętlę narzędzi i stosuje politykę. Umieszczenie LLM wewnątrz `fm_run_submit` stworzyłoby niejawne efekty i utrudniło użycie serwera przez innych agentów. Decyzja: jawny `AssistantHost`, oddzielny od serwera; brak rekurencyjnego narzędzia `ask_fullmag_llm`, które wykonuje dowolne akcje. [S01]

### LA02 — Nie potwierdzono działającej bazy MCP — P0, CODE_READ/NOT_RUN

Nie ma odpowiedniej pozycji w odczytanym workspace; wyszukiwanie nie dostarczyło implementacji. LLM nie może być integrowany na założeniu, że 46 nazw z dokumentu to aktywne funkcje. Decyzja: zależności do zadań I00–I33 pozostają jawne; mock narzędzi służy testom, nie produkcyjnemu fallbackowi. [G03]

### LA03 — Import Python jest wykonaniem kodu — P0, CODE_READ

Obecny `from-script` jawnie wykonuje dostarczony skrypt i sprawdza flagę zgody. Automatyczne ustawienie tej flagi przez model byłoby pozorną zgodą. Wbudowany host musi rozdzielać typed authoring od izolowanej ścieżki Python, a delegację uzyskiwać z zaufanej interakcji użytkownika. Sam parser AST nie jest sandboxem. [G05]

### LA04 — Scene↔script ma znane ograniczenia fidelity — P0, CODE_READ

Nagłówek importera opisuje przybliżenie sceny i verdict fidelity. Asystent nie może „naprawiać” złożonego skryptu przez odtworzenie tylko widocznych elementów i utratę pozostałych. Należy zachować `authority_mode`, oryginalne źródło, diff i wynik porównania obniżenia do IR. [G05]

### LA05 — Zakończenie procesu nie dowodzi jakości naukowej — P0, CODE_READ

`TaskLifecycle` i `ScientificAssessment` są osobnymi typami. Tekst odpowiedzi ma odróżniać `succeeded` od `converged`, `limit_reached`, `tolerance_not_met` i `unassessed`. Model nie wystawia samodzielnego certyfikatu zbieżności. [G07]

### LA06 — Capabilities nie zastępują kwalifikacji modelu fizycznego — P0, CODE_READ

Odczyt platformy odkrywa zainstalowane runtime. To wartościowa informacja, ale nie wystarcza do stwierdzenia, że dowolne połączenie fizyki, siatki, PBC i precyzji jest poprawne. Host musi łączyć capabilities konkretnego problemu z registry dowodów naukowych zaprojektowanym w MCP. [G09]

### LA07 — Fine-tuning nie daje aktualnego stanu projektu — P0, DESIGN

Model może zapamiętać składnię starego wydania, nie zna jednak aktywnej rewizji, liczby zajętych GPU ani statusu runu. RAG dostarcza dokumenty; stan pochodzi wyłącznie z odczytów narzędzi. Każdy plan ma `build_identity`, `schema_digest`, `project_ref` i `context_revision`. Zmiana kontraktu wymaga walidacji kompatybilności adaptera, nie zaufania do nazwy modelu.

### LA08 — Współdzielenie GPU wymaga admission — P0, CODE_READ/DESIGN

Fullmag ma typowane budżety RAM/VRAM/CPU i walidację żądanego wykonania. Dodanie procesu LLM poza tym planowaniem grozi OOM i zakłóceniem solvera. Projekt przewiduje lease inference, priorytet symulacji, kontrolowane zwolnienie modelu i brak cichego fallbacku solvera. `cpu_millis` nie jest limitem czasu treningu. [G08]

### LA09 — Nazwa „E4B” nie wyznacza rozmiaru paczki — P1, UPSTREAM_DOCUMENTED

Gemma 4 E4B ma parametry efektywne i dodatkowe embeddings. Estymowanie wszystkich wymagań z „4B × cztery bity” zaniżyłoby wagę artefaktu. Paczkę, kontekst, cache i wspólne użycie z solverem należy mierzyć, nie wnioskować z nazwy. [S05]

### LA10 — Otwarty model nie oznacza bezwarunkowego kopiowania wszystkiego — P1, UPSTREAM_DOCUMENTED/DESIGN

Odczytane Qwen3.5 i Gemma 4 deklarują Apache-2.0. To sprzyja dystrybucji, lecz trzeba sprawdzić konkretne wagi, adapter, konwerter, bazę danych i notices. Starsze warunki Gemma nie są automatycznie warunkami Gemma 4. Decyzja: manifest i receptury w Git; duże artefakty w wersjonowanym magazynie albo opcjonalnym pakiecie offline. [S02] [S03] [S05] [S07] [S08]

### LA11 — Formaty function calling różnią się między modelami — P0, UPSTREAM_DOCUMENTED

Nie wystarczy zamienić `model_id` w jednej konfiguracji. Szablon rozmowy, tokeny końca, reasoning mode, parser i odpowiedzi narzędzi tworzą kwalifikowany zestaw. Normalizacja wewnętrzna nie może niszczyć natywnego formatu. Ze strumienia tekstu nie wolno wykonywać częściowych ani „naprawionych” domysłem poleceń. [S06] [S10] [S12]

### LA12 — Autonomia wymaga granicy poza modelem — P0, DESIGN

Filtrowanie promptem i wyspecjalizowany trening nie są autoryzacją. Model może proponować akcje; backend ponownie sprawdza użytkownika, grant, rewizję, budżet i typ efektu. Odczytane dane, logi, nazwy obiektów i dokumenty nie mogą nadawać praw. Trzeba testować również poprawnie sformatowane, lecz szkodliwe operacje.

### LA13 — UI nie może stać się drugim modelem aplikacji — P1, CONTRACT_READ

Panel rozmowy w Control Room ma używać centralnego typowanego klienta i resource hooks. Nie zapisuje własnej wersji geometrii w React state, nie manipuluje DOM-em, nie tworzy osobnego workspace. Preview zmian ma opierać się na tych samych referencjach i rendererze co zwykła edycja. [G06]

### LA14 — Dane treningowe z planów mogą uczyć nieistniejącego API — P0, DESIGN

W pakiecie bazowym wiele funkcji ma status DESIGN. Ich bezrefleksyjne użycie jako instrukcji w SFT nauczyłoby model twierdzić, że są dostępne. Dopuszczenie pozytywnej trajektorii wymaga zrealizowanego kontraktu i receipt wykonania w określonym buildzie. Unsupported jest pełnoprawną poprawną odpowiedzią.

### LA15 — Brak benchmarku domenowego — P0, NOT_RUN

Nie uruchomiono żadnego z kandydatów na Fullmagu. Nie ma podstaw do twierdzenia, że Qwen przewyższa Gemmę, że 4B wystarcza do całej aplikacji ani że LoRA poprawi wynik. Plan wymaga porównania baseline/RAG/SFT i osobnej kwalifikacji po kwantyzacji, także po polsku, z literówkami i w dialogach wieloetapowych.

## 6. Warunki wejścia do realizacji

Najpierw ustalić bieżący baseline i legalne recepty testowe; następnie domknąć minimalny MCP read-only, typed authoring, identity/revisions, granty i idempotentny submit. Prace nad benchmarkiem, indeksem wiedzy i panelem podglądu mogą biec równolegle, ale mock-only demo nie może uruchamiać rzeczywistych symulacji.

Pierwszy kwalifikowany przebieg ma być wąski: użytkownik opisuje mały problem, asystent pokazuje jawne założenia, powstaje walidowany projekt i skrypt, użytkownik akceptuje koszt, Fullmag zwraca receipt, a wynik jest odczytywany po `run_id`. Dopiero potem rozszerzamy zakres operacji i autonomii.

## 7. Kryteria odrzucenia projektu

Odrzucić rozwiązanie, które wymaga chmury dla każdej rozmowy, przekazuje LLM klucz administratora, generuje dowolne komendy powłoki, powiela scheduler symulacji, pobiera ruchome wagi przy starcie, uczy się automatycznie na prywatnych projektach albo traktuje tekst „sukces” jako dowód wykonania. Odrzucić także demo prezentujące gotowy skrypt jako wykonaną symulację.

## 8. Co ten audyt pozostawia nieweryfikowane

Pełne pokrycie wszystkich ścieżek API, stan implementacji MCP na innych branchach, jakość modeli, transfer adapterów między silnikami, szybkość generacji, pamięć inference, zachowanie GPU/CPU i zgodność konkretnego runtime z poszczególnymi modelami pozostają `NOT_RUN` lub `NOT_AUDITED`. Uzupełnienie nie unieważnia historycznych ustaleń bez sprawdzenia ich aktualnych konsumentów.

## Odsyłacze źródłowe

[G01]: 14_ZRODLA_I_DECYZJE_LLM.md#g01
[G02]: 14_ZRODLA_I_DECYZJE_LLM.md#g02
[G03]: 14_ZRODLA_I_DECYZJE_LLM.md#g03
[G04]: 14_ZRODLA_I_DECYZJE_LLM.md#g04
[G05]: 14_ZRODLA_I_DECYZJE_LLM.md#g05
[G06]: 14_ZRODLA_I_DECYZJE_LLM.md#g06
[G07]: 14_ZRODLA_I_DECYZJE_LLM.md#g07
[G08]: 14_ZRODLA_I_DECYZJE_LLM.md#g08
[G09]: 14_ZRODLA_I_DECYZJE_LLM.md#g09
[S01]: 14_ZRODLA_I_DECYZJE_LLM.md#s01
[S02]: 14_ZRODLA_I_DECYZJE_LLM.md#s02
[S03]: 14_ZRODLA_I_DECYZJE_LLM.md#s03
[S04]: 14_ZRODLA_I_DECYZJE_LLM.md#s04
[S05]: 14_ZRODLA_I_DECYZJE_LLM.md#s05
[S06]: 14_ZRODLA_I_DECYZJE_LLM.md#s06
[S07]: 14_ZRODLA_I_DECYZJE_LLM.md#s07
[S08]: 14_ZRODLA_I_DECYZJE_LLM.md#s08
[S10]: 14_ZRODLA_I_DECYZJE_LLM.md#s10
[S12]: 14_ZRODLA_I_DECYZJE_LLM.md#s12
