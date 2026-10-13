# Eigensolve — rozdzielenie postępu solvera i obserwabli fizycznych

## Potwierdzona przyczyna

Runner wpisywał progress.residual do StepStats.max_h_eff. CLI używało wspólnego formattera LLG: log prezentował residual jako |H_eff|, a domyślne zera jako energię, torque i średnią magnetyzację. Drugi błąd: brak flagi LOBPCG powodował wybór etykiety cpu_dense_symmetric_eigen, także dla produkcyjnego SLEPc.

## Zmiana źródeł

- Residual pozostaje w fem_eigen_progress; nie jest zapisywany do max_h_eff.
- Dokładne solver_kind i phase przekazywane przez jawne flagi tożsamości w istniejącej mapie skalarów. Odbiornik nie zgaduje algorytmu; brak lub niejednoznaczność daje unknown. Stara jawna flaga LOBPCG zachowana.
- Modalne linie postępu i heartbeat pomijają niezmierzone pola fizyczne; zachowują podokna i ich residual solvera. Etapy fizyczne zachowują formatter LLG.
- Etap zasobu dostaje właściwy opis base/refinement i algorytm.

## Granica dowodu

Regresje Rust przygotowane: separacja jednostek, exact/unknown/mixed solver identity oraz brak fizycznych pól w linii modalnej. 13 plików Rust parser PASS; testów natywnych nie kompilowano. Runtime i browser NOT VERIFIED. Zmiana nie dotyka macierzy, tolerancji, selekcji modów ani wyników fizycznych.

Aktywny #188 i kapsuła b2edf2fbc0295c83f6d768ad8bd3391904017c5f871d0244afe15c4b3a1a4a46 nie zawierają tej poprawki. Historyczne logi pozostają błędnie podpisane i nie mogą być interpretowane jako pomiar H_eff. Nie restartowano Γ. Nowy managed build pozostaje uzależniony od zwolnienia lease worktree; potrzeba także sprawdzenia odbiorników UI.

## Domknięcie źródeł odbiorników

Review wskazał P1: samo usunięcie residualu nie blokowało zerowych wierszy z domyślnego StepStats. set_latest_scalar_row teraz pomija aktualizacje modalne także przy force/terminal; running_run_manifest_from_update pozostawia final_time i energie jako None. solver_status nie traktuje modalnego latest_step jako obserwacji, a latest_energy_row nie tworzy z niego fallbacku. Bieżące zasoby zwracają brak pomiaru podczas modalnego latest_step; rzeczywiste wcześniejsze pomiary są dostępne w historii. GlobalQuantityRow.scalar_value zwraca None dla modalnego placeholdera, ale measured0 pozostaje Some(0).

Wire structs zachowują dotychczasowe typy liczbowe i marker fem_eigen_progress; ich surowe placeholdery nie są dowodem obserwacji. StepUpdate.to_v2 nie ma produkcyjnego callsite w bieżącym repo (wyłącznie cfg(test)); nie uznajemy go za zweryfikowaną trasę UI. Nowe generowane schematy/transport nie były potrzebne: zasób SolverStatusResource już dopuszcza brak wartości; nie zmieniono endpointów ani typów DTO. UI czyta dotychczasowe zasoby i rzeczywistą historię.

Przygotowano dodatkowe regresje force/terminal scalar history, braku energii/czasu w run manifest oraz None-vs-measured0 quantity. Pusty solver_kind nie emituje już flagi tożsamości. Końcowe review odbiorników oraz managed build/runtime/browser nadal wymagane; bez osłabiania bramek naukowych.

Kontrola istniejącego generated OpenAPI: SolverStatusResource.{dt_seconds,sim_time_seconds,max_torque_T,max_torque_Apm,max_rhs_norm_per_s} mają type=[number,null] i nie są wymagane. Odpowiedź None mieści się w bieżącym kontrakcie; nie regenerowano niezmienionych typów.

Bieżąca kontrola solvera: 7df4be7c5ace aktywny, około212%CPU; Γ przesunęło się do refinement24/50, window_s=6147,2 przy zdarzeniu granicznym. Nadal brak terminalnej nowej częstotliwości. To zweryfikowane oczekiwanie na żywy proces, nie zakończenie naukowej bramki.

## Odbiór drugiego review

- Realtime ScalarSample wymaga zaakceptowanego wzrostu scalar_revision; obecność odrzuconego latest_scalar_row nie publikuje ponownie starego pomiaru.
- Katalog dostępności, current scalar, current energy, status i hysteresis nie używają poprzedniego fizycznego pomiaru jako bieżącego podczas callbacku modalnego.
- Historyczne endpointy scalars, tables JSON/binary i energy history pomijają stare markery przed limit/tail. Archiwalne dane pozostają zachowane. Tables/scalars zachowują oryginalne rewizje i indeksy źródła; energy history podaje liczbę rzeczywistych wierszy fizycznych.
- Przygotowane regresje obejmują również filtrowanie historii z zachowaniem kursorów i odróżnienie measured zero od modalnego placeholdera. Natywnych testów nie kompilowano zgodnie z AGENTS.md.
- Wykres odświeżono w de-bv-updated-job188: 27 archiwalnych rekordów, bez nowych punktów #188 i bez syntetycznego odbicia ujemnych k. To nie domyka bramki signed ani zbieżności.

Końcowe review wskazało dalsze obejścia P2: kolejka CLI mogła przyjąć bezpośrednio przypisany marker, opóźniony realtime sample mógł przeżyć wejście w tryb modalny, a licznik iteracji trafiał do physical total_steps. Dodano centralne filtry candidate/enqueue, anulowanie pending QoS pod wspólną blokadą przejścia oraz total_steps=0 dla callbacku bez fizycznych kroków. Historia pozostaje zachowana. Legacy completed z końcowym markerem pozostaje fail-closed; odzyskanie pomiaru wymaga jawnej tożsamości obserwacji, nie fallbacku do niesprawdzonego final_e_*.
