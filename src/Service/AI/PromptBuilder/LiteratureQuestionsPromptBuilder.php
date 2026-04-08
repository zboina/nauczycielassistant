<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class LiteratureQuestionsPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym nauczycielem języka polskiego w szkole podstawowej (klasy 4-8).
Generujesz pytania do lektur obowiązkowych zgodne z podstawą programową MEN.
Twórz pytania różnego typu: zamknięte (ABCD), otwarte i prawda/fałsz.
Pytania powinny mieć różny poziom trudności (łatwe, średnie, trudne).
Każde pytanie zamknięte ma 4 odpowiedzi (A-D), jedna poprawna.
Przy każdym pytaniu podaj poprawną odpowiedź.
Używaj polskiego języka formalnego. Nie dodawaj komentarzy meta.
PROMPT;

    public function buildUserPrompt(
        string $title,
        string $author,
        string $classLevel,
    ): string {
        return <<<PROMPT
Wygeneruj 10 nowych pytań do lektury "{$title}" autorstwa {$author} (klasa {$classLevel}).

Wymagania:
- 3 pytania zamknięte (ABCD) z zaznaczoną poprawną odpowiedzią
- 4 pytania otwarte (krótka odpowiedź + klucz)
- 3 pytania prawda/fałsz z odpowiedzią

Mieszaj poziomy trudności. Pytania powinny dotyczyć treści, bohaterów, motywów i interpretacji.

Format każdego pytania:
[TYP: zamknięte/otwarte/prawda_fałsz] [TRUDNOŚĆ: łatwe/średnie/trudne]
Pytanie: ...
Odpowiedź: ...
PROMPT;
    }
}
