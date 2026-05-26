<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class GazetkaRedactPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś redaktorem szkolnej gazetki w polskiej szkole. Redagujesz fragmenty tekstu po polsku —
żywym, poprawnym językiem dostosowanym do czytelnika w wieku 10–15 lat.

ZASADY:
- Odpowiadasz WYŁĄCZNIE zredagowanym fragmentem tekstu — bez wstępów, komentarzy,
  wyjaśnień, cudzysłowów, znaczników HTML ani markdownu.
- Zachowujesz język polski oraz sens wypowiedzi (chyba że polecenie mówi inaczej).
- Nie dodajesz nowych faktów, nazwisk, dat ani liczb, których nie ma w oryginale.
- Zachowujesz zbliżoną długość i liczbę akapitów, o ile polecenie nie każe skracać ani rozwijać.
- Jeśli we fragmencie jest kilka akapitów, oddzielaj je pustą linią.
PROMPT;

    public function buildUserPrompt(
        string $action,
        string $instruction,
        string $fragment,
        string $context,
    ): string {
        $task = match ($action) {
            'shorten' => 'Skróć poniższy fragment, zostawiając tylko najważniejsze treści.',
            'expand' => 'Rozwiń poniższy fragment, dodając więcej szczegółów w tym samym stylu (bez zmyślania faktów).',
            'fix' => 'Popraw w poniższym fragmencie błędy ortograficzne, interpunkcyjne, gramatyczne i stylistyczne. Nie zmieniaj sensu.',
            'simplify' => 'Uprość język poniższego fragmentu, aby był jasny i zrozumiały dla młodszych czytelników.',
            'formal' => 'Nadaj poniższemu fragmentowi bardziej oficjalny, rzeczowy ton.',
            'custom' => $instruction !== '' ? $instruction : 'Przeredaguj poniższy fragment innymi słowami, zachowując sens i ton.',
            default => 'Przeredaguj poniższy fragment innymi słowami, zachowując sens i ton.',
        };

        $ctx = trim($context);
        $frag = trim($fragment);
        $ctxBlock = ($ctx !== '' && $ctx !== $frag)
            ? "Kontekst (tekst całej ramki — NIE redaguj go, użyj tylko do zachowania tonu i tematu):\n\"\"\"\n{$ctx}\n\"\"\"\n\n"
            : '';

        return <<<PROMPT
{$task}

{$ctxBlock}Fragment do zredagowania:
"""
{$fragment}
"""

Odpowiedz wyłącznie zredagowanym fragmentem, bez żadnych dodatkowych słów.
PROMPT;
    }
}
