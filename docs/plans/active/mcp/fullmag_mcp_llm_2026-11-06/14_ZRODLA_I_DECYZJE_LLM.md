# Fullmag Assistant — rejestr źródeł, decyzji i ograniczeń

**Data weryfikacji:** 6 listopada 2026. **Stan pracy:** dokumentacja projektowa; bez zmian GitHuba, uruchomienia modeli, treningu ani solverów.

## 1. Jak czytać źródła

Źródła G wskazują przypięty commit Fullmaga. Zakresy linii dotyczą pliku w repozytorium, nie numeracji otoczki JSON zwracanej przez connector. Źródła S pochodzą od autorów modeli, bibliotek i standardu. Karta modelu opisuje deklaracje producenta; nie dowodzi skuteczności w Fullmagu. Większość źródeł upstream jest ruchoma: przed wydaniem trzeba przypiąć wersje/rewizje i zachować kopię metadanych w release evidence.

Pakiet bazowy MCP pozostawiono w katalogu [mcp_2026-10-31](mcp_2026-10-31/00_README.md). Jego historyczne ustalenia dotyczą wcześniejszego commita i nie są automatycznie aktualną oceną mastera. Rozszerzenie wskazuje konkretne zmiany istotne dla LLM; nie zastępuje pełnego ponownego audytu wszystkich 22 wcześniejszych ustaleń.

## 2. Repozytorium Fullmag

<a id="g01"></a>
### G01 — Bieżący punkt odniesienia Fullmag

