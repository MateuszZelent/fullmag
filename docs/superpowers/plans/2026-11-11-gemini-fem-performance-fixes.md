# Naprawy wydajności FEM po ponownym audycie Gemini

**Cel:** usunąć powtarzane transfery selekcji FEM GPU i omijanie limitu
automatycznych wątków FEM CPU, zachowując fizykę, ścisłe GPU i wyniki Zarr.

**Baza:** `98b3652533e5eda182d294af56d734cbdad2b327`, istniejący branch
`codex/sp4-fem-cupti-profile`, PR #419. Grupa wykonania:
`fullmag-worktree-fullmag-a8342df1f0247d61`. Zachować 54 nieśledzone wejścia,
wyniki, control/ledger, aktualny pakiet i rollback. Pozostałe pliki agentów
nie należą do bieżącego fragmentu.

**Decyzje:** cache selekcji musi obsługiwać rozmiar rzeczywistej siatki,
sprawdzać zależności materiałowe i zachowywać semantykę wag oraz NaN.
Nie wolno utożsamiać nazwy pojedynczego obiektu z całą domeną ani pomijać
obserwabli potrzebnych odbiorcom StepStats. Jawne wątki użytkownika pozostają
bez zmian; automatyczna alokacja jest górną granicą, nie obejściem limitu siatki.
Nowy prekondycjoner BB i zmiana polityki Poissona są osobnymi eksperymentami
numerycznymi; nie przypisywać im hipotetycznego przyspieszenia.

## Kolejność i odbiór

- [x] Regresja GPU z ponad 16 384 aktywnymi rekordami nodal i DG0:
      zgodność z niezależnym oracle, ponowny odczyt bez H2D, brak wzrostu
      alokacji w pętli; zmiana selekcji i materiału nie daje starego wyniku.
- [x] Cache GPU: przygotowanie poza pętlą, aktualne wagi, skalarne D2H;
      testy błędów, dużych selekcji i układów wielu obiektów.
- [ ] Regresje i naprawa CPU `auto`: alokacja 40 + mała/średnia siatka
      daje 8/16; mniejsza alokacja pozostaje ograniczeniem; manual i GPU bez zmian.
- [x] Naprawa kwalifikowanej archiwizacji historycznych aktywacji, jeżeli
      potrzebna do wykonania testów. Żadnego kasowania historii, podnoszenia
      limitu ani powtórzenia niejednoznacznego Solve.
- [ ] Testy w stałym backendzie Compose, kontrola źródeł/dokumentacji,
      review i osobne commity zweryfikowanych fragmentów.
- [ ] Żywe Zarr i porównanie energii/torque, pomiary bazowy/kandydat na
      przypiętych wejściach. Czas testu kontraktowego nie jest czasem kroku.
- [ ] Aktualne CI i wymagane bramki PR, integracja z masterem. Cleanup
      tylko po braku konsumentów i niezintegrowanych/untracked danych;
      w przeciwnym razie dokładny wpis blokady.

**Właściciele:** root — GPU/cache, wykonanie, review i integracja;
`auto_threads_fix` — CPU thread policy, jej testy i nota 0532;
`object_cache_contract` — odczytowa analiza kontraktu zależności cache.

## Checkpoint wykonania 2026-11-11

- CUDA: `1c5c6c0a09faf499040b720bb2f6f5b962ee8ea0`, test
  `20e7242cc1474a68aea501af9d38c0df`, biblioteka
  `eeb0068fabe13a6fbfd8e32a19be3b4887ddac349efd37eedd7b8587759f5706`.
  Pełny kontrakt PASS; mikrobenchmark dotyczy wyłącznie redukcji obiektowej.
- CPU: poprawka i regresje zapisane w `21261668b`; wykonanie natywnego
  kontraktu wątków i nowego biegu CPU pozostaje do potwierdzenia.
- Archiwizacja: 141 testów PASS; przeniesiono aktywacje
  `0fbd858f1aa740c99ba45e28d8dc41e1` i `3f1024ba978443ee8851a01b82992cef`.
  Wszystkie bajty i Zarr zachowane, bez powtórzenia Solve.
- Wznowienie: `1695e876fa0168538290ceea1dbdeb4877d268cd`, 62 testy
  rodziny budżetu PASS oraz niezależne review. Uwierzytelniona historia
  prawidłowego drain umożliwiła odtworzenie wcześniejszego budżetu 40 CPU/32 GiB.
  Development `81d82ac214984c33805231208d218271` ma zdrowe API na porcie 3274.
- Fizyka i czas całego solvera: nowe przebiegi i parytet **NOT VERIFIED**.
  Mikrobenchmark i zielone CI nie zastępują tych bramek.
