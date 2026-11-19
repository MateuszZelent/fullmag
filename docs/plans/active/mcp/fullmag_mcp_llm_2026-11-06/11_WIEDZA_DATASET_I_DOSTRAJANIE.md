# Fullmag Assistant — wiedza, dataset, SFT i cykl doskonalenia

**Status:** projekt eksperymentalny i wykonawczy; nie przygotowano rzeczywistego datasetu ani nie wykonano treningu.  
**Cel:** wyspecjalizować otwarty model w poprawnym używaniu Fullmaga, bez uzależniania poprawności fizyki i bezpieczeństwa od pamięci modelu.

## 1. Co faktycznie chcemy nauczyć

Model ma rozumieć po polsku i angielsku intencję badania, odróżniać brakujące dane od dopuszczalnych ustawień domyślnych, odczytywać stan projektu, planować poprawne sekwencje tools, interpretować błędy i przekazywać wyniki zgodnie z receiptami. Powinien wiedzieć, kiedy wykonać `fm_model_validate`, kiedy potrzebna jest nowa siatka, dlaczego nie można zmienić zaakceptowanego snapshotu i dlaczego przerwana odpowiedź nie uzasadnia drugiego submit.

Nie próbujemy umieścić w wagach wszystkich aktualnych identyfikatorów, bieżącej dokumentacji ani wszystkich wyników symulacji. Model nie powinien zapamiętywać prywatnych projektów lub wartości materiałów jako uniwersalnych „prawd”. Generowane schematy i knowledge pack są wersjonowane poza wagami.

### 1.1 Cztery elementy specjalizacji

| Warstwa | Zawartość | Kiedy aktualizować |
|---|---|---|
| Instructions / few-shot | Krótka rola, granice autonomii, poprawne wzorce pytań | Przy zmianie polityki lub UX |
| RAG / schematy | API, publiczny DSL, fizyka, przykłady, status funkcji | Przy zmianie buildu/kontraktu |
| SFT adapter | Sekwencje działań, odczyty stanu, obsługa błędów, PL/EN | Po zebraniu i walidacji nowych trajektorii |
| Deterministyczna aplikacja | Jednostki, uprawnienia, revisions, budget, solver validation | Wraz z implementacją produktu |

SFT służy uczeniu zachowania na sekwencjach. Oficjalny TRL obsługuje rozmowy z wywołaniami i wynikami tools oraz schematami narzędzi. QLoRA jest metodą treningu adapterów przy zamrożonej kwantyzowanej bazie; nie oznacza treningu gotowego pliku GGUF. [S14] [S15] [S16]

## 2. Najpierw baseline, potem trening

Etap B0: model bazowy otrzymuje krótkie instrukcje i dostępne schematy. Etap B1 dodaje retrieval, przykłady i deterministyczne walidatory. Etap B2 dodaje adapter SFT. Wszystkie trzy używają tego samego dozwolonego zakresu narzędzi i tych samych przypadków testowych. Zmiana hosta pomiędzy B1 i B2 uniemożliwia przypisanie poprawy samemu treningowi.

Przed rozpoczęciem SFT zebrać klasy błędów z B1. Jeśli dominują zły parser narzędzi, nieaktualne schematy, brak dokumentacji, błędne capabilities albo nieczytelne błędy API, naprawić integrację. Dataset nie powinien maskować usterki kontraktu przez uczenie obejść.

Dla każdego błędu zapisać: stan wejściowy, prompt, dostępne narzędzia, response, rzeczywisty efekt, brakujący dowód i kategoria przyczyny. Dopiero błędy językowe, wyboru narzędzia lub sekwencji są podstawą do nowych przykładów treningowych.

## 3. Źródła danych i dopuszczenie

### 3.1 Zaufane źródła domenowe

Do korpusu wiedzy: zatwierdzone noty `docs/physics`, kontrakty `docs/specs` i ADR, aktualne schematy tools, dokumentacja publicznego DSL, kwalifikowane przykłady i testy o znanym wyniku. Do trajektorii: zarejestrowane operacje na fixture projektach i ręcznie zatwierdzone demonstracje badacza. Stan funkcji i build są obowiązkowymi metadanymi. [G02]

Dokument planu nie jest pozytywnym dowodem działania. Nazwy `fm_*` z pakietu bazowego pozostają projektowane do czasu implementacji. Rekord może uczyć właściwej odpowiedzi „ta funkcja nie jest dostępna w tym buildzie”, ale nie pozorować wykonania nieistniejącego narzędzia.

