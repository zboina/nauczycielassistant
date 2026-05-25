<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class GazetkaArticlePromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś redaktorem szkolnej gazetki w polskiej szkole podstawowej. Piszesz teksty żywym,
poprawnym językiem polskim, dostosowanym do czytelnika w wieku 10–15 lat.

ZASADY:
- Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim.
- Opieraj się na szczegółach podanych przez użytkownika. NIE wymyślaj konkretnych nazwisk,
  dat ani liczb, których nie podano — jeśli brakuje danych, pisz ogólnie.
- Tekst ma być gotowy do druku w gazetce: zwięzły, ciekawy, z akapitami.
- Bez znaczników HTML i bez markdownu w treści.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez ```), w formacie:
{
  "title": "Chwytliwy tytuł artykułu",
  "lead": "Jedno-dwa zdania wprowadzenia (lead), streszczające temat.",
  "body": "Treść artykułu. Akapity oddzielaj pustą linią (\n\n). 2–6 akapitów."
}
PROMPT;

    /**
     * @return array{0:string,1:int} opis typu + sugerowana liczba słów
     */
    private function lengthSpec(string $length): array
    {
        return match ($length) {
            'short' => ['krótki', 110],
            'long' => ['obszerny', 380],
            default => ['średni', 220],
        };
    }

    public function buildUserPrompt(
        string $type,
        string $topic,
        string $details,
        string $length,
        string $tone,
    ): string {
        $typeDesc = match ($type) {
            'relacja' => 'relacja z wydarzenia (co się działo, kiedy, wrażenia)',
            'wywiad' => 'wywiad (kilka pytań i odpowiedzi z rozmówcą)',
            'zapowiedz' => 'zapowiedź nadchodzącego wydarzenia (zachęta do udziału)',
            'ciekawostka' => 'ciekawostka / artykuł popularny (lekki, edukacyjny)',
            'felieton' => 'felieton / opinia (osobisty, refleksyjny ton)',
            default => 'artykuł informacyjny',
        };

        $toneDesc = match ($tone) {
            'formalny' => 'formalny, rzeczowy',
            'humorystyczny' => 'lekki, z humorem',
            default => 'przyjazny, lekki',
        };

        [$lenDesc, $words] = $this->lengthSpec($length);
        $detailsBlock = $details !== '' ? "Szczegóły od redakcji:\n{$details}" : 'Brak dodatkowych szczegółów — napisz ogólnie, ale konkretnie.';

        return <<<PROMPT
Napisz tekst do szkolnej gazetki.

Rodzaj: {$typeDesc}
Temat: {$topic}
Ton: {$toneDesc}
Długość: {$lenDesc} (ok. {$words} słów)

{$detailsBlock}

Odpowiedz WYŁĄCZNIE poprawnym JSON-em ({title, lead, body}).
PROMPT;
    }

    /**
     * @return array{title:string,lead:string,body:string}|null
     */
    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim((string) $json);

        $data = json_decode($json, true);
        if (!is_array($data) || (!isset($data['body']) && !isset($data['title']))) {
            return null;
        }

        return [
            'title' => (string) ($data['title'] ?? ''),
            'lead' => (string) ($data['lead'] ?? ''),
            'body' => (string) ($data['body'] ?? ''),
        ];
    }
}
