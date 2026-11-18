# Fullmag Assistant — wybór modelu, inference i dystrybucja

**Stan źródeł:** sprawdzono 6.11.2026. **Wyniki lokalne:** NOT_RUN.  
**Charakter decyzji:** shortlista i procedura wyboru; nie ranking potwierdzony na Fullmagu.

## 1. Rekomendacja

Do pierwszego bake-off wybrać **Qwen3.5-4B**, **Qwen3.5-9B** i **Gemma 4 E4B**. Przyjąć roboczo Qwen3.5-4B jako bazę profilu Lite, a Qwen3.5-9B jako bazę profilu Workstation, ale nie publikować żadnego z nich jako domyślnie bezpiecznego operatora bez ewaluacji. Gemma 4 E4B może zastąpić którykolwiek profil, jeżeli osiągnie lepszy wynik domenowy w określonym budżecie.

Są to świadomie dobrane małe modele, nie twierdzenie o „najnowszym Qwenie”. Oficjalny katalog zawiera również Qwen3.8, w tym wariant 27B; można go użyć jako większego punktu odniesienia lub nauczyciela. Nie musi być częścią instalacji użytkownika. [S02] [S03] [S05] [S09] [S19]

Gemma 4 nie jest hipotezą ani nazwą przyszłego produktu: istnieją oficjalne wagi i dokumentacja function calling. Nie należy powtarzać dawnych informacji o braku roli system albo licencji starszych Gemma bez sprawdzenia konkretnej generacji. [S04] [S06] [S07]

## 2. Shortlista kandydatów

| Model upstream | Rola w eksperymencie | Co potwierdzono | Co pozostaje do sprawdzenia |
|---|---|---|---|
| `Qwen/Qwen3.5-4B` | Lite; typed operations, instrukcje i prostsze workflow | Oficjalne wagi, deklaracja Apache-2.0, dokumentacja tool use [S02] | PL, długie sekwencje, zgodność parsera/GGUF i jakość po SFT |
| `Qwen/Qwen3.5-9B` | Workstation; szersze authoring i naprawa błędów | Oficjalne wagi, Apache-2.0 [S03] | Czy poprawa wobec 4B uzasadnia VRAM i latencję |
| `google/gemma-4-E4B-it` | Konkurent jakościowo-sprzętowy | Function calling, Apache-2.0; około 4.5B effective, 8B z embeddings [S05] [S06] | Wierność szablonu, adapter SFT, pamięć po kwantyzacji, język polski |
| `google/gemma-4-E2B-it` | Opcjonalny profil minimalny / routing i proste zadania | Rodzina i rozmiar opisane w oficjalnej dokumentacji [S04] [S05] | Czy bezpieczna abstencja i poprawne sekwencje są wystarczające |
| `Qwen/Qwen3.8-27B` | Większy benchmark/nauczyciel | Istniejący większy model Apache-2.0 [S09] | Koszt, jakość nauczyciela i przydatność do danych, nie kwalifikacja Lite |

Wybór mniejszego modelu nie musi oznaczać okrojenia katalogu funkcji. Ogranicza przede wszystkim poziom **kwalifikowanej autonomii**: może obsługiwać szeroki katalog przy częstszych wyjaśnieniach, kontrolach i zatwierdzeniach. Pojemność funkcjonalna produktu i skuteczność samodzielnego planowania są osobnymi osiami.

Nie porównywać bezpośrednio marketingowych benchmarków producentów, gdy różnią się wersją testu, harness, budżetem reasoning lub szablonem. Wybór dla Fullmaga opiera się na tych samych scenariuszach, stanie narzędzi, budżecie i kryteriach.

## 3. Czym model jest, a czym nie jest

Model przewiduje tekst i propozycje użycia narzędzi. MCP nie jest zestawem wag, a fine-tuning nie instaluje serwera MCP w modelu. Uczymy model interpretować opisy tools i stosować workflow; host tłumaczy znormalizowane wywołania na protokół, a serwer wykonuje autoryzowane operacje. [S01] [S06]

Nie ma potrzeby trenowania LLM od zera. Najpierw wykorzystujemy istniejący instruction-tuned model, wersjonowaną wiedzę i dobre schematy. SFT adapter jest kolejnym eksperymentem. Brak improvement przy uczciwym teście oznacza pozostawienie modelu bazowego, a nie zwiększanie datasetu w ciemno.

## 4. Wybór silnika inference