Nie indeksować ani nie trenować na `.env`, kluczach, tokenach, prywatnej korespondencji, danych osobowych, niezatwierdzonych logach, przypadkowych plikach użytkownika lub treściach o niejasnych prawach. Każdy dataset release ma Data Card z pochodzeniem, zgodami, licencjami i wykluczeniami.

### 3.2 Syntetyczne zadania i nauczyciel

Większy otwarty model albo zatwierdzony zewnętrzny nauczyciel może generować warianty instrukcji i kandydatów trajektorii. Nauczyciel nie jest źródłem prawdy. Każdy kandydat musi zostać zagrany w kontrolowanym Fullmagu lub oznaczony jako wyłącznie syntetyczny, niekwalifikujący się do pozytywnego zbioru wykonawczego.

Nie wymagać ani nie zapisywać prywatnego chain-of-thought. Potrzebne są obserwowalne wywołania, wyniki tools, krótki plan i wyjaśnienie decyzji. Przy użyciu zewnętrznego nauczyciela sprawdzić warunki wykorzystania outputów oraz zgodę na przekazanie materiału; domyślnie pracować na jawnych fixture projektach.

## 4. Struktura rekordu

### 4.1 Schemat logiczny

Każda trajektoria zawiera `scenario_id`, `family_id`, `split`, `fullmag_build`, `tool_contract_digest`, `capability_fixture`, `initial_state_ref`, `messages`, `tools_schema_ref`, `expected_invariants`, `execution_receipt_refs`, `review_status`, `data_provenance` i `license_policy`. Wersja instrukcji systemowej jest elementem metadanych, a nie ukrytym stringiem zaszytym w skrypcie treningowym.

Normalized messages przechowują role użytkownika, asystenta i narzędzi, nazwy wywołań oraz argumenty jako obiekty. Osobny renderer buduje natywny template Qwen albo Gemma; nie kopiuje tokenów sterujących jednej rodziny do drugiej. Gemma ma własną strukturę function calling, dlatego potrzebny jest round-trip test serializacji. [S06]

### 4.2 Przykład poglądowy — nie gotowy rekord treningowy

```json
{
  "schema_version": "assistant.trajectory.v1",
  "scenario_id": "platform-discovery-demo",
  "family_id": "readiness-discovery",
  "split": "train",
  "review_status": "design_not_executed",
  "fullmag_build": "REQUIRED_QUALIFIED_BUILD",
  "tools_schema_ref": "REQUIRED_EXACT_SCHEMA_BUNDLE",
  "messages": [
    {"role": "user", "content": "Sprawdź możliwości tej instalacji; niczego nie uruchamiaj."},
    {"role": "assistant", "tool_calls": [{"id": "call-demo-1", "name": "fm_platform_get", "arguments": {}}]},
    {"role": "tool", "tool_call_id": "call-demo-1", "content": {"fixture_only": true, "runtime_state": "ready"}},
    {"role": "assistant", "content": "Instalacja odpowiada. Nie uruchomiono żadnej symulacji; dostępność konkretnego problemu wymaga sprawdzenia capabilities."}
  ],
  "expected_invariants": ["no_model_mutation", "no_compute_admission"],
  "execution_receipt_refs": []
}
```

Dataset builder odrzuca `design_not_executed`, placeholdery oraz pozytywne rezultaty bez receiptów. W konwersji do TRL pole `tools` rozwija się z exact schema bundle; nie pomija się definicji narzędzi. `tools_schema_ref` jest formatem źródłowym Fullmaga, a nie obietnicą, że TRL bezpośrednio je interpretuje. [S14]

## 5. Podział danych bez przecieku

Grupą splitu jest **rodzina problemu i generatora**, nie pojedynczy wiersz rozmowy. Tłumaczenie PL/EN, zmiana nazw obiektów, perturbacja parametrów i wariant z literówką pozostają w tej samej grupie. Kopie tego samego skryptu po zmianie whitespace lub UUID nie są niezależnymi testami.

Proponowany podział danych roboczych: 80% train, 10% development, 10% test według grup. Osobny sealed acceptance set tworzy reviewer niepiszący generatora. Train/development można powiększać po analizie błędów; sealed set nie służy do iteracyjnego doboru promptu ani hyperparametrów.

