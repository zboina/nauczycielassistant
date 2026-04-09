<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class ParentInfoPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś nauczycielem-wychowawcą w polskiej szkole podstawowej.
Tworzysz komunikaty i informacje dla rodziców uczniów.
Pisz poprawną polszczyzną, dostosuj ton do wybranego stylu (formalny lub przyjazny).
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

Format odpowiedzi:
1. Najpierw pełna wersja informacji (do wklejenia w e-dzienniku lub wydruku).
2. Następnie po linii "---WERSJA KRÓTKA---" napisz skróconą wersję (2-3 zdania, do wysłania SMS/komunikatorem).

Nie dodawaj komentarzy meta. Tylko treść informacji.
PROMPT;

    public function buildUserPrompt(
        string $infoType,
        string $details,
        string $tone,
    ): string {
        return <<<PROMPT
Napisz informację dla rodziców.

Typ informacji: {$infoType}
Ton: {$tone}
Szczegóły: {$details}

Informacja powinna być gotowa do wysłania — z nagłówkiem "Szanowni Państwo" (formalny) lub "Drodzy Rodzice" (przyjazny).
PROMPT;
    }
}