### 4.1 Profil lokalny

**Pierwszy kandydat: zarządzany `llama.cpp` / `llama-server`**, uruchamiany jako odizolowany proces. Powód projektowy: możliwość pakowania lokalnego silnika, kontrola cyklu życia, kwantyzowane artefakty i odseparowanie awarii inferencji od API. Konfigurację function calling i ograniczania formatu opieramy na oficjalnej dokumentacji, ale kwalifikujemy **konkretny build + model + konwerter + parser**. [S10] [S11]

To nie jest deklaracja, że każdy aktualny model będzie od razu poprawnie działać w wybranej kompilacji llama.cpp. Jeśli konwersja lub parser nie przechodzi golden testów, ten model pack jest niedopuszczony. W fazie badawczej można użyć Transformers/vLLM jako referencji; nie publikujemy niedziałającego profilu GGUF pod tą samą etykietą.

Worker nie przyjmuje dowolnych flag od modelu. Parametry procesu pochodzą z zatwierdzonego manifestu, np. model path, device, context cap i token budget. Port jest prywatny, zarządzany przez supervisor, a proces ma własne identity i grupę procesów. OOM modelu nie zatrzymuje natywnego solvera.

### 4.2 Profil laboratoryjny/HPC

**vLLM** jest alternatywnym providerem do większego throughputu, referencyjnych testów oraz eksperymentów z większym modelem. Parser funkcji dobiera się do rodziny; podobieństwo endpointu HTTP nie gwarantuje identycznej semantyki. Sleep mode może być elementem polityki współdzielenia GPU, ale wymaga pomiaru zwolnionej pamięci. [S12] [S13]

Nie włączamy automatycznie zewnętrznego providera, gdy zabraknie pamięci lokalnie. Użytkownik musi widzieć, gdzie przetwarzany jest projekt. Serwer laboratoryjny może pozostawać w granicy lokalnej organizacji, lecz nadal wymaga polityki dostępu, retencji i ograniczenia danych.

### 4.3 Profil badawczy

Transformers + PEFT + TRL służy przede wszystkim do przygotowania i treningu adapterów oraz generowania referencyjnych outputów. Nie dodajemy pełnego stosu treningowego do obowiązkowych zależności aplikacji desktopowej. Qwen-Agent może być kontrolnym harness do porównania integracji narzędzi, ale nie zastępuje trwałych kontraktów Fullmaga. [S14] [S15] [S18]

## 5. Pamięć: nie wystarczy liczba parametrów

Dla nominalnego N parametrów i b bitów idealna pamięć samych wag wynosi `N × b / 8`. Poniższa tabela jest **arytmetycznym przybliżeniem**, nie pomiarem pliku ani minimalnym wymaganiem VRAM. Przyjęto 1 GiB = 2^30 bajtów i dokładnie podane nominalne N.

| Nominalne N | Idealne wagi 4-bit | Idealne wagi 16-bit |
|---|---:|---:|
| 4 mld | 1.86 GiB | 7.45 GiB |
| 8 mld | 3.73 GiB | 14.90 GiB |
| 9 mld | 4.19 GiB | 16.76 GiB |
| 27 mld | 12.57 GiB | 50.29 GiB |

Realny szczyt ma dodatkowe składniki:

```text
peak_memory = weights + quantization_metadata + KV_cache
            + recurrent_state + runtime_workspace + multimodal_buffers
            + allocator_overhead + safety_reserve
```

W modelach hybrydowych lub z sliding-window nie należy bez sprawdzenia stosować jednego klasycznego wzoru KV cache do wszystkich warstw. Cały kontekst, liczba równoległych sekwencji, dtype cache, graph capture i prefilling mogą zmienić szczyt. Gemma E4B wymaga uwzględnienia embeddings; MoE wymaga wag nieaktywnych ekspertów, chyba że konkretny runtime świadomie je offloaduje. [S05]

### 5.1 Profile sprzętowe do kwalifikacji, nie obietnice działania