Źródło: [Bieżący punkt odniesienia Fullmag](https://github.com/MateuszZelent/fullmag/commit/914c04ac93b64d16268c62978b44b155c0609f10).

**Zakres i ograniczenia:** Odczyt branches/master 6.11.2026; commit 6.11.2026 14:15:12 UTC. To pin tego audytu, nie obietnica niezmienności mastera.

<a id="g02"></a>
### G02 — AGENTS.md

Źródło: [AGENTS.md](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/AGENTS.md).

**Zakres i ograniczenia:** Odczyt zakresów 1–115 i 115–175; pierwszy wynik częściowo skrócony przez connector. Potwierdzone: jeden DSL/IR, cztery realizacje, read-only plan, Docker DEV. Nie deklarujemy pełnego odczytu całego pliku.

<a id="g03"></a>
### G03 — Cargo.toml

Źródło: [Cargo.toml](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/Cargo.toml).

**Zakres i ograniczenia:** Odczyt 1–100, obejmujący cały plik. Workspace Rust nie zawiera fullmag-mcp ani fullmag-assistant. Nie jest to dowód braku dowolnego prototypu w innych plikach.

<a id="g04"></a>
### G04 — ADR 0076: jeden prywatny volume na grupę DEV

Źródło: [ADR 0076: jeden prywatny volume na grupę DEV](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/docs/adr/0076-single-private-volume-per-dev-group.md).

**Zakres i ograniczenia:** Odczyt 1–155. Kontrakt storage; liczba stałych usług jest potwierdzona osobno w AGENTS.md. Sam ADR zaznacza konieczność osobnej weryfikacji runtime.

<a id="g05"></a>
### G05 — Import projektu ze skryptu

Źródło: [Import projektu ze skryptu](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/crates/fullmag-api/src/router_v2/handlers/persistence/script_project.rs).

**Zakres i ograniczenia:** Odczyt 1–140. Import wykonuje Python; consent.executed_by_user i ograniczona fidelity scene↔script. Nie sprawdzono pełnego izolatora procesu.

<a id="g06"></a>
### G06 — Instrukcje frontend/API

Źródło: [Instrukcje frontend/API](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/.agents/instructions/frontend.md).

**Zakres i ograniczenia:** Odczyt 1–145. Jeden workspace, typowany klient, resource hooks, brak fetch w komponentach, generated types oraz manifesty modułów.

<a id="g07"></a>
### G07 — Stany wykonania i oceny naukowej

Źródło: [Stany wykonania i oceny naukowej](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/crates/fullmag-application/src/execution.rs).

**Zakres i ograniczenia:** Odczyt 100–190. TaskLifecycle, ObservationState, ScientificAssessment i ResourceBudget. Succeeded i Converged to odrębne pojęcia.

<a id="g08"></a>
### G08 — RequestedExecution i budżet RunSpec

Źródło: [RequestedExecution i budżet RunSpec](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/crates/fullmag-application/src/run_spec.rs).

**Zakres i ograniczenia:** Odczyt 120–245. Requested backend/device/precision; cpu_millis jako threads×1000; walidacja budżetów. Nie audytowano całego admission.

<a id="g09"></a>
### G09 — Platform capabilities

Źródło: [Platform capabilities](https://github.com/MateuszZelent/fullmag/blob/914c04ac93b64d16268c62978b44b155c0609f10/crates/fullmag-api/src/router_v2/handlers/platform/system.rs).

**Zakres i ograniczenia:** Odczyt 1–75. RuntimeRegistry::discover(...).capability_matrix(); nie jest certyfikatem naukowym.

## 3. Modele, standard i narzędzia upstream

<a id="s01"></a>
### S01 — MCP 2026-07-28 — Architecture

Źródło pierwotne: [MCP 2026-07-28 — Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture).

**Co potwierdza / czego nie potwierdza:** Host integruje LLM i klientów; serwery dostarczają tools/resources/prompts. W tej wersji metadane są per request; stan aplikacyjny nie jest stanem transportu.

<a id="s02"></a>
### S02 — Qwen3.5-4B — oficjalna karta

Źródło pierwotne: [Qwen3.5-4B — oficjalna karta](https://huggingface.co/Qwen/Qwen3.5-4B).

**Co potwierdza / czego nie potwierdza:** Model opublikowany przez Qwen, Apache-2.0; opis tool calling i formatów wdrożenia. Nie testowano jakości na Fullmagu.

<a id="s03"></a>
### S03 — Qwen3.5-9B — oficjalna karta

Źródło pierwotne: [Qwen3.5-9B — oficjalna karta](https://huggingface.co/Qwen/Qwen3.5-9B).

**Co potwierdza / czego nie potwierdza:** Model 9B z deklarowanym Apache-2.0. Kandydat do profilu workstation; brak benchmarku Fullmag.

<a id="s04"></a>
### S04 — Gemma 4 — oficjalny przegląd

Źródło pierwotne: [Gemma 4 — oficjalny przegląd](https://ai.google.dev/gemma/docs/core).

**Co potwierdza / czego nie potwierdza:** Istnieją warianty E2B/E4B/12B/26B A4B/31B, function calling i warianty kwantyzowane. Nie przenosimy ogólnych wyników na skuteczność w Fullmagu.

<a id="s05"></a>
### S05 — Gemma 4 E4B — oficjalna karta

Źródło pierwotne: [Gemma 4 E4B — oficjalna karta](https://huggingface.co/google/gemma-4-E4B-it).

**Co potwierdza / czego nie potwierdza:** Apache-2.0; E4B: 4.5B effective, 8B z embeddings. E2B: 2.3B effective, 5.1B z embeddings. Uwaga na różnicę effective/total.

<a id="s06"></a>
### S06 — Gemma 4 — function calling

Źródło pierwotne: [Gemma 4 — function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4).

**Co potwierdza / czego nie potwierdza:** Własny chat template i format narzędzi; aplikacja waliduje i wykonuje operacje. Demonstracyjne regex/globals nie stanowią wzorca produkcyjnego Fullmaga.

<a id="s07"></a>
### S07 — Gemma — rozróżnienie licencji generacji

Źródło pierwotne: [Gemma — rozróżnienie licencji generacji](https://ai.google.dev/gemma/terms).

**Co potwierdza / czego nie potwierdza:** Strona wskazuje osobną licencję Gemma 4. Nie przypisywać automatycznie starszych Gemma Terms nowej generacji.

<a id="s08"></a>
### S08 — Gemma 4 — Apache License 2.0

Źródło pierwotne: [Gemma 4 — Apache License 2.0](https://ai.google.dev/gemma/apache_2).

**Co potwierdza / czego nie potwierdza:** Pierwotny tekst licencji wskazany przez producenta; zachować licencję/atrybucje i sprawdzić konkretny artefakt pochodny.

<a id="s09"></a>
### S09 — Qwen3.8-27B — oficjalna karta

Źródło pierwotne: [Qwen3.8-27B — oficjalna karta](https://huggingface.co/Qwen/Qwen3.8-27B).

**Co potwierdza / czego nie potwierdza:** Istnieje nowszy większy kandydat Apache-2.0. Nie traktujemy go jako lekkiego domyślnego modelu ani nie nazywamy Qwen3.5 najnowszą rodziną.

<a id="s10"></a>
### S10 — llama.cpp — function calling

Źródło pierwotne: [llama.cpp — function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md).

**Co potwierdza / czego nie potwierdza:** Silnik wymaga właściwych template/parser/konfiguracji. Ruchomy master nie jest pinem wydania ani dowodem zgodności konkretnej kwantyzacji.

<a id="s11"></a>
### S11 — llama.cpp — gramatyki i JSON Schema

Źródło pierwotne: [llama.cpp — gramatyki i JSON Schema](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md).

**Co potwierdza / czego nie potwierdza:** Mechanizmy ograniczania formatu generacji. Walidacja semantyki, jednostek, praw i aktualności pozostaje zadaniem Fullmaga.

<a id="s12"></a>
### S12 — vLLM — tool calling

Źródło pierwotne: [vLLM — tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/).

**Co potwierdza / czego nie potwierdza:** Dobór parsera i szablonu do modelu; interfejs inference nie wykonuje automatycznie operacji Fullmaga.

<a id="s13"></a>
### S13 — vLLM — sleep mode

Źródło pierwotne: [vLLM — sleep mode](https://docs.vllm.ai/en/latest/features/sleep_mode/).

**Co potwierdza / czego nie potwierdza:** Możliwa baza do zwalniania zasobów inference. Każdy użyty tryb wymaga pomiaru faktycznie odzyskanej pamięci i testu odtworzenia.

<a id="s14"></a>
### S14 — TRL — SFTTrainer

Źródło pierwotne: [TRL — SFTTrainer](https://huggingface.co/docs/trl/en/sft_trainer).

**Co potwierdza / czego nie potwierdza:** SFT obsługuje messages/tool_calls/tool results i kolumnę tools; właściwy chat template oraz maskowanie loss trzeba zweryfikować dla konkretnego modelu.

<a id="s15"></a>
### S15 — PEFT — quantization

Źródło pierwotne: [PEFT — quantization](https://github.com/huggingface/peft/blob/main/docs/source/developer_guides/quantization.md).

**Co potwierdza / czego nie potwierdza:** Oficjalna dokumentacja kwantyzacji i adapterów. Wersja www docs zwróciła 429; odczytano źródło w repozytorium PEFT.

<a id="s16"></a>
### S16 — QLoRA — publikacja autorów

Źródło pierwotne: [QLoRA — publikacja autorów](https://arxiv.org/abs/2305.14314).

**Co potwierdza / czego nie potwierdza:** Dettmers i in., 2023. Metoda treningu adapterów przez zamrożoną bazę 4-bit. Odczytano abstrakt, nie analizowano PDF ani nie przenoszono cudzych wyników pamięci na nasze modele.

<a id="s17"></a>
### S17 — Qwen3-Embedding-0.6B — oficjalna karta

Źródło pierwotne: [Qwen3-Embedding-0.6B — oficjalna karta](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).

**Co potwierdza / czego nie potwierdza:** Opcjonalny wielojęzyczny embedding do indeksu wiedzy, Apache-2.0. MVP może używać wyszukiwania leksykalnego bez drugiego modelu.

<a id="s18"></a>
### S18 — Qwen-Agent — oficjalne repozytorium

Źródło pierwotne: [Qwen-Agent — oficjalne repozytorium](https://github.com/QwenLM/Qwen-Agent).

**Co potwierdza / czego nie potwierdza:** Framework obsługujący m.in. MCP/tool calling. Przydatny jako harness porównawczy; nie wybrano go na właściciela stanu produktu.

<a id="s19"></a>
### S19 — Qwen — aktualny katalog producenta

Źródło pierwotne: [Qwen — aktualny katalog producenta](https://huggingface.co/Qwen).

**Co potwierdza / czego nie potwierdza:** Sprawdzono katalog 6.11.2026: obejmuje też Qwen3.8. Shortlista lekkich modeli jest celowym wyborem rozmiaru, a nie zestawieniem najnowszych lub wszystkich modeli.


## 4. Rejestr decyzji projektowych

Poniższe wybory są rekomendacjami opracowania. Nie przedstawiamy ich jako zatwierdzonych przez użytkownika wymagań, jeśli nie wynikają z jego prośby.

| ID | Decyzja | Uzasadnienie | Kiedy wrócić do decyzji |
|---|---|---|---|
| LD01 | Osobny logicznie AssistantHost jako klient MCP | Jedna granica operacji dla asystenta lokalnego i agentów zewnętrznych; niezależny lifecycle modelu | Gdy pomiary wykażą istotny koszt transportu; optymalizacja nie może omijać policy. |
| LD02 | Orkiestrator w Rust; trening w osobnym stosie Python | Dopasowanie do backendu, brak obowiązkowego stosu ML w UI | Po wykazaniu konkretnej nieobsługiwanej zależności, nie dla wygody prototypu. |
| LD03 | Qwen3.5-4B/9B i Gemma 4 E4B jako pierwsza shortlista | Dwa profile zasobów i konkurencja dwóch rodzin | Wyniki zamrożonego benchmarku oraz nowe, istotnie lepsze modele. |
| LD04 | llama.cpp jako kandydat lokalny; vLLM opcjonalny | Mały lokalny runtime i osobny profil laboratoryjny | Gdy parser, architektura lub wydajność nie przejdą kwalifikacji. |
| LD05 | Wiedza wersjonowana + stan MCP + SFT zachowania | Zmiany API nie powinny wymagać każdorazowego przetrenowania | Gdy badanie ablacyjne wykaże zbędność lub koszt konkretnego składnika. |
| LD06 | Najpierw typed authoring, Python jako odrębna opcja | Ograniczenie powierzchni RCE i wspólna semantyka | Dopiero po kwalifikacji izolatora i zachowania script-authority. |
| LD07 | Grant związany z proposal digest/revision/budget | Zgoda nie może obejmować innego modelu lub większej kampanii | Zmiana wymaga jawnej analizy bezpieczeństwa, nie samego prompt engineering. |
| LD08 | Wagi poza zwykłym Git; manifesty w repo | Rozmiar, aktualizacje, offline pack i audytowalna dystrybucja | Przy świadomej decyzji o LFS/innym kanale, z zachowaniem hash/pin. |
| LD09 | Domyślnie solver ma pierwszeństwo nad inference | Brak niszczenia obliczeń przez konkurencję o VRAM/RAM | Dla oddzielnego GPU inference można kwalifikować współbieżność. |
| LD10 | SFT po wdrożeniu pętli i zebraniu zweryfikowanych trajektorii | Uczy rzeczywistych kontraktów, nie planowanych nazw | Po stabilizacji i testach nowego zestawu narzędzi. |
| LD11 | Test stanów końcowych i efektów zamiast oceny samego tekstu | Odpowiedź może brzmieć poprawnie mimo błędnej symulacji | Nigdy nie usuwać weryfikacji semantycznej; rozwijać jej zakres. |
| LD12 | Brak samoczynnego uczenia z danych użytkownika | Prywatność, powtarzalność i możliwość rollbacku | Nowy osobny, jawny produktowy tryb opt-in, z zarządzaniem danymi. |
| LD13 | Profil tekstowy jako pierwsze wydanie | Sterowanie narzędziami ma pierwszeństwo nad interpretacją obrazów | Multimodalność po osobnym eval; screenshot nie zastępuje pól naukowych. |
| LD14 | Brak trzeciej stałej usługi aplikacji w DEV | Zachowanie aktualnego kontraktu Fullmaga | Tylko przez zatwierdzoną zmianę ADR i launchera, nie ukryty sidecar. |

## 5. Wymagania użytkownika a przyjęte założenia

Z prośby użytkownika wynikają: interfejs naturalnego języka, model otwarty/lokalny możliwy do dostrojenia, głęboka integracja z MCP i docelowo pełne sterowanie funkcjami Fullmaga. Nie wskazano jednoznacznego minimalnego RAM/VRAM, dokładnego modelu, kanału dystrybucji wag, poziomu autonomii ani budżetu treningu.

Dlatego Lite/Workstation, context caps, limity pętli, shortlistę modeli, wielkości początkowych zbiorów i progi jakości należy traktować jako **proponowane wartości startowe**. Są konkretnie opisane, aby wykonawca miał z czego zacząć, lecz nie są wynikami benchmarku ani ograniczeniami narzuconymi przez użytkownika.

Nie obiecujemy, że mały model będzie niezawodnie rozwiązywał dowolny problem naukowy. Projekt dąży do pełnego pokrycia kontraktów dostępnych w danym buildzie, jawnego pytania o brakujące informacje i odpornego wykonania w granicach uprawnień. Błędy generacji mają być zatrzymywane przed skutkami, a brak capability ujawniany.

## 6. Otwarte kwestie z przypisanym sposobem rozstrzygnięcia

| Kwestia | Właściciel/zadanie | Wymagany dowód |
|---|---|---|
| Dokładne piny SDK MCP i zgodność dwóch wersji protokołu | L00/L08 + bazowy I03 | Aktualne lockfiles i testy transportów, bez ręcznie wymyślonych wersji. |
| Minimalna konfiguracja użytkownika | L18/L24 | Pomiary pamięci, jakości i opóźnień, także przy współistnieniu solvera. |
| Zwycięski model i kwantyzacja | L18–L20/L26 | Porównanie B0/B1/B2/B3 i wyniki osobno PL/EN. |
| Miejsce przechowywania model pack w resolverze | L00/L04/L25 | Zgodny z ADR0076 kontrakt storage, receipts i test retencji. |
| Prawa do danych treningowych i packów | L04/L17/L25 | Rejestr pochodzenia, licencji i zgód; osobny przegląd wydania. |
| Dokładna dostępność solverów/analiz | L13–L15/L26 | Aktualne capabilities plus runtime/scientific evidence czterech realizacji. |
| Script-authority i bezpieczne wykonanie Python | L16 | Test izolacji i zachowania semantyki; brak dowodu wyłącza tę opcję. |
| Zakres trwałej delegacji A3 | L11/L22/L26 | Polityka grantów, limity i testy konkretnych kampanii. |

Te kwestie nie blokują przygotowania dokumentacji. W implementacji ich braki mogą blokować odpowiedni etap lub profil wydania; nie wolno zastępować dowodu domysłem.

## 7. Czego nie wykonano

Nie zmieniono mastera ani brancha zadania, nie utworzono PR, nie zapisano komentarza na GitHubie. Nie zbudowano Fullmaga, nie pobrano wag, nie uruchomiono llama.cpp/vLLM, nie dostrojono LoRA, nie zmierzono VRAM ani tokens/s, nie uruchomiono scenariusza solvera. Nie wykonano pełnego audytu bezpieczeństwa importera Python ani wszystkich handlerów.

Kontrola tego pakietu dotyczy wyłącznie dokumentacji: struktury, linków, składni przykładów, identyfikatorów, zależności zadań, pokrycia nazw narzędzi i integralności kopii historycznej. Wynik takiej kontroli nie jest kwalifikacją serwera MCP lub asystenta.
