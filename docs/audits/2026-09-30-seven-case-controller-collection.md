# S12 — odbiór istniejącego kontrolera Γ/DE/BV

## Problem i poprawka

Działający run_nonzero_k_validation_controller.py zapisuje controller-results.json jako job_id/source_digest/results, obejmujące Γ i sześć DE/BV. Kolektor grubości oczekiwał wcześniejszego status/cases/expected_source_digest/model_ref obejmującego tylko sześć przypadków. Sam sukces nowych wrapperów nie wystarczyłby do uruchomienia kolektora.

Dodano adapter raportu istniejącego kontrolera. Wymaga wszystkich siedmiu oczekiwanych, unikalnych przypadków w kolejności, prawdziwych całkowitych exit0 i wyjść we własnym katalogu batch. Job/digest muszą zgadzać się z controller-config.json; model ref jest pełnym SHA. Raport częściowy lub błędny nie staje się terminalnym sukcesem. Nie trzeba zmieniać ani restartować działającego kontrolera #185.

Kolektor wiąże hash konfiguracji i raportu, zachowuje dotychczasowe kontrole sześciu przypadków grubości i dodatkowo sprawdza Γ: receipt/request/job/source/model, rzeczywiste wiersze k0, kompletność pól, tożsamość modu i przeliczonej topologii oraz rekonstrukcję potencjału. Wszystkie raporty nadal mają qualification NOT VERIFIED; to nie jest dowód zbieżności ani pełnego widma.

## Dowody i dalszy krok

- RED: brak adaptera; 1 failure, 18 pozostałych PASS.
- GREEN: 24 testy Python PASS. Niepełna seria, błędny Γ, obcy job/model/source/hash, duplikat i obce wyjście są odrzucane. Diff check PASS. Fixture nie jest wynikiem FEM.
- Kapsuła #185 przeszła pełny verify_source, 0 .pyc. Kontroler 3576 potwierdzony żywy, job running; podczas kontroli kontener jeszcze nie był utworzony. Nie jest to dowód startu kompilacji.
- Po rzeczywistym zakończeniu siedmiu wrapperów: collect_de_bv_thickness_comparison.py <batch>/controller-results.json <new-output.json>, następnie aktualny wykres grubości i porównanie N32/P00. Kolektor jest z worktree; źródła runtime i wyników pozostają przypięte do kapsuły #185. Nie zgłoszono duplikatu ani nie zmieniono kapsuły.
- Pełne S00–S12, nowe wyniki, zbieżność airboxu/siatki/liczby modów, A1/COMSOL, browser, GPU i integracja nadal otwarte.
