# Czytelny dolny panel Control Room

## Cel i decyzja

Na polecenie użytkownika przebudowujemy cały footer w stylu uporządkowanego panelu narzędziowego, spójnym z nowym Inspektorem 3D. Zachowujemy siedem zakładek i istniejące źródła danych. Decyzja wykonawcza: neutralne powierzchnie Catppuccin, mocny kontrast tekstu, wyraźna aktywna zakładka, kolor semantyczny dla stanów, bez tęczowych kart i ozdobnych poświat.

## Zachowanie

- Logs, Telemetry, Diagnostics, Engine, Operations, Problems i Quick Chart pozostają dostępne z klawiatury i w wąskim panelu. Przewijanie zakładek pokazuje aktywną pozycję; przyciski ramki nie znikają.
- Telemetry ma czytelną hierarchię etykieta → wartość i jednostka → kontekst. Metryki pozostają dostępne przez przewijanie również przy małej wysokości; brak danych nie wygląda jak poprawny pomiar zera.
- Pozostałe zakładki otrzymują wspólne powierzchnie, nagłówki, narzędzia, czytelne tabele/statusy i responsywne układy. Quick Chart zachowuje swoje jednostki, zakresy i interakcje.
- Aktualizacje telemetrii nie zmieniają jej znaczenia, run/session provenance ani kolejności rozwiązywania wartości. Brak nowych endpointów, pętli odpytywania, zależności i zmian fizyki.
- Jasny i ciemny motyw: tekst normalny co najmniej 4.5:1, widoczny fokus, stan przekazany tekstem i kolorem. Dane liczbowe używają cyfr tabelarycznych. Wszystkie nowe klasy mają prefiks fm-, kolory pochodzą z --fm-*.

## Weryfikacja

Typecheck, lint bez ostrzeżeń, testy Control Room i architecture hygiene w istniejącej grupie Compose. Browser QA na własnej sesji: siedem zakładek, light/dark, desktop/wąski panel/mała wysokość, klawiatura, kontrast, dostęp do przewijanej zawartości, brak błędów strony, zachowany canvas. Zrzuty z rzeczywistego frontendu. Nie uruchamiamy Solve w ramach przebudowy UI.

## Zakres integracji

Branch codex/footer-readability-20261116 bazuje na master690681c0861d8776af0fc75e6b948840fd9b8c1b. Początkowo użyto własnego worktree podglądu COMSOL. Po restarcie WSL grupa3294 była zatrzymana, a zgodne odzyskanie zablokował brak obsługi worktree w dowodzie obcych bind mountów. Dokładnie14pliki zadania przeniesiono z kontrolą hashy do osobnego zarządzanego worktree footer-readability-20261116 i grupy fullmag-worktree-fullmag-eacf66fd4f16a992 na porcie3306. Poprzedni checkout jest czysty i wrócił na branch PR434; jego sesja, certyfikaty i zasoby zostały zachowane. Nowy podgląd pozostaje do oceny użytkownika; retencja/cleanup pozostają odroczone przy aktywnym podglądzie.
