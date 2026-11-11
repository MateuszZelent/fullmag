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

- [ ] Regresja GPU z ponad 16 384 aktywnymi rekordami nodal i DG0:
      zgodność z niezależnym oracle, ponowny odczyt bez H2D, brak wzrostu
      alokacji w pętli; zmiana selekcji i materiału nie daje starego wyniku.
- [ ] Cache GPU: przygotowanie poza pętlą, aktualne wagi, skalarne D2H;
      testy błędów, dużych selekcji i układów wielu obiektów.
- [ ] Regresje i naprawa CPU `auto`: alokacja 40 + mała/średnia siatka
      daje 8/16; mniejsza alokacja pozostaje ograniczeniem; manual i GPU bez zmian.
- [ ] Naprawa kwalifikowanej archiwizacji historycznych aktywacji, jeżeli
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
