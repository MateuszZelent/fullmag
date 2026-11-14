Kandydat CI: prywatne ponowne użycie RT0 przez DTQ

Cel: sprawdzić import istniejącego FrozenInput do tej samej kwadratury bez powtarzania transportu. Nie scalać tego pomocniczego PR.

Zmiana kopiuje uporządkowane wierzchołki i już podpisane współczynniki, używa istniejącego dokładnego modułu wyznacznika i tych samych evaluatorów prądu. Import bez globalnej mapy DOF odrzuca signed_face_weight. EvaluateFrozenField wykonuje dotychczasowe admission przed alokacją i wywołuje niezmienione evaluate_prepared. Wynik matematyczny zachowuje pusty digest; nie udaje dowodu pochodzenia lub zamknięcia źródła.

Test nowej delty oparto na już naprawionym pliku C0/C1, blob 23cda226a09fb4c5efd37eb08f813ba9f02d32f6. Nie cofamy poprawek MFEM4.10 ani Piola. Nowe przypadki porównują bity lokalnego prądu i momentów, obie orientacje, własność po zniszczeniu MFEM, błędne dane, H, wszystkie diagnostyki, liczniki, rzeczywistą adaptację, observer i dokładny komunikat wyczerpania depth. Należy odczytać nowy znacznik PASS; stare zielone C0/C1 nie dowodzą wykonania tych testów.

ConservativeCurrentView wraca do lokalnego bazowego blob 18cb459ff777cf9cae948a6f2c82824dc9f57513. Poprzedni indeks C1 nie wykazał przyspieszenia i nie jest częścią tego eksperymentu.

Bez nowego C ABI, Python, ProblemIR, policy, publicznego retained H-only, pełnej mapy GSG, FFT lub LLG. Bez zastosowania do lokalnych produkcyjnych źródeł lub runtime3203. Same fixture nie kwalifikują wyniku na próbce i nie odtwarzają publikacji.

Trasa CI pozostaje istniejącym container-backed profile conservative-current-view przez workflow fem-positive-mass-contract. Nie zmieniamy bramek retencji; końcowy cleanup wcześniej odmawiał dla głównego checkoutu i pełny status trzeba raportować oddzielnie od CTest.

Kanoniczny właściciel równań: docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md. Lokalny audyt zachowanego DTQ: 20 punktów, 65 602 912 ocen jądra; skalowanie do gęstej mapy i publiczne wiązanie zachowanego źródła pozostają osobnymi, otwartymi krokami.