| Profil testowy | Cel | Polityka współpracy z Fullmagiem |
|---|---|---|
| CPU-only, 32 GiB RAM | Lite, krótki kontekst, bez zależności od CUDA | Ograniczenie wątków; admission wspólnej RAM z mesherem/solverem |
| GPU 8 GiB | Lite Q4 z kontekstem ograniczonym testem | Domyślnie sequential: plan → unload → solve |
| GPU 16 GiB | Workstation Q4/Q5 lub Lite współbieżny | Współbieżność tylko po pomiarze; nie zakładać miejsca na dowolną siatkę |
| GPU 24 GiB lub więcej | Dłuższy kontekst / większy model albo równoległość | Oddzielne limity inference i solvera; liczba sesji nie wynika wyłącznie z VRAM |
| Dedykowany węzeł laboratoryjny | vLLM, teacher, SFT i benchmarki | Osobny zatwierdzony profil; brak uruchamiania treningu przy okazji Solve |

Dostępny w zespole sprzęt wielokartowy może przyspieszyć eksperymenty, ale nie staje się wymaganiem użytkowników Fullmaga. Żaden wynik z H100 nie zastępuje kwalifikacji lokalnego 4-bitowego modelu na docelowym komputerze.

### 5.2 Eksperyment pamięci i szybkości

Mierzyć osobno cold load, hot prefill, first-token latency, decode, pełny czas osiągnięcia poprawnego stanu zadania, CPU RSS, GPU peak, disk footprint i release latency. Przetestować konteksty 4k/8k/16k/32k, nie tylko krótki „hello”. Dla każdego profilu wykonać również run z równoczesnym małym solverem i próbę admission większej symulacji.

Przepustowość tokenów nie jest jedyną metryką. Model wolniejszy, ale potrzebujący dwóch poprawnych operacji zamiast dziesięciu błędnych, może być lepszy. Nie podajemy tu niezmierzonych wartości tokens/s ani przewidywanego czasu treningu.

## 6. Licencje i wbudowanie w repozytorium

Odczytane karty Qwen3.5 oraz Gemma 4 wskazują Apache-2.0. Google wyraźnie odsyła Gemma 4 do osobnej licencji względem wcześniejszych warunków Gemma. Weryfikacja obejmuje dokładny artefakt, a nie samo słowo „Gemma”. [S02] [S03] [S05] [S07] [S08]

To przegląd techniczny dystrybucji, nie rozstrzygnięcie prawne wszystkich możliwych danych treningowych. Przed publikacją trzeba osobno sprawdzić pochodzenie danych, prawa do wygenerowanych trajektorii, notices bibliotek, konwerterów i kwantyzacji. Licencja kodu Fullmaga nie zostaje automatycznie licencją cudzych wag ani odwrotnie.

### 6.1 Co trafia do Git

W repozytorium umieścić implementację, registry modeli, dokładne receptury przygotowania, małe testowe przykłady, schematy datasetu, listę pochodzenia danych i dokumentację. Nie commitować wielogigabajtowych wag do zwykłej historii Git. Rozbudowa modelu nie powinna zwiększać rozmiaru każdego checkoutu lub worktree o kolejne kopie.

Artefakty publikować w wersjonowanym magazynie: upstream weights na przypiętej rewizji, adapter Fullmaga jako oddzielny pack, a kwalifikowany model po merge/konwersji jako osobny plik z checksum. Git LFS może być świadomą opcją dystrybucji, ale nie jest konieczny i nie usuwa kosztu pobierania w CI.

### 6.2 Dwa tryby instalacji

**Online opt-in:** instalator pokazuje rozmiar, licencję, model pack i cel pobrania; po zgodzie pobiera dokładną listę plików, weryfikuje digests i publikuje je atomowo. Nie pobiera `main` przy każdym starcie.

**Offline:** administrator dostarcza samowystarczalny archive z wagami, tokenizerem, template, parser config, licencją i manifestem. Import sprawdza rozmiary, ścieżki, symlinki, duplikaty i podpis. Brak Internetu po instalacji nie może wywoływać niejawnych timeoutów w krytycznej ścieżce UI.

### 6.3 Manifest model pack — kontrakt projektowany

```json
{
  "schema_version": "assistant.model_pack.v1",
  "pack_id": "fullmag-assistant-lite-candidate",
  "upstream_model_id": "Qwen/Qwen3.5-4B",
  "upstream_revision": "REQUIRED_IMMUTABLE_REVISION",
  "artifact_state": "design_not_installable",
  "inference_engine": "llama.cpp",
  "engine_revision": "REQUIRED_QUALIFIED_REVISION",
  "tokenizer_digest": "REQUIRED_SHA256",
  "chat_template_digest": "REQUIRED_SHA256",
  "tool_parser_revision": "REQUIRED_QUALIFIED_REVISION",
  "quantization": "candidate_q4",
  "context_limit_tokens": 16384,
  "qualified_autonomy": [],
  "qualification_receipt_ref": null,
  "license_id": "Apache-2.0"
}
```

