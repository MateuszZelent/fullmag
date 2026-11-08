# Fullmag MCP + lokalny LLM — rozszerzony pakiet projektowy

**Wersja opracowania:** 6 listopada 2026.  
**Baseline uzupełnienia:** `914c04ac93b64d16268c62978b44b155c0609f10`.  
**Zakres:** audyt delta, architektura, modele, wiedza i dostrajanie, wdrożenie, testy oraz źródła.  
**Status:** dokumentacja do realizacji; model, serwer i testy nie zostały w tej sesji zaimplementowane ani uruchomione.

## 1. Rekomendacja

Zbudować **Fullmag Assistant**, czyli wbudowany w interfejs aplikacji host agentowy z wymiennym lokalnym LLM i klientem MCP. Serwer MCP pozostaje niezależną, typowaną granicą sterowania Fullmagiem. Model proponuje działania, ale uprawnienia, walidacja, stan obliczeń i dowody naukowe pozostają w aplikacji.

Do pierwszego porównania przyjąć **Qwen3.5-4B**, **Qwen3.5-9B** i **Gemma 4 E4B**. Role Lite/Workstation i preferencje modeli są propozycją, nie wynikiem benchmarku. Dostrojenie obejmuje głównie poprawne posługiwanie się narzędziami i obsługę błędów; wiedzę o aktualnym wydaniu dostarcza wersjonowany indeks, a stan projektu odczytywany jest z MCP. [S02] [S03] [S05]

Nie commitować dużych wag do zwykłej historii repozytorium. W repo utrzymywać kod integracji, manifesty, recepty treningu i testy. Model oraz adapter dystrybuować jako zweryfikowany, wersjonowany pakiet, możliwy do instalacji offline.

## 2. Dokumenty rozszerzenia

| Plik | Treść i zastosowanie |
|---|---|
| [08 — Audyt rozszerzenia LLM](08_AUDYT_ROZSZERZENIA_LLM.md) | Stan obecny, różnice względem planu MCP, ryzyka i granice dowodu; czytać najpierw. |
| [09 — Architektura Fullmag Assistant](09_ARCHITEKTURA_FULLMAG_ASSISTANT.md) | Podział host/model/MCP, pętla agenta, kontrakty, approvals, UI, zasoby i bezpieczeństwo. |
| [10 — Modele, inference i dystrybucja](10_MODELE_INFERENCE_I_DYSTRYBUCJA.md) | Shortlista, dobór runtime, pamięć, formaty, licencje, model packs i rollback. |
| [11 — Wiedza, dataset i dostrajanie](11_WIEDZA_DATASET_I_DOSTRAJANIE.md) | RAG, wersjonowanie wiedzy, trajektorie, seedy danych, SFT/LoRA/QLoRA, leakage i ewaluacja. |
| [12 — Plan wdrożenia LLM](12_PLAN_WDROZENIA_LLM.md) | 28 zadań L00–L27, proponowane pliki, interfejsy, zależności, testy i odbiór. |
| [13 — Testy i scenariusze](13_TESTY_KWALIFIKACJA_I_SCENARIUSZE.md) | 84 rodziny LE001–LE084, pokrycie 46 tools MCP, 12 scenariuszy NL i progi kwalifikacji. |
| [14 — Źródła i decyzje](14_ZRODLA_I_DECYZJE_LLM.md) | 9 źródeł repozytoryjnych, 19 źródeł upstream, decyzje LD01–LD14 i jawne ograniczenia. |
| [15 — Walidacja pakietu](15_WALIDACJA_ROZSZERZENIA.md) | Faktyczne wyniki kontroli dokumentów, nie wyniki działania asystenta. |

Ten README wraz z dokumentami 08–15 daje **9 nowych plików Markdown**. Dołączono też **8 niezmienionych historycznych plików MCP** — razem 17 plików Markdown.

## 3. Dokumentacja bazowa MCP

