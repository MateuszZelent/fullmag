# Wersje materiałów w katalogu i w Pythonie

Status projektu: zatwierdzony

## Zachowanie

W **Material database** rodzina **YIG** zawiera oryginalny zestaw i nazwane,
opublikowane wersje, np. **YIG_Kuswik1**. Po wybraniu wersji UI pokazuje
parametry w SI, ich różnice wobec oryginału, referencje oraz projekt, z którego
pochodzi kopia, gdy ta informacja jest dostępna. Wybór z Model Buildera
przypisuje do obiektu pełną kopię tej wersji według ADR 0083.

Istniejące **Save copy to database** pozwala zacząć z materiału wybranego
w modelu, również otwartym z wcześniejszego projektu. Użytkownik sprawdza
współczynniki, nadaje nazwę i publikuje wersję w wybranej rodzinie.

## Tożsamość wersji

Rodzina i wersja mają stabilne klucze. Przykładowa prezentacja
`YIG_Kuswik1` może mieć klucz `yig.kuswik` albo `yig.kuswik1` nadany przy
publikacji. Nazwa wyświetlana jest niezależna od klucza.

Opublikowany klucz wskazuje na niezmienny zestaw współczynników i przypięty
snapshot pochodzenia. Kolejny zestaw pomiarów otrzymuje nową wersję.
Archiwizacja usuwa wersję z domyślnego widoku wyboru, zachowując rozwiązywanie
jej klucza przez starsze skrypty. Konflikt klucza zgłasza katalog. Brak wersji
jest czytelnym błędem z pełnym kluczem. Przykładowe wartości wbudowanego YIG
pozostają oddzielone od wartości konkretnej próbki.

## Python i eksport

Publiczna składnia po wdrożeniu projektu:

```python
disc.material = fm.materials.yig.kuswik
```

W zarządzanym uruchomieniu Fullmag rodzina i klucz wersji są rozwiązywane
we wspólnym katalogu. Launcher dostarcza jego odczytową reprezentację do
kontekstu uruchomienia przez istniejącą, typowaną warstwę katalogu. Kod
symulacji pracuje na tym widoku przez całe uruchomienie, z tymi samymi
granicami dostępu co obecny przechwytywacz skryptów. Dla samodzielnego Pythona
przewidujemy jawne podłączenie tej samej instancji Fullmaga przez klienta.

Przypisanie na uchwycie geometrii przenosi wartości do istniejących
współczynników obiektu i zapisuje pochodzenie wersji w metadanych materiału.
Zachowuje wybór modułów fizyki, w tym jawny stan DMI. Ten zapis korzysta
z obecnego mapowania efektywnych wartości na ProblemIR. Eksport kanoniczny
osadza wykorzystany zestaw wraz z kluczem i pochodzeniem. Otwarty gdzie
indziej plik odtwarza model z osadzonej kopii.

## Zgodność i weryfikacja

Istniejące wpisy i skrypty z ręcznie podanymi współczynnikami pozostają
czytelne. Wpis można jawnie opublikować w rodzinie. Drzewo buduje się
ze stabilnych identyfikatorów. Aliasy i pochodzenie pozostają jawne.

- Opublikowanie kopii z wcześniejszego projektu, wyszukanie wersji w drzewie
  i wybór jej w innym projekcie.
- Ponowne uruchomienie skryptu z tym samym kluczem po dodaniu kolejnej wersji,
  zmianie wyświetlanej nazwy i archiwizacji przypiętej wersji.
- Reader typowanego zasobu wykrywa brak wersji i konflikt klucza, z zachowaniem
  istniejących granic uruchamiania przechwytywacza skryptów.
- Round trip Python, ProjectArchive i UI zachowuje klucz, efektywne parametry,
  ich pochodzenie oraz stan modułów. Wyeksportowany skrypt daje te same
  wartości bez połączenia z katalogiem.

Podstawa kontraktu: [ADR 0083](../../adr/0083-material-library-and-self-contained-model-copies.md)
oraz [nota 0104](../../physics/0104-material-regions-parameter-fields-and-interface-couplings.md).
