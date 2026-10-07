# Audyt transportu baz w statycznym Aqq

## Potwierdzony błąd i poprawka

Lokalne współrzędne q są współczynnikami kartezjańskich funkcji N_i e_a,i. Wymiana, masa żyromagnetyczna i constraint Floqueta używają obu ramek, lecz pole statyczne używało h_parallel I dla każdej pary węzłów. Przy niezależnie obróconych bazach nodalnych łamało to kowariancję A -> R^T A R. Poprawka mnoży iloczyn funkcji kształtu przez h_parallel (e_a,i dot e_b,j). Wspólne ortonormalne ramki zachowują stare zachowanie; nie jest to wyjaśnienie różnic w benchmarku jednorodnego filmu.

Nota naukowa: docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md, eq-fem-modal-static-field-frame-transport. Producent: backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp, assemble_native_magnetic_a_qq. Regresja w poisson_airbox_shared_domain_test.cpp porównuje obrócone składanie z transportem macierzy wspólnej bazy.

## Dowody i granice

- Niezależny algebraiczny element P1: M=(I+ones)/20, cztery rotacje 0, 0.2, 0.9, 1.7 rad, h=7, A=h M tensor I, G=M tensor J. Wymagane transformacje R^T A R i R^T G R zachowują wszystkie bezwzględne wartości własne równe 7. Stara identyczność daje 2.45901835 i 19.92665083 obok 7; względny defekt kowariancji 0.6540949964. Są to wartości bezwymiarowego przykładu, nie GHz ani wynik FEM.
- Walidator scientific-documentation-contract: exit0 po uzupełnieniu jednoznacznego symbolu i indeksu źródeł. git diff --check dla źródła, testu i noty: exit0.
- Regresji natywnej nie kompilowano ani nie uruchamiano: obowiązuje zakaz użytkownika. Managed runtime i nowe widmo NOT VERIFIED. Ku, DMI, damping, GPU, COMSOL, pełna zbieżność i integracja nadal pozostają w planie.

## Runner

#185 a5aaa693ed3f4f3db64bf7823445097f jest terminalny failed/exit2. Worker zgłosił przekroczenie 30 s przez rustup toolchain list przed kompilacją. Kapsuła i wyniki zachowane. Nie jest to błąd solvera ani dowód niezgodności fizycznej.

Bieżący diagnostyczny odczyt w identycznym obrazie sha256:f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc, użytkownik 65532, cache tylko do odczytu, bez sieci: exit0 w 0.02946 s; stable i nightly widoczne. Koordynator idle, active_jobs=[], wolne około 31.7 GB. Przyczyna wcześniejszego opóźnienia niepotwierdzona; nie zwiększono limitów ani nie zmieniono runnera. Następny build otrzymuje nowy snapshot z poprawką pola, następnie Γ oraz sześć przypadków DE/BV, jeśli build przejdzie.

Niezależny przegląd źródła potwierdził projekcję i zgodność podpisów API. Uzupełniono regresję o jawne wymaganie niezerowego sprzężenia między różnymi ramkami. Syntetyczne digests fixture służą wyłącznie bezpośredniemu składaniu; regresja nie dowodzi wiązania payload/provenance. Nie wykonano testu natywnego.

Walidacja dokładnego commita 916cb24f8f3cb4cef9dc43859371708b04a7c1c9: PASS/exit0. Odtworzono wyłącznie wersjonowaną notę, mapę i wskazane źródła w tymczasowym root, następnie uruchomiono validate_scientific_docs. Wcześniejszy błąd wynikał z mieszania bazowej mapy symboli z roboczą tabelą jednostek; nie dowodził błędu w tym commicie. Pełna robocza nota z jej roboczą mapą również PASS. Kapsuła #186 verify_source PASS, bez modyfikacji obserwatorem.
