# Audyt instrukcji Codex — Astra, Sol i Luna

## Zakres i źródła

Audyt dotyczy instrukcji repozytorium, globalnego AGENTS.md, dostępnych skilli systemowych oraz skilli, manifestów i promptów aktywnych pluginów. Nie zmienia modeli, poziomu rozumowania, uprawnień MCP, polityki sandboxa ani kontraktów naukowych Fullmag.

Podstawa: aktualna [rekomendacja GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra), [tworzenie skilli](https://developers.openai.com/codex/skills), [odkrywanie AGENTS.md](https://developers.openai.com/codex/guides/agents-md) oraz [migracja rodziny GPT-5.6](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol), odczytane 5 września 2026. Wspólne instrukcje pozostają niezależne od modelu. Parametrów API nie przenosimy automatycznie do konfiguracji aplikacji Codex.

## Ustalenia i zastosowane rozwiązania

| Problem | Rozwiązanie |
|---|---|
| AGENTS.md przekracza domyślny limit 32 KiB | Krótki kontrakt główny i cztery wiążące pliki tematyczne w `.agents/instructions` |
| Wymaganie absolutnej pewności i resetu po nieudanych próbach | Hipotezy oparte na dowodach, zmiana podejścia, pytanie tylko przy rzeczywistej blokadzie |
| Kolejne obowiązkowe zgody na już autoryzowane wykonanie | Zachowanie autoryzacji i kontynuacja niezależnych części pracy |
| Ładowanie skilli przy 1% związku z zadaniem | Konkretne triggery i odczyt referencji tylko wtedy, gdy są potrzebne |
| Pełny kod w każdym kroku planu, obligatoryjne commity | Plan opisuje rezultat, interfejsy i weryfikację; commit wymaga autoryzacji |
| Powtórne pełne testy przed każdą deklaracją sukcesu | Dowody zachowują ważność przy niezmienionych źródłach, wejściach i warunkach |
| Usuwanie kodu jako kara za brak TDD | Weryfikacja zachowania i izolowany baseline bez naruszania cudzej pracy |
| Automatyczne instalacje i hostowy build w worktree | Wybór komend z projektu, ochrona dirty checkoutu i container-backed `just` dla FEM |
| Szablony reviewerów i implementerów przywracają stare reguły | Spójne szablony z rzeczywistymi narzędziami hosta i granicami uprawnień |

Wszystkie 43 szczegółowe reguły z wcześniejszej sekcji Project Learnings przypisano do plików tematycznych. Regułę dawnego podziału CPU/GPU uzależniono od rzeczywiście przydzielonej agentowi ścieżki, zamiast przypisywać każdemu agentowi CPU. Zachowano ochronę storage, wymagania GPU, profiler, SP4, stabilność Inspectorów i dowód WebGL.

## Pomiary i weryfikacja

- Główny AGENTS.md: 65 838 → 9 427 bajtów. Szczegółowe kontrakty są nadal dostępne i obowiązkowe w swoim zakresie.
- Rzeczywisty tekst wejściowy `codex debug prompt-input`: 52 946 → 28 339 znaków. Pomiar dotyczy CLI 0.153.4; nie jest pomiarem rozliczonych tokenów ani porównaniem jakości modeli.
- Pełny zestaw testów kontraktu dokumentacji naukowej: 29/29 PASS po końcowych zmianach.
- `python -B scripts/check_repo_consistency.py`: PASS po końcowych zmianach.
- `git diff --check`: PASS po końcowych zmianach; Git zgłasza ostrzeżenia normalizacji końców linii.

## Końcowy zakres i wynik

Zakończono korekty głównego i globalnego AGENTS.md, instrukcji wiki, wszystkich 35 skilli repozytorium (14 procesowych i 21 domenowych), ich istniejących kopii `.github/skills` oraz powiązanych aktywnych szablonów i referencji. Naprawiono brakujące kopie referencji Codex i React Doctor. Suma rozmiarów 35 głównych SKILL.md spadła z 229 342 do 84 745 bajtów (około 63%). To rozmiar plików ładowanych warunkowo, nie stała oszczędność każdego promptu.

W pluginach zmieniono pięć plików: Ponytail SKILL i tekst awaryjny generatora instrukcji, Plugin Management, Visualize oraz Deep Research. Usunięto konflikty długości odpowiedzi i komentarzy, odwołania do narzędzi bez sprawdzenia ich dostępności oraz obowiązek tworzenia zbędnych formatów artefaktów. Zachowano cytowanie, kontrolę renderów, dostępność, weryfikację wyników narzędzi, tryby Ponytail i granice uprawnień.

Inwentaryzacja początkowa obejmowała 79 plików SKILL.md, 16 manifestów, 3 manifesty hooków, 3 pliki instrukcji i konfigurację. Z 79 skilli: 39 zmieniono (35 repozytoryjnych i 4 pluginowe), 26 pozostawiono bez zmian, a 14 należących do usuniętego w trakcie audytu cache Superpowers nie jest już dostępnych. 15 pozostałych manifestów i wszystkie 3 manifesty hooków są identyczne z początkiem audytu. [Inwentarz końcowy](2026-09-05-codex-inventory.json) podaje status i rozmiary każdego pliku; „changed” oznacza różnicę wobec pomiaru początkowego, a nie automatycznie autorstwo tego zadania.

Systemowe skille oraz pozostałe skille narzędziowe i artefaktowe zachowano tam, gdzie instrukcje odpowiadają funkcji narzędzia lub wymaganej kontroli jakości. Nie skracano samych kontraktów dokumentów, PDF, arkuszy, prezentacji i Sites tylko dla zmniejszenia tekstu. Kopie OpenClaw nie są aktywnym źródłem instrukcji Codex. Nie przebudowywano osobnego zestawu instrukcji Copilot.

## Kontrole końcowe i ograniczenia

- 35 głównych skilli: poprawna struktura frontmatter, unikalne nazwy, zgodne istniejące kopie i rozwiązywalne linki Markdown — PASS.
- Generator Ponytail: `node --check` i generacja dla lite/full/ultra z zachowanymi wymaganiami ochrony i komunikacji — PASS.
- Zainstalowany React Doctor: lokalne `--help` potwierdza `--scope changed`; skille i poradnik używają lokalnego programu zamiast `@latest`.
- Kontrola sześciu scenariuszy procesu: mała korekta, istniejący reproducer, autoryzowany plan, dirty FEM, ponowne wykorzystanie dowodu i brak dowodu GPU — przegląd instrukcji PASS. Jest to ocena statyczna, nie benchmark zachowania trzech modeli.
- Oficjalny `quick_validate.py` nie uruchamia się w dostępnym Pythonie bez PyYAML. Zastępcza kontrola frontmatter nie jest pełnym parserem YAML; ten konkretny walidator pozostaje NOT VERIFIED.

Nie zmieniano modeli, reasoning effort, uprawnień, trust hashes ani logiki wykonywania hooków. `config.toml` zmienił się względem początkowej inwentaryzacji poza zastosowanym zestawem korekt; nie nadpisywano tej zmiany ani nie przypisuje się jej temu audytowi. Nie odtwarzano znikłego pluginu Superpowers. Zachowano niezwiązane zmiany wspólnego checkoutu. Nie wykonano commitu ani push.

Kopie sprzed zmian i manifesty hashów znajdują się w `C:/Users/Mateusz/AppData/Local/Temp/codex-instruction-audit-20260905/`; wcześniejszy inwentarz źródłowy znajduje się w katalogu artefaktów tego zadania. Korekty cache pluginów dotyczą aktualnie zainstalowanych wersji i mogą zostać zastąpione przez przyszłą aktualizację pluginu. Skille i opisy już wczytane do trwającej rozmowy mogą zachować starą treść; nowa rozmowa odczyta aktualne pliki.

Nie zmierzono kosztu na udane zadanie ani skuteczności Astra/Sol/Luna w kontrolowanym porównaniu. Potwierdzono mniejszy tekst instrukcji i usunięcie konkretnych sprzeczności; wzrost inteligencji, szybkości i oszczędności rozliczonych tokenów nie jest deklarowany. Ten audyt nie jest kwalifikacją runtime’u ani fizyki Fullmag.