# Raport Claude — audyt planu refaktoryzacji runtime CAE

## 00. Werdykt i podsumowanie wykonawcze

**Data audytu:** 20 września 2026 r.
**Audytor:** Claude (Opus 5), sesja Cowork, praca na lokalnym checkoucie `C:\git\fullmag\fullmag`.
**Przedmiot:** `docs/plans/active/refactor_runtime/` — dokumenty `01-architektura-cae.md`,
`02-kontrakty.md`, `03-migracja.md`, `04-scenariusze.md`, `05-dowody-i-adr.md` oraz
`raport_gemini/00..05`.
**Metoda:** odczyt całości dokumentacji, następnie niezależna weryfikacja twierdzeń
bezpośrednio w drzewie źródeł (`git show`, `grep`, `sed` na plikach repozytorium).
Wszystkie cytaty plik:linia w tym raporcie zostały sprawdzone przeze mnie w tej sesji —
rejestr znajduje się w `06-rejestr-dowodow-claude.md`.

---

## 1. Werdykt skrócony

| Wymiar | Ocena | Uzasadnienie w jednym zdaniu |
|---|:---:|---|
| Zasadność refaktoryzacji | **Potwierdzona bez zastrzeżeń** | Dowody w kodzie są mocniejsze, niż plan twierdzi — 288 z 293 endpointów v2 to `/v2/sessions/current/*`, a bez sesji UI pokazuje wyłącznie przycisk „Create simulation”. |
| Poprawność twierdzeń o kodzie | **Wysoka; 2 drobne błędy cytowań** | E01–E16 zweryfikowane; błędne są jedynie zakresy linii w E15 i E16. |
| Kompletność warstwy domenowej | **Wysoka** | Ontologia, kontrakty K01–K18 i scenariusze CAE-01..60 są spójne i wystarczające jako specyfikacja. |
| Kompletność warstwy wdrożeniowej | **Niewystarczająca** | 6 istotnych luk: pominięty korpus istniejących ADR, `resource_key` zapisywane w manifestach artefaktów, błąd GC w CAS, brak `fsync`, niedoszacowana skala API, pominięty crate `fullmag-quantities`. |
| Wpływ na UI / zbliżenie do COMSOL/CST | **Kierunkowo prawidłowy** | Plan poprawnie zakłada jeden aktywny viewport; wymaga natomiast dopisania warstwy „Results” i jawnego rozstrzygnięcia relacji do ADR-0016. |
| Jakość raportu Gemini | **Częściowo błędna — wymaga sprostowania** | Jedna z jego czterech głównych rekomendacji UI jest sprzeczna z zaakceptowanym ADR i złamie istniejący audyt CI; jedno z „ryzyk” (50+ komponentów) nie istnieje. |

**Wniosek główny:** plan `01`–`05` jest dobrym, uczciwym i technicznie dojrzałym
dokumentem. Nie wymaga przepisania. Wymaga **uzupełnienia o sześć rzeczy, których nie
zauważył ani autor planu, ani audyt Gemini**, oraz **odrzucenia dwóch rekomendacji
Gemini**, które w obecnym brzmieniu wprowadziłyby regresję.

---

## 2. Rzecz najważniejsza: lokalny checkout nie jest bazą planu

Plan i raport Gemini deklarują bazę `31bac350a15c0af070287de92d4e0c1a6dabab0e`.
Lokalne repozytorium, w którym te dokumenty leżą, stoi na innym commicie:

```text
HEAD (lokalne master) = 33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8  (14 wrz 2026)
baza planu            = 31bac350a15c0af070287de92d4e0c1a6dabab0e  (15 wrz 2026)

git merge-base --is-ancestor 31bac... HEAD  -> NO
git merge-base --is-ancestor HEAD 31bac...  -> YES
git rev-list --count HEAD..31bac...          -> 18
```

Lokalny `master` jest **18 commitów za** bazą planu. Twierdzenie raportu Gemini
(`01-weryfikacja-kodu-i-faktow.md`, E01): *„Potwierdzono. Repozytorium znajduje się na
commicie 31bac...”* jest **nieprawdziwe dla tego checkoutu**.

Sprawdziłem, czy ma to znaczenie merytoryczne: dla wszystkich 18 plików kluczowych dla
planu treść na `HEAD` i na bazie jest identyczna (por. `06-rejestr-dowodow-claude.md`,
tabela D-00). Wnioski audytu pozostają więc ważne. Ale:

- **przed startem P0 należy zsynchronizować lokalny checkout z bazą planu**, w przeciwnym
  razie fixtures P0 zostaną zamrożone na innym stanie niż ten, do którego odnoszą się
  wszystkie cytowania E01–E16;
- deklaracja „100% zgodności” w raporcie Gemini powstała bez sprawdzenia tego faktu, co
  obniża wiarygodność pozostałych jego deklaracji „100%”.

---

## 3. Sześć luk, których nie ma ani w planie, ani w audycie Gemini

Szczegóły i dowody: `03-luki-i-bledy-planu.md`.

| # | Luka | Gdzie uderza | Waga |
|---|---|---|:---:|
| L1 | **Plan nie odnosi się do 34 istniejących ADR** (`docs/adr/`), w tym ADR-0011 resource-first API, ADR-0012 canonicalization backbone, ADR-0016 center viewport tabbed surfaces, ADR-0025 trwały runtime i `AcceptedStateRef`, ADR-0029 dataset/slice, ADR-0030 project storage. ADR-0025 definiuje już tożsamości i fencing pokrywające się z K02/K09/K13 — i **nie jest zaimplementowany** (brak `AcceptedStateId`, `ObservationRuntime`, `runtime_epoch` w kodzie). | 05-dowody-i-adr, K02, K09, K13 | **Krytyczna** |
| L2 | **Runner zapisuje URL-e `/v2/sessions/current/...` do manifestów artefaktów** (`eigen/artifacts/common.rs:346`, `fmr.rs:1363+`, `field_sweep.rs:172`). Sprzężenie z „current” jest więc także w **danych na dysku**, nie tylko w kodzie. | K10, K14, CAE-04, CAE-37 | **Krytyczna** |
| L3 | **`SessionStore::gc()` usuwa żywe dane.** `collect_live_refs()` zbiera wyłącznie `FieldRef.tensor_descriptor_ref` z checkpointów; nie dereferencjonuje `TensorDescriptor.chunks[].object_ref`, nie obejmuje manifestów sesji/runów, dokumentów ani recovery. `CasStore::gc()` kasuje wszystko spoza tego zbioru. Ścieżka jest osiągalna z CLI (`fullmag session gc`). | CAE-47, §20.3 | **Krytyczna** |
| L4 | **Brak `fsync` w `atomic_write`** (`store.rs:352-358`) i w `CasStore::put` (`cas.rs:36-46`) — jest `write` + `rename` bez `sync_all` pliku i katalogu. Plan §20.2 zakłada „zweryfikowany kontrakt zapisu/flush/rename”; dziś ten kontrakt nie jest spełniony nawet na lokalnym NTFS. | §20.2, spike „Working store durability”, CAE-45 | **Wysoka** |
| L5 | **Skala `/sessions/current` jest ~10× większa, niż plan sugeruje.** 288 z 293 ścieżek `/v2/*` to `/v2/sessions/current/*`; **nie istnieje ani jeden endpoint scoped po session_id**. Nazwanie tego „ograniczonym adapterem zgodności” (§22) jest poważnym niedoszacowaniem. | §22, ADR-CAE-14, P3/P8 | **Wysoka** |
| L6 | **Plan pomija crate `fullmag-quantities`** (3 033 linie: `catalog`, `descriptor`, `eval`, `provider`, `reduction`, `registry`, `transport`) — istniejący, kanoniczny rejestr wielkości fizycznych, który jest naturalnym fundamentem `DerivedValueDefinition` (K12) i `FieldDescriptor` (K11). | K11, K12, §19, P6 | **Średnia** |

---

## 4. Dwie rekomendacje Gemini, których nie wolno wdrożyć w obecnym brzmieniu

Szczegóły: `02-sprostowania-raportu-gemini.md`.

### S1. „Usterka `ViewportTabHost.tsx:76`” nie jest usterką — to realizacja ADR-0016

Gemini nazywa `key={activeModule.id}` „kluczowym błędem” i zaleca renderowanie wszystkich
zakładek z ukrywaniem przez CSS. Tymczasem `docs/adr/0016-center-viewport-tabbed-surfaces.md`
(status: **accepted**, amended 2026-08-03) stanowi wprost:

> *„Switching to a non-3D center tab **must unmount** `Viewport3DModule`; hiding it with CSS
> is **not sufficient**.”*
> *„Inactive center tabs must not keep resource hooks, WebGL canvases, animation frames,
> object URLs, workers, or large render buffers alive.”*

Istnieje audyt egzekwujący tę regułę:
`apps/control-room/scripts/audit-viewport-main-tab-memory.mjs:397-408` —
`assertInactiveTabObservation()` zgłasza błąd, gdy `canvasCount > 0 || rootCount > 0`.
Wdrożenie rekomendacji Gemini **złamie ten audyt** i naruszy zaakceptowany ADR.

Dodatkowo rekomendacja jest **wewnętrznie sprzeczna z własnym raportem Gemini**: w
`05-krytyczne-sprostowania...md` §4.2 autor argumentuje, że kohabitacja WebGL i CUDA na
jednej karcie grozi utratą kontekstu 3D i zaleca rezerwę VRAM. To jest dokładnie powód,
dla którego ADR-0016 nakazuje odmontowanie nieaktywnych powierzchni.

Osobno: samo usunięcie `key` **i tak niczego by nie zmieniło**, bo `ViewportTabHost`
renderuje wyłącznie `activeModule` (linie 74-81), a nie listę modułów. Diagnoza jest więc
także technicznie niepełna.

Plan `01-architektura-cae.md` §23.3 jest tu **poprawny**: *„Podstawowy workspace ma jeden
aktywny viewport”*. Utrzymać zapis planu, odrzucić rekomendację audytu.

### S2. „50+ komponentów frontendu używa `/v2/sessions/current/*`” — nieprawda

Zmierzone w `apps/control-room/src`:

```text
pliki z 'sessions/current'                                   : 22
w tym pliki .test.* lub /generated/                          : 20
pliki produkcyjne, nie-generowane                            :  2
  -> kernel/api/apiPaths.ts            (centralna fasada ścieżek, 995 linii)
  -> kernel/visualization/VisualizationRegistrySyncController.ts
```

Frontend ma **jeden punkt styku** z URL-ami. Ryzyko „paraliżu frontendu” nie istnieje,
a proponowany `VirtualSessionAdapter` w Axum nie jest do tego potrzebny.

Rzeczywiste sprzężenie leży **po stronie Rusta**: 59 plików `.rs` w `crates/` zawiera
`sessions/current`, w tym 54 wystąpienia w samym `fullmag-runner` — czyli w komponencie,
o którym `03-migracja.md` pisze „Nie odczytuje mutowalnego globalnego modelu”.
Audyt Gemini wskazał niewłaściwy obszar ryzyka; korekta zmienia priorytety faz P3–P5.

---

## 5. Co plan robi dobrze i należy zachować bez zmian

Dla równowagi — te elementy zweryfikowałem i uważam za mocne:

1. **Uczciwość epistemiczna.** §28 i `05-dowody-i-adr.md` („Ponowna kontrola tez”) jawnie
   odrzucają zbyt mocne tezy. Plan nigdzie nie twierdzi, że coś zostało wykonane.
   Wszystkie scenariusze mają `NOT_RUN`. To rzadkie i bardzo wartościowe.
2. **E14 jest sformułowane ostrożniej niż w audycie Gemini** i jest przez to trafniejsze.
   Plan pisze: *„Nie jest to twierdzenie, że każda zmiana dowolnego pola zawsze zabija
   każdy runtime”*. Sprawdziłem: `scratch_runtime` jest uruchamiany w dwóch miejscach
   (`main.rs:507`, `orchestrator.rs:6933`) i nadzoruje ścieżkę scratch/UI, nie każdy
   runtime script-backed. Kategoryczne sformułowanie Gemini („bezwzględne zabicie procesu
   solvera” przy każdej zmianie w inspektorze) jest nadmiernym uogólnieniem.
3. **Rozdzielenie czterech grafów (§13)** i **rozdzielenie `SolutionSet`/`Dataset`/
   `DerivedValue`/`Plot` (§19)** — poprawne i zgodne z istniejącym ADR-0029.
4. **Decyzja o rozwinięciu `.fms`/CAS zamiast nowego storage (ADR-CAE-12)** — uzasadniona.
   `SessionStore` ma już `commit_run`, `list_checkpoints`, `run_refs`, `LOCK` i `gc`;
   to realny fundament, nie życzeniowe założenie.
5. **§8.1: rotacja/skala jako kolejne typy cech.** Zweryfikowane i trafne:
   `SceneDocument.Transform3D` (scene.rs:165) niesie `rotation_quat` i `scale`, ale
   `GeometryEntryIR` (model.rs:40-130) ma tylko `Translate`, `Union`, `Difference`,
   `Intersection` i prymitywy. Asymetria DTO↔IR jest realna i plan ją przewidział.
6. **Kolejność faz P0→P8 wynikająca z własności danych** — poprawna. Nie zmieniam jej;
   proponuję jedynie przesunięcie trzech bram (patrz `04-poprawki-do-planu-i-migracji.md`).

---

## 6. Odpowiedź na pytania postawione w zleceniu

**Czy plan jest prawidłowy?**
Tak. Diagnoza przyczyn jest trafna i dowiedziona kodem. Ontologia jest zgodna z kanonem
CAE. Nie znalazłem w dokumentach `01`–`05` ani jednego twierdzenia o kodzie, które byłoby
merytorycznie fałszywe — tylko dwa błędne zakresy linii (E15, E16).

**Czy plan jest kompletny?**
W warstwie specyfikacji — tak. W warstwie wykonawczej — **nie**, z powodu luk L1–L6.
Szczególnie L1 (brak uzgodnienia z 34 istniejącymi ADR) może spowodować, że wdrożenie
zacznie budować równolegle do już zaakceptowanych, częściowo zaimplementowanych decyzji.

**Czy plan jest zasadny?**
Tak, bezdyskusyjnie. Dowody na to są w kodzie mocniejsze, niż plan sam podaje:
brak sesji ⇒ brak workspace'u (`EmptyWorkspace.tsx`), 288/293 endpointów pod `current`,
podwójny spawn interpretera Pythona przez dysk przy każdej komendzie obliczeniowej.

**Czy pozwoli poprawić UI produkcyjnie i profesjonalnie?**
Tak, pod warunkiem wprowadzenia poprawek z `04-` i `05-`. Sam plan jest tu poprawny;
to audyt Gemini wprowadza do warstwy UI rekomendacje szkodliwe (S1).

**Czy zbliży Fullmaga do COMSOL/CST?**
Tak w zakresie modelu danych i workflow. Nie w zakresie, w którym plan świadomie nie
składa obietnic (CAD B-Rep, Model Manager klasy enterprise, współedycja). To jest
w dokumentach powiedziane wprost i uważam tę powściągliwość za zaletę, nie brak.
Szczegółowa analiza luk workflow względem COMSOL/CST: `05-ocena-ui-vs-comsol-cst.md`.

---

## 7. Zalecenie końcowe

**Przyjąć plan `01`–`05` jako obowiązującą specyfikację, z pięcioma warunkami:**

1. Dopisać rozdział uzgadniający ADR-CAE-01..18 z istniejącymi ADR 0001–0031
   (które supersedują, które konsumują, które pozostają bez zmian). **Blokuje P0.**
2. Włączyć L2, L3, L4 do zakresu P0 jako naprawy poprzedzające zamrażanie fixtures.
   `fullmag session gc` powinno zostać wyłączone lub oznaczone jako niebezpieczne
   **natychmiast**, niezależnie od harmonogramu refaktoryzacji.
3. Skorygować §22 i ADR-CAE-14 o rzeczywistą skalę 288/293 i przenieść ciężar migracji
   API z frontendu na Rust (`fullmag-runner`, `fullmag-api`, `fullmag-cli`).
4. Odrzucić rekomendacje S1 i S2 z raportu Gemini; utrzymać §23.3 planu i ADR-0016.
5. Dopisać `fullmag-quantities` do mapy pakietów w `03-migracja.md` §2 jako właściciela
   katalogu wielkości dla warstwy Dataset/DerivedValue.

---

## 8. Struktura tego raportu

- `00-werdykt-i-podsumowanie.md` — niniejszy dokument.
- `01-weryfikacja-dowodow-E01-E16.md` — niezależna weryfikacja każdego dowodu planu.
- `02-sprostowania-raportu-gemini.md` — sprostowania do `raport_gemini/`.
- `03-luki-i-bledy-planu.md` — luki L1–L6 z dowodami i konsekwencjami.
- `04-poprawki-do-planu-i-migracji.md` — konkretne poprawki redakcyjne i zmiany w P0–P8,
  nowe bramy, nowe spike'i, nowe scenariusze CAE-61..CAE-70.
- `05-ocena-ui-vs-comsol-cst.md` — ocena drogi do workflow klasy COMSOL/CST.
- `06-rejestr-dowodow-claude.md` — rejestr D-00..D-28: plik, linie, co sprawdzono, wynik.

**Zakres pewności tego raportu:** odczyt statyczny. Nie uruchomiłem aplikacji, nie
skompilowałem Rusta, nie wykonałem testów ani symulacji. Wszystkie wnioski o zachowaniu
runtime są wnioskami z odczytu kodu, a nie z obserwacji działającego programu.