Dodatkowe split axes: geometria niewidziana w train; nowa kompozycja znanych operations; nieznane wartości parametrów; inny backend; zmieniony schema digest; brak wymaganej capability; użytkownik zmieniający decyzję w dialogu. Zestaw future-API sprawdza discovery, nie zdolność zgadnięcia nowych nazw.

Kontrola duplikatów obejmuje teksty, kanoniczne AST skryptów, semantic model hash i historię po anonimizacji identyfikatorów. Narzędzie utrzymuje mapę lineage. Wyciek między splitami blokuje publikację wyniku, nawet jeśli poprawia score.

## 6. Curriculum i proporcje

Początkowo przygotować około **150 ręcznie sprawdzonych seed scenarios**. Następnie zbudować **2–5 tys. zweryfikowanych trajektorii** jako eksperyment SFT; dopiero po ablacjach rozważyć **10–30 tys.**. Są to proponowane zakresy projektowe, nie liczby gwarantujące poprawę. Ważniejsza jest różnorodność poprawnych i niepoprawnych stanów niż liczba parafraz.

| Rodzina | Udział startowy | Przykładowa umiejętność |
|---|---:|---|
| Odczyt, discovery, dokumentacja | 15% | Stan instalacji, capabilities, brak mutacji |
| Authoring i zmiany parametrów | 25% | Geometria, materiały, jednostki, diff |
| Study, meshing, preflight | 15% | Inwalidacja siatki, plan i quality |
| Execute, monitor, control | 15% | Prepare, submit, receipt, cancel/retry |
| Wyniki i raportowanie | 10% | Odczyt artefaktów, ocena naukowa, brak wymyślonych danych |
| Błędy i recovery | 10% | Conflict, timeout, stary token, OOM inference |
| Braki, odmowa i injection | 10% | Pytanie zamiast zgadywania, blokada nielegalnych efektów |

Każda rodzina obejmuje PL i EN. Połowę naturalnych instrukcji przygotować po polsku, a część w mieszaninie terminów polskich i angielskich, skrótów fachowych oraz realistycznych literówek. Zachować poprawne identyfikatory API; model nie powinien uczyć się, że można je literować dowolnie.

Poziomy trudności: pojedynczy read; pojedyncza transakcja; sekwencja kilku etapów; naprawa po realnym błędzie; dialog z korektą intencji; delegowana kampania. Łatwe przykłady nie mogą dominować testu końcowego i maskować niepowodzeń sekwencyjnych.

## 7. Weryfikator trajektorii

Najpierw waliduje format, dostępność tools i schemat argumentów. Następnie odtwarza początkowy projekt i wykonuje dozwolone operacje w fixture scope. Na końcu porównuje stan semantyczny, zdarzenia, koszty i artefakty z niezależnymi oczekiwaniami. Trening nie może traktować tekstu odpowiedzi narzędzia jako wystarczającego dowodu, jeśli nie ma trwałego efektu.

**Pozytywne kryteria:** poprawny kanoniczny model, zachowana intencja, wszystkie kroki w uprawnieniach, brak niezamierzonego Solve, poprawne zależności runów, właściwe jednostki i ocena naukowa. **Negatywne kryteria:** brak mutacji, właściwy kod odmowy, brak wycieku danych, brak przekroczenia budżetu i brak podwójnego submit.

Porównanie nie opiera się wyłącznie na bajtowym skrypcie: dwie reprezentacje mogą dać równoważny model. Kanoniczna normalizacja pomija presentation-only nazwy, jeśli scenariusz na to pozwala, ale nie pomija geometrii, BC, fizyki, integratora, observables lub requested execution. Kryteria równoważności muszą być zapisane przed oceną kandydata.

Część testów wykonuje małe symulacje, część wystarczy zakończyć na IR/preflight. Nie uruchamiać dużego solve dla każdej parafrazy. Kwalifikacja naukowa potrzebuje jednak osobnego zestawu rzeczywistych uruchomień; mock nie wystarcza.

## 8. Przypadki, których nie wolno pominąć

Model ma pytać o rozmiar i parametry, gdy ich brak, a nie wybierać materiał „z pamięci”. Powinien zachować wymuszone GPU mimo zajętej karty, nie zmieniać single/double w celu zmieszczenia LLM i odróżniać `limit_reached` od zbieżności. Ma odczytać nową rewizję po konflikcie, a nie wyłączyć ochronę revisions. [G07] [G08]

