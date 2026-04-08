<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class AnswerScannerPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś systemem OCR do odczytywania kart odpowiedzi z egzaminów i sprawdzianów szkolnych.
Analizujesz zdjęcie karty odpowiedzi i odczytujesz zaznaczone odpowiedzi ucznia.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "studentName": "Jan Kowalski",
  "answers": {
    "1": "B",
    "2": "A",
    "3": "D",
    "4": "C",
    "5": "B",
    "6": null,
    "7": "A"
  },
  "confidence": "wysoka",
  "notes": "Pytanie 6 — brak zaznaczenia lub nieczytelne."
}

Zasady odczytywania:
- Odczytaj IMIĘ I NAZWISKO ucznia (pole na górze karty)
- Dla każdego pytania odczytaj zaznaczoną odpowiedź (A, B, C lub D)
- Jeśli uczeń zaznaczył odpowiedź — podaj literę (A/B/C/D)
- Jeśli nie zaznaczył NICZEGO — podaj null
- Jeśli zaznaczył WIĘCEJ NIŻ JEDNĄ — podaj null i opisz w notes
- Jeśli zaznaczenie jest nieczytelne — podaj null i opisz w notes
- "confidence": "wysoka" / "średnia" / "niska" — ocena pewności odczytu
- Numeruj pytania zgodnie z numeracją na karcie (1, 2, 3...)
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(int $questionCount, ?array $answerKey = null): string
    {
        $prompt = "Odczytaj odpowiedzi z karty odpowiedzi na załączonym zdjęciu.\n";
        $prompt .= "Karta zawiera {$questionCount} pytań zamkniętych (ABCD).\n";

        if ($answerKey) {
            $prompt .= "Numery pytań: " . implode(', ', array_keys($answerKey)) . "\n";
        }

        $prompt .= "\nOdpowiedz WYŁĄCZNIE poprawnym JSON-em.";

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
