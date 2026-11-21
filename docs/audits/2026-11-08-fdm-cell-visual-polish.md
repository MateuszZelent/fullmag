# Wygląd inspektora FDM Cell

Parametry materiału mają teraz wspólną kolumnę wartości i oddzielną kolumnę jednostek. Symbole Ms, Aex i α są uzupełnione czytelnymi nazwami. Składowe mx/my/mz tworzą trzy odczyty, a norma ma osobny wiersz. Wąski panel układa składowe pionowo. Tabela energii zachowuje znaki i jednostki oraz wyróżnia sumę. Odstępy, typografia i kolory korzystają z tokenów inspektora Fullmaga dla Latte i Mocha. Odczyt pól i zasady ukrywania nieaktualnych wartości pozostają zachowane.

## Odbiór

Zarządzana próba `eccb34a1682d4d64b257f07805264785` zakończyła się sukcesem. Przeglądarka wybrała rzeczywistą komórkę 6 i porównała widoczne wartości z publicznymi sondami. Sprawdza również sam tekst liczb z uwzględnieniem dokładności zaokrąglenia, niezależnie od surowych atrybutów `data`. Sprawdzono zakładki klawiaturą, oba motywy, szerokości panelu 380 i 300 px oraz brak obciętych liczb i przepełnienia. Status komórki, wszystkie odczyty, suma i wiersz szczegółów mieszczą się w każdym kadrze. WebGL2 zachował poprawny kontekst; nie odnotowano błędów strony, konsoli ani transportu. Jest to odbiór prezentacji opublikowanych pól dla regularnej siatki FDM CPU, nie kwalifikacja pozostałych realizacji solvera.

- [Motyw jasny](2026-11-08-fdm-cell-visual-polish-light.png)
- [Motyw ciemny](2026-11-08-fdm-cell-visual-polish-dark.png)
- [Panel 300 px](2026-11-08-fdm-cell-visual-polish-narrow.png)
- [Cały workspace](2026-11-08-fdm-cell-visual-polish-workspace.png)

Próbę można powtórzyć przez `scripts/docker_dev_browser_qa.py` z jawnym `--repo-root`, `--source-root`, portem właściwej grupy oraz `--canvas-only --expect-live-field m --expect-fdm-cell-physics`. Profil wymaga istniejących opublikowanych pól. Nie uruchamia Solve i nie zastępuje testu końcowej telemetrii.

Aktualne kontrole widoku, próbek i CSS: **105 testów PASS**. Regresje kontrolera: **84 testy PASS, jeden istniejący skip**. Pełny zestaw Control Room: **9619 testów / 923 pliki PASS** przed końcowym dopasowaniem typografii, symbolu dodatkowego materiału i profilu QA; te zmiany sprawdzono ponownie testami celowanymi. TypeScript, lint, architecture hygiene i API hygiene przeszły. `react-doctor --scope changed` w lustrze frontendu przeszedł automatycznie w skan całego projektu, ponieważ nie widzi metadanych Git: wynik 57/100, 11 błędów, bez diagnozy `FdmCellPhysicsPanel`. Nie jest to dowód czystego skanu zmian ani wynik PASS.

## Przypadek odmowy preflightu

Wywołanie odświeżenia frontendu przy aktywnej sesji zostało poprawnie odrzucone, ale zapisało nieudaną próbę jako `development/current.json`. Dodany odczyt kwalifikuje poprzednią zweryfikowaną grupę wyłącznie dla dokładnej początkowej odmowy, zanim zapisano dokumenty rollbacku i przekroczono granicę mutacji usług. Sprawdza receipty, konfigurację, źródło, obraz i działające kontenery. Zachowuje oryginalny nieudany receipt i jego hash jako warunek przyjęcia QA. Dodatkowy preflight przed otwarciem operacji zapobiega takiemu przesunięciu wskaźnika przy kolejnej odmowie. Nie restartowano solvera ani nie nadpisywano historii.

## Otwarte bramki

Świeży startupowy run ma brak `final_total_energy` w swoim podsumowaniu, mimo opublikowanych pól i dostępnej energii w cienkim statusie. Oddzielny test końcowej telemetrii nadal tego nie akceptuje; jego wymagań nie zmieniono. Ten odbiór inspektora nie zamyka pozostałych punktów P01–P22/T8 ani kwalifikacji FDM GPU, FEM i multilayer. Szczegółowe piny, hashe źródeł i obrazów oraz oczyszczony wynik przeglądarki są w sąsiednim pliku JSON.