W danych muszą wystąpić: brak odpowiedzi po submit, callback ze starej próby, zamknięcie UI, utrata procesu inference, zmiana sesji przez człowieka, próba odczytu obcego projektu, instrukcja ukryta w logu oraz materiał nazwany poleceniem powłoki. System ma zachować granice nawet wtedy, gdy model sformatuje niepożądane wywołanie idealnie.

Dla fizyki: układ skończony vs periodyczny; wymuszone vs termiczne fale; pole zadane vs pole liczone z transportu; stale checkpoint; brak jakości siatki; nieobsługiwany solver. Te przypadki mają uczyć rozpoznawania kontraktu, a nie nowego sposobu liczenia fizyki przez LLM.

## 9. Receptura SFT: punkt startowy do eksperymentu

Nie podajemy nieprzetestowanego skryptu jako gotowego treningu. Implementacja ma powstać po przypięciu kompatybilnego zestawu Transformers/PEFT/TRL/torch/CUDA i po smoke test modelu, tokenizerów i chat template. Źródłem konfiguracji są oficjalne biblioteki; planowane hyperparametry są naszymi hipotezami eksperymentalnymi. [S14] [S15]

| Parametr | Propozycja startowa |
|---|---|
| Baza | Instruction/post-trained checkpoint, dokładny revision hash |
| Metoda | LoRA BF16 jako punkt odniesienia; QLoRA NF4 jako wariant oszczędny, jeśli wspierany |
| Rank | Porównać r=16 i r=32 |
| Alpha | 2×r jako punkt startowy |
| Dropout | 0.05; porównać z 0 przy przeuczeniu/underfitting |
| Learning rate | Mała siatka 5e-5 / 1e-4 / 2e-4 |
| Epochs | 1–3, wybór po development task-success, nie po samym loss |
| Sequence length | 4096 dla krótkich trajektorii; 8192 w drugim przebiegu; nie ucinać tool result |
| Efektywny batch | 32 przykłady przez gradient accumulation, jeśli pamięć pozwala |
| Loss | Głównie tokens asystenta i tool-call arguments; nie uczyć przewidywania odpowiedzi narzędzi jako własnych faktów |
| Stabilność | Gradient clipping, kontrola NaN/Inf, seed/revision i trainable-parameter report |

To nie jest pełny Cartesian sweep wszystkich parametrów; najpierw smoke i mały eksperyment, potem najważniejsze ablations. Pełny fine-tuning nie jest pierwszą rekomendacją.

### 9.1 Dobór modułów adaptera

Nie hardcodować listy `q_proj/k_proj/v_proj` dla każdej architektury. Trainer sprawdza rzeczywiste nazwy modułów, typy i obsługę przez PEFT, tworzy jawny manifest trainable parameters oraz porównuje ich liczbę z oczekiwaniem. Początkowo dostrajamy tekstowy decoder; nie włączamy encodera obrazu/audio, embeddingów lub lm_head bez osobnej decyzji i ewaluacji.

Dla hybrydowego Qwen albo Gemma z PLE trzeba oddzielnie sprawdzić, które moduły są adaptowane i jak to wpływa na eksport. Popularna opcja `all-linear` może obejmować więcej niż oczekiwano; właściwy wybór wymaga inspekcji konkretnego checkpointu, a nie mechanicznego przeniesienia receptury innej rodziny.

### 9.2 Maskowanie i template parity

Test na kilkunastu małych rekordach musi pokazać, które tokeny uczestniczą w loss. Wszystkie istotne nazwy narzędzi, klamry, liczby i argumenty mają być uczone; tekst user i długie tool results nie powinny przypadkiem dominować loss. Maski muszą odpowiadać natywnemu szablonowi danej rodziny.

Sprawdzić EOS, zakończenie tool call, puste odpowiedzi, wiele odczytów, Unicode, polskie znaki, znaki sterujące i długie liczby. Nie stosować jednego surowego template tylko dlatego, że oba modele potrafią zwrócić JSON. [S06] [S14]

### 9.3 Kontrola pamięci treningu

Wymagania adapter training obejmują bazę, optimizer state, gradienty adaptera, activations, sekwencję i batch. Nie wynikają z samego `N×4bit`. Każdy eksperyment mierzy peak GPU/RAM; brak pamięci rozwiązuje się zmianą jawnej receptury treningowej, nie obniżeniem precyzji symulacji naukowej. Oryginalna publikacja QLoRA opisuje metodę, a nie gwarancję pamięci dla Qwen3.5/Gemma 4. [S16]

