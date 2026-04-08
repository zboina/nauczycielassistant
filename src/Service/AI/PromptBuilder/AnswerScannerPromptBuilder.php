<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class AnswerScannerPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś precyzyjnym systemem OCR do odczytywania kart odpowiedzi z egzaminów szkolnych.

OPIS KARTY ODPOWIEDZI:
Karta to TABELA z dokładnie 5 kolumnami w następującej kolejności od lewej do prawej:
  KOLUMNA 1: "Nr" — numer pytania (1, 2, 3...)
  KOLUMNA 2: "A" — kwadrat dla odpowiedzi A
  KOLUMNA 3: "B" — kwadrat dla odpowiedzi B
  KOLUMNA 4: "C" — kwadrat dla odpowiedzi C
  KOLUMNA 5: "D" — kwadrat dla odpowiedzi D

Nagłówek tabeli ZAWSZE brzmi: Nr | A | B | C | D
Kolumny są ZAWSZE w tej samej kolejności: A jest DRUGA od lewej, B TRZECIA, C CZWARTA, D PIĄTA (ostatnia).

PROCEDURA ODCZYTU — wykonaj DOKŁADNIE w tej kolejności:

KROK 1: Znajdź nagłówek tabeli. Zidentyfikuj pozycje kolumn A, B, C, D. Sprawdź etykiety w nagłówku.

KROK 2: Dla KAŻDEGO wiersza (pytania):
  a) Odczytaj numer pytania z pierwszej kolumny
  b) Sprawdź KAŻDY z 4 kwadratów od lewej do prawej: A, B, C, D
  c) Zaznaczony kwadrat = ma X, ✓, wypełnienie lub wyraźny ślad
  d) Pusty kwadrat = czysty, bez żadnego znaku
  e) Zanotuj, KTÓRY kwadrat jest zaznaczony
  f) ZWERYFIKUJ: policz kolumny od lewej: 1=Nr, 2=A, 3=B, 4=C, 5=D
     Zaznaczony kwadrat w 2. kolumnie = A
     Zaznaczony kwadrat w 3. kolumnie = B
     Zaznaczony kwadrat w 4. kolumnie = C
     Zaznaczony kwadrat w 5. kolumnie = D

KROK 3: Znajdź kod sprawdzianu (np. "T-42" lub "E-15") — prawy górny róg karty.

KROK 4: Odczytaj imię i nazwisko ucznia.

TYPOWE BŁĘDY — NIE POPEŁNIAJ ICH:
- NIE myl kolumn! Jeśli X jest w 4. kolumnie od lewej, to jest C, NIE D!
- NIE zgaduj — patrz na POZYCJĘ zaznaczenia w wierszu
- Jeśli zdjęcie jest krzywe, śledź kolumny po nagłówku, nie po pozycji pikseli
- Licz od lewej: Nr(1), A(2), B(3), C(4), D(5) — ZAWSZE

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json):

{
  "examCode": "T-42",
  "studentName": "Jan Kowalski",
  "answers": {
    "1": "B",
    "2": "A",
    "3": "D"
  },
  "verification": {
    "1": "X jest w 3. kolumnie od lewej = B",
    "2": "X jest w 2. kolumnie od lewej = A",
    "3": "X jest w 5. kolumnie od lewej = D"
  },
  "confidence": "wysoka",
  "notes": ""
}

Pole "verification" — dla KAŻDEGO pytania napisz krótko, w której kolumnie (licząc od lewej) widzisz zaznaczenie. To pomaga uniknąć pomyłek.

- confidence: "wysoka" (>90%), "średnia" (60-90%), "niska" (<60%)
- Jeśli brak zaznaczenia → null
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(int $questionCount = 0, ?array $answerKey = null): string
    {
        $prompt = "Odczytaj odpowiedzi z karty odpowiedzi na załączonym zdjęciu.\n\n";

        $prompt .= "UKŁAD TABELI na karcie (kolumny od lewej do prawej): Nr | A | B | C | D\n";
        $prompt .= "Kolumna 2 od lewej = A, kolumna 3 = B, kolumna 4 = C, kolumna 5 (ostatnia) = D.\n\n";

        if ($questionCount > 0) {
            $prompt .= "Karta powinna zawierać {$questionCount} pytań.\n";
        } else {
            $prompt .= "Odczytaj WSZYSTKIE pytania widoczne na karcie.\n";
        }

        if ($answerKey) {
            $prompt .= "Numery pytań do odczytania: " . implode(', ', array_keys($answerKey)) . "\n";
        }

        $prompt .= "\nDla KAŻDEGO pytania:\n";
        $prompt .= "1. Znajdź wiersz z tym numerem\n";
        $prompt .= "2. Sprawdź kolejno kwadraty: A (2. kolumna), B (3.), C (4.), D (5.)\n";
        $prompt .= "3. Określ, który ma zaznaczenie (X, ✓, wypełnienie)\n";
        $prompt .= "4. W polu 'verification' zapisz: 'X w kolumnie N od lewej = LITERA'\n\n";
        $prompt .= "Odczytaj też KOD SPRAWDZIANU (np. T-42, E-15) z prawego górnego rogu.\n";
        $prompt .= "Odpowiedz WYŁĄCZNIE poprawnym JSON-em.";

        return $prompt;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['answers'])) {
            return null;
        }

        return $data;
    }

    /**
     * Compare scanned answers with answer key and calculate score.
     */
    public static function gradeAnswers(array $scannedAnswers, array $answerKey): array
    {
        $correct = 0;
        $incorrect = 0;
        $unanswered = 0;
        $details = [];

        foreach ($answerKey as $qNum => $correctAnswer) {
            $studentAnswer = $scannedAnswers[(string) $qNum] ?? null;

            if ($studentAnswer === null) {
                $status = 'brak';
                $unanswered++;
            } elseif (strtoupper($studentAnswer) === strtoupper($correctAnswer)) {
                $status = 'poprawna';
                $correct++;
            } else {
                $status = 'błędna';
                $incorrect++;
            }

            $details[] = [
                'number' => $qNum,
                'correct' => $correctAnswer,
                'student' => $studentAnswer,
                'status' => $status,
            ];
        }

        return [
            'correct' => $correct,
            'incorrect' => $incorrect,
            'unanswered' => $unanswered,
            'total' => count($answerKey),
            'percent' => count($answerKey) > 0 ? round($correct / count($answerKey) * 100, 0) : 0,
            'details' => $details,
        ];
    }
}