[Wejście do pełnego pakietu MCP](mcp_2026-10-31/00_README.md).

Najważniejsze dokumenty bazowe to [audyt](mcp_2026-10-31/01_AUDYT_GOTOWOSCI_MCP.md), [architektura](mcp_2026-10-31/02_PLAN_ARCHITEKTURY_MCP.md), [wdrożenie I00–I33](mcp_2026-10-31/03_PLAN_WDROZENIA_MCP.md), [46 tools](mcp_2026-10-31/04_KATALOG_NARZEDZI_I_KONTRAKTOW.md) i [testy T001–T100](mcp_2026-10-31/05_MACIERZ_TESTOW_I_KWALIFIKACJI.md).

Zachowano oryginalne daty i SHA. Ich obecność nie oznacza, że plan został wykonany. Uzupełnienie używa nowego commita i uwzględnia m.in. ADR0076. Historycznych zapisów o storage, launcherach i ograniczeniach buildów nie należy bezrefleksyjnie stosować do późniejszego checkoutu; L00 wymaga odczytu aktualnych reguł przed implementacją. [G01] [G04]

## 4. Kolejność realizacji

Najpierw stabilne MCP i jego bezpieczeństwo; równolegle można tworzyć read-only asystenta i benchmarki. Następnie authoring z diff i zatwierdzaniem, potem ograniczone uruchamianie oraz obserwacja wyników. Dopiero po uzyskaniu rzeczywistych, zweryfikowanych trajektorii dostrajać model. Na końcu kwalifikować pack po kwantyzacji, pełne pokrycie narzędzi i kolejne poziomy autonomii.

Nie trzeba czekać na wykonanie wszystkich 34 bazowych zadań, aby zacząć każdy element LLM. Plan 12 wskazuje dokładne prerequisites. Nie wolno jednak podłączyć modelu do alternatywnego, niekontrolowanego wykonania Pythona w celu obejścia niegotowego MCP.

## 5. Jak rozumieć „pełna kontrola Fullmaga”

Celem jest obsługa każdego udostępnionego i zakwalifikowanego aspektu produktu: projekty, geometria, materiały, fizyka, siatka, studies, wykonanie, checkpointy, wyniki, kampanie i prezentacja. Pełna kontrola nie oznacza prawa do omijania autoryzacji, samodzielnego podnoszenia limitów ani udawania obsługi brakującego solvera.

Żaden checkpoint modelu nie jest źródłem prawdy o aktualnej dostępności. Wagi, wiedza, kontrakty i runtime mają osobne wersje; brak zgodności prowadzi do ograniczenia zakresu, pytania lub odmowy. Użytkownik nadal może korzystać z Fullmaga bez asystenta i odtworzyć symulację z kanonicznego modelu/skryptu.

## 6. Interpretacja oznaczeń

`DESIGN/PLAN` oznacza projekt. `CODE_READ` oznacza wyłącznie odczyt wskazanego fragmentu kodu. `UPSTREAM_DOCUMENTED` oznacza deklarację oficjalnego źródła. `NOT_RUN` oznacza brak wykonania testu. `PASS` w raporcie 15 dotyczy jedynie wymienionej kontroli dokumentu.

Wszystkie przykłady manifestów z `REQUIRED_*`, null zamiast rzeczywistych hashów lub stanem `design_not_installable/design_not_executed` są schematami projektowymi. Nie należy wprowadzać ich do produkcyjnego registry jako gotowych pakietów.

## Odsyłacze źródłowe

[G01]: 14_ZRODLA_I_DECYZJE_LLM.md#g01
[G04]: 14_ZRODLA_I_DECYZJE_LLM.md#g04
[S02]: 14_ZRODLA_I_DECYZJE_LLM.md#s02
[S03]: 14_ZRODLA_I_DECYZJE_LLM.md#s03
[S05]: 14_ZRODLA_I_DECYZJE_LLM.md#s05
