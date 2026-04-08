<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

use App\Service\AI\CurriculumContext;

class TestPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym nauczycielem języka polskiego w polskiej szkole podstawowej (klasy 4-8).
Tworzysz sprawdziany zgodne z podstawą programową MEN.
Używaj polskiego języka formalnego, dostosowanego do wieku ucznia (9-15 lat).

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "title": "Sprawdzian — [temat]",
  "totalPoints": 20,
  "questions": [
    {
      "type": "closed",
      "text": "Treść pytania zamkniętego",
      "points": 1,
      "options": ["odpowiedź A", "odpowiedź B", "odpowiedź C", "odpowiedź D"],
      "correct": "A"
    },
    {
      "type": "open",
      "text": "Treść pytania otwartego",
      "points": 3,
      "lines": 4,
      "answer": "Model odpowiedzi / wskazówki do oceniania"
    },
    {
      "type": "true_false",
      "text": "Stwierdzenie do oceny prawda/fałsz",
      "points": 1,
      "correct": "P"
    }
  ]
}

Zasady:
- Pytania zamknięte (closed): DOKŁADNIE 4 opcje (A-D), jedna poprawna. "correct" to litera A/B/C/D.
- Pytania otwarte (open): "lines" to liczba linii na odpowiedź (2-8). "answer" to model odpowiedzi dla nauczyciela.
- Pytania prawda/fałsz (true_false): "correct" to "P" lub "F".
- "totalPoints" = suma punktów wszystkich pytań.
- Odpowiadaj TYLKO JSON-em. Żadnego tekstu przed ani po.
PROMPT;

    public function buildUserPrompt(
        string $classLevel,
        string $subject,
        array $questionTypes,
        int $questionCount,
        string $difficulty,
        string $notes = '',
    ): string {
        $types = implode(', ', $questionTypes);
        $ppContext = CurriculumContext::forClass($classLevel);

        $typeMapping = [
            'zamknięte (ABCD)' => 'closed',
            'otwarte krótkie' => 'open',
            'prawda/fałsz' => 'true_false',
        ];
        $jsonTypes = [];
        foreach ($questionTypes as $t) {
            $jsonTypes[] = $typeMapping[$t] ?? $t;
        }
        $jsonTypesStr = implode(', ', $jsonTypes);

        $prompt = <<<PROMPT
Wygeneruj sprawdzian z języka polskiego jako JSON.

Klasa: {$classLevel}
Temat/Lektura: {$subject}
Typy pytań do użycia: {$jsonTypesStr}
Liczba pytań: {$questionCount}
Poziom trudności: {$difficulty}

{$ppContext}
PROMPT;

        if ($notes !== '') {
            $prompt .= "\nDodatkowe uwagi: {$notes}";
        }

        $prompt .= "\n\nOdpowiedz WYŁĄCZNIE poprawnym JSON-em.";

        return $prompt;
    }

    /**
     * Parse AI response to structured test data.
     * Returns array with 'title', 'totalPoints', 'questions' or null on failure.
     */
    public static function parseResponse(string $response): ?array
    {
        // Strip markdown code blocks if AI wrapped it
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['questions'])) {
            return null;
        }

        // Ensure totalPoints is calculated
        if (!isset($data['totalPoints'])) {
            $data['totalPoints'] = array_sum(array_column($data['questions'], 'points'));
        }

        return $data;
    }
}