To **nie jest plik gotowy do instalacji**. Wartości `REQUIRED_*` celowo powodują odrzucenie przez walidator produkcyjny. Plan nie wymyśla rewizji wag, których nie pobrano. Kandydat do wydania musi dodatkowo zawierać listę wszystkich plików z dokładnymi hashami, wielkościami, źródłami, podpisem manifestu, kompatybilnymi kontraktami MCP i zakresem testów.

Wagi w Safetensors/GGUF nie oznaczają braku ryzyka parsera: ograniczyć wejścia, wersjonować loader, skanować zależności i nie włączać `trust_remote_code` dla niezweryfikowanego pakietu. Podpis manifestu jest istotny: sam hash pobrany z tego samego skompromitowanego miejsca nie zapewnia autentyczności.

## 7. Model release i rollback

Wydanie wiąże model bazowy, adapter, quantizer, chat template, parser, policy, wiedzę i tool contract. Każdą z tych osi można wersjonować oddzielnie, ale kwalifikowany pack wskazuje jeden dokładny zestaw. Przy zmianie runtime schematów stary adapter może wejść w read-only lub zostać zablokowany, zamiast wywoływać nieaktualne narzędzia.

Rollback przełącza nowe rozmowy na ostatni poprawny pack. Rozpoczęty turn zostaje dokończony bez nowych efektów albo zatrzymany i odtworzony z journal; nie mieszamy dwóch tokenizerów w jednym kontekście. Zaakceptowane runy pozostają bez zmian. Artefaktu wag nie usuwa się, dopóki trwa jego lease albo odnosi się do niego wymagany audit.

Nie trzeba przechowywać wag w projekcie naukowym, aby odtworzyć **symulację**: wystarcza zaakceptowany skrypt/IR i runtime. Odtworzenie **decyzji agenta** wymaga dodatkowo exact model pack, kontekstu i konfiguracji generacji; zwykle nie jest bitowo deterministyczne między różnymi urządzeniami, co należy wyraźnie odróżnić.

## 8. Procedura wyboru zwycięzcy

Najpierw wyeliminować konfiguracje niepoprawnie serializujące funkcje albo przekraczające pamięć. Następnie mierzyć poprawność całych zadań, brak nieautoryzowanych efektów, reakcję na niepewność i jakość PL/EN. Dopiero wśród konfiguracji spełniających bramki bezpieczeństwa wybierać Pareto jakości/czasu/pamięci.

Porównywać trzy konfiguracje każdego kandydata: bazowy + krótkie instrukcje; bazowy + RAG i schematy; ten sam zestaw + SFT. Dla finalisty osobno Q4 i wyższa precyzja. Nie promować SFT tylko dlatego, że training loss spadł. Wynik benchmarku i profil sprzętowy należy opublikować razem z rekomendacją.

## Odsyłacze źródłowe

[S01]: 14_ZRODLA_I_DECYZJE_LLM.md#s01
[S02]: 14_ZRODLA_I_DECYZJE_LLM.md#s02
[S03]: 14_ZRODLA_I_DECYZJE_LLM.md#s03
[S04]: 14_ZRODLA_I_DECYZJE_LLM.md#s04
[S05]: 14_ZRODLA_I_DECYZJE_LLM.md#s05
[S06]: 14_ZRODLA_I_DECYZJE_LLM.md#s06
[S07]: 14_ZRODLA_I_DECYZJE_LLM.md#s07
[S08]: 14_ZRODLA_I_DECYZJE_LLM.md#s08
[S09]: 14_ZRODLA_I_DECYZJE_LLM.md#s09
[S10]: 14_ZRODLA_I_DECYZJE_LLM.md#s10
[S11]: 14_ZRODLA_I_DECYZJE_LLM.md#s11
[S12]: 14_ZRODLA_I_DECYZJE_LLM.md#s12
[S13]: 14_ZRODLA_I_DECYZJE_LLM.md#s13
[S14]: 14_ZRODLA_I_DECYZJE_LLM.md#s14
[S15]: 14_ZRODLA_I_DECYZJE_LLM.md#s15
[S18]: 14_ZRODLA_I_DECYZJE_LLM.md#s18
[S19]: 14_ZRODLA_I_DECYZJE_LLM.md#s19
