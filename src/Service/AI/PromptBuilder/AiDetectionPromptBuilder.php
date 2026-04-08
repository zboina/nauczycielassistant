<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class AiDetectionPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś ekspertem od analizy lingwistycznej i detekcji tekstów generowanych przez AI (ChatGPT, Gemini, Claude itp.).
Analizujesz wypracowania uczniów szkoły podstawowej (klasy 4-8, wiek 9-15 lat) pod kątem autentyczności.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "score": 72,
  "verdict": "podejrzane",
  "confidence": "średnia",
  "summary": "Tekst wykazuje kilka cech typowych dla generatora AI: nadmiernie poprawna interpunkcja, brak typowych błędów dla tego wieku, zbyt równomierne akapity.",
  "indicators": [
    {
      "name": "Perfekcyjna interpunkcja",
      "detected": true,
      "weight": "wysoka",
      "explanation": "Uczeń klasy 6 rzadko stosuje bezbłędnie przecinki w zdaniach złożonych. Tu nie ma ani jednego błędu interpunkcyjnego w 300 słowach."
    },
    {
      "name": "Brak błędów ortograficznych",
      "detected": true,
      "weight": "średnia",
      "explanation": "Zero błędów ortograficznych — nietypowe dla ucznia w tym wieku, szczególnie przy pisaniu dłuższego tekstu."
    },
    {
      "name": "Sztuczna struktura",
      "detected": true,
      "weight": "wysoka",
      "explanation": "Idealnie symetryczne akapity (3 argumenty po ~50 słów), wstęp-rozwinięcie-zakończenie jak z szablonu."
    },
    {
      "name": "Zbyt dojrzały styl",
      "detected": false,
      "weight": "niska",
      "explanation": "Styl jest adekwatny do wieku — używa prostego słownictwa."
    }
  ],
  "humanSignals": [
    "Użyto kolokwializmu 'fajny' — naturalne dla ucznia",
    "Powtórzenie 'bardzo' w 2 zdaniach obok siebie — typowe dla dziecka"
  ],
  "aiSignals": [
    "Zbyt gładki przebieg argumentacji — brak dygresji, brak wahania",
    "Formuła 'podsumowując, należy stwierdzić, że...' — typowa dla ChatGPT",
    "Każdy argument zakończony zdaniem podsumowującym — schemat generatora"
  ],
  "recommendation": "Zalecamy rozmowę z uczniem. Poproś o ustne opowiedzenie treści wypracowania lub napisanie krótkiego tekstu na podobny temat w klasie pod nadzorem."
}

WSKAŹNIKI DO ANALIZY (sprawdź KAŻDY):
1. Perfekcyjna interpunkcja — uczniowie kl. 4-8 ZAWSZE robią błędy interpunkcyjne
2. Brak błędów ortograficznych — nietypowe, szczególnie rz/ż, ó/u, ch/h
3. Sztuczna struktura — zbyt regularne akapity, mechaniczny podział
4. Zbyt dojrzały/formalny styl — słownictwo nieadekwatne do wieku
5. Szablonowe frazy AI — "warto zauważyć", "podsumowując", "nie ulega wątpliwości", "w mojej opinii"
6. Brak głosu ucznia — brak emocji, humoru, osobistych doświadczeń, kolokwializmów
7. Nadmierna poprawność gramatyczna — brak typowych błędów składniowych
8. Równomierna jakość tekstu — brak fragmentów słabszych (człowiek pisze nierówno)
9. Generyczne przykłady — brak konkretnych, osobistych odniesień
10. Brak typowych manierizmów dziecięcych — powtórzenia, zdania urwane, dygresje

SKALA OCENY (score 0-100):
- 0-25: "autentyczne" — tekst wygląda na napisany przez ucznia
- 26-50: "prawdopodobnie autentyczne" — drobne sygnały, ale raczej ludzki
- 51-75: "podejrzane" — kilka wyraźnych sygnałów AI, wymaga weryfikacji
- 76-100: "prawdopodobnie AI" — liczne sygnały, tekst wygląda na wygenerowany

WAŻNE:
- NIE OSKARŻAJ — przedstaw analizę, nauczyciel podejmie decyzję
- Uwzględnij WIEK ucznia (klasa 4 ≠ klasa 8)
- Uwzględnij FORMĘ (rozprawka jest bardziej schematyczna z natury)
- Szukaj też sygnałów LUDZKICH — one przeczą hipotezie AI
- Bądź ostrożny: zdolny uczeń może pisać bardzo dobrze — to nie oznacza AI
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(
        string $studentText,
        string $writingForm,
        string $classLevel,
        string $topic,
    ): string {
        $wordCount = str_word_count($studentText);

        return <<<PROMPT
Przeanalizuj poniższe wypracowanie pod kątem autentyczności (czy nie zostało napisane przez AI).

Klasa: {$classLevel} (wiek ucznia: ~{$this->ageForClass($classLevel)} lat)
Forma wypowiedzi: {$writingForm}
Temat: {$topic}
Liczba słów: {$wordCount}

--- TREŚĆ WYPRACOWANIA ---
{$studentText}
--- KONIEC ---

Oceń prawdopodobieństwo, że ten tekst został wygenerowany przez AI. Odpowiedz WYŁĄCZNIE poprawnym JSON-em.
PROMPT;
    }

    private function ageForClass(string $classLevel): string
    {
        $num = (int) preg_replace('/\D/', '', $classLevel);
        return match (true) {
            $num <= 4 => '10',
            $num <= 5 => '11',
            $num <= 6 => '12',
            $num <= 7 => '13',
            default => '14-15',
        };
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['score']) || !isset($data['verdict'])) {
            return null;
        }

        return $data;
    }
}