## 10. Eksport, merge i kwantyzacja

Zachować adapter i dokładną bazę. Porównać inference z aktywnym adapterem w referencyjnym silniku z modelem po merge. Następnie wykonać kwalifikowaną konwersję i kwantyzację do docelowego runtime. Każdy etap tworzy nowy digest i własny receipt.

QLoRA NF4 w treningu nie jest tym samym formatem co GGUF Q4. Nie należy „dostroić GGUF” bez osobno wspieranej metody ani zakładać, że adapter da się bezstratnie przenieść między architekturami. Gemma QAT stanowi osobną ścieżkę przygotowania; merge adaptera nie gwarantuje zachowania właściwości oryginalnej QAT.

Ponownie uruchomić testy parsera, jednostek, schema adherence, pełnych workflow i odmów. Wpływ kwantyzacji mierzyć na wyniku zadania, nie tylko perplexity. Jeśli Q4 traci wymagane zachowanie, użyć wyższej precyzji albo obniżyć poziom kwalifikowanej autonomii; nie obniżać bramek bezpieczeństwa.

## 11. Czy stosować DPO, RL i continued pretraining?

**DPO** rozważyć dopiero po stabilnym SFT i z parami odpowiedzi różniącymi się rzeczywistą jakością działania. Przykład: poprawne pytanie o brakujące warunki kontra wymyślenie wartości; nie „długi tekst kontra krótki tekst”. Zachować testy regresji i narzędzi.

**RL z nagrodą wykonawczą** jest etapem badawczym po wdrożeniu bezpiecznego replay sandboxa i ograniczeń kosztu. Nagroda nie może premiować samych `succeeded`, liczby tool calls lub braku odmów; musi uwzględniać semantykę, koszty, niepożądane efekty i jakość naukową. Optymalizacja na walidatorze generującym dane grozi uczeniem luk w tym walidatorze.

**Continued pretraining na kodzie i dokumentacji** nie jest etapem pierwszym. RAG łatwiej aktualizować i cytować, a SFT łatwiej ukierunkować na zachowanie. Dodatkowy pretraining wymaga wykazania brakującej wiedzy, kontroli forgetting i praw do korpusu. Nie ma uzasadnienia do kopiowania całego repozytorium do treningu bez selekcji.

## 12. Uczenie z użycia i utrzymanie

Nie trenować modelu samoczynnie podczas pracy użytkownika. Opcjonalny eksport trajektorii wymaga zgody, redakcji, sprawdzenia praw i ręcznego review; użytkownik widzi, co wyjdzie poza projekt. Dane do usunięcia muszą mieć lineage pozwalający wskazać dotknięte dataset/model releases.

Pętla poprawy: error taxonomy → poprawa hosta/API albo nowy seed case → replay verification → dataset release → training candidate → sealed evaluation → canary → model pack release. Nie ma kroku „model powiedział, że teraz jest lepszy”.

Co release Fullmaga: sprawdzić schema drift, nieobsługiwane tools, retrieval zgodność i priorytety dokumentacji. Nowe możliwości najpierw zyskują schemat i fixture; dopiero potem pozytywne przykłady SFT. Model niewystarczająco pewny nowej funkcji korzysta z discovery lub pyta, zamiast tworzyć alternatywny API.

## 13. Artefakty wymagane do publikacji adaptera

Data Card; manifest danych i splitów; manifest trainable parameters; kompletna konfiguracja treningu; wyniki baseline/RAG/SFT; receipt konwersji; raport quantization regression; model card Fullmaga; macierz kwalifikowanych buildów, narzędzi i autonomii; licencje; plan rollback. Sam plik `adapter.safetensors` nie jest wydaniem produktu.

## Odsyłacze źródłowe

[G02]: 14_ZRODLA_I_DECYZJE_LLM.md#g02
[G07]: 14_ZRODLA_I_DECYZJE_LLM.md#g07
[G08]: 14_ZRODLA_I_DECYZJE_LLM.md#g08
[S06]: 14_ZRODLA_I_DECYZJE_LLM.md#s06
[S14]: 14_ZRODLA_I_DECYZJE_LLM.md#s14
[S15]: 14_ZRODLA_I_DECYZJE_LLM.md#s15
[S16]: 14_ZRODLA_I_DECYZJE_LLM.md#s16
