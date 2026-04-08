<?php

declare(strict_types=1);

namespace App\Service\AI;

use App\Entity\User;
use App\Repository\AiLogRepository;
use Symfony\Contracts\HttpClient\HttpClientInterface;

class OpenRouterClient
{
    private const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly AiLogRepository $logRepo,
        private readonly string $openrouterApiKey,
        private readonly string $openrouterDefaultModel,
    ) {}

    /**
     * Generate text with optional image (vision).
     * For vision: pass $imageBase64 as data URI (data:image/jpeg;base64,...) or raw base64.
     */
    public function generate(
        string $userPrompt,
        string $systemPrompt = '',
        string $module = 'unknown',
        ?string $model = null,
        int $maxTokens = 4000,
        ?User $owner = null,
        ?string $imageBase64 = null,
    ): string {
        $model ??= $this->openrouterDefaultModel;
        $messages = [];

        if ($systemPrompt !== '') {
            $messages[] = ['role' => 'system', 'content' => $systemPrompt];
        }

        if ($imageBase64) {
            // Multimodal message with image
            $imageUrl = str_starts_with($imageBase64, 'data:') ? $imageBase64 : 'data:image/jpeg;base64,' . $imageBase64;
            $messages[] = [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => $userPrompt],
                    ['type' => 'image_url', 'image_url' => ['url' => $imageUrl]],
                ],
            ];
        } else {
            $messages[] = ['role' => 'user', 'content' => $userPrompt];
        }

        $startMs = hrtime(true);

        try {
            $response = $this->httpClient->request('POST', self::BASE_URL, [
                'headers' => [
                    'Authorization' => 'Bearer ' . $this->openrouterApiKey,
                    'HTTP-Referer' => 'https://nauczyciel-app.local',
                    'X-Title' => 'Nauczyciel Assistant',
                    'Content-Type' => 'application/json',
                ],
                'json' => [
                    'model' => $model,
                    'messages' => $messages,
                    'max_tokens' => $maxTokens,
                ],
            ]);

            $data = $response->toArray(false);
            $durationMs = (int) ((hrtime(true) - $startMs) / 1_000_000);

            if (isset($data['error'])) {
                throw new \RuntimeException('OpenRouter API: ' . ($data['error']['message'] ?? json_encode($data['error'])));
            }

            if (!isset($data['choices'][0]['message']['content'])) {
                throw new \RuntimeException('OpenRouter API: nieprawidłowa odpowiedź — ' . json_encode($data));
            }

            $this->logRepo->save(
                module: $module,
                model: $model,
                tokensIn: $data['usage']['prompt_tokens'] ?? 0,
                tokensOut: $data['usage']['completion_tokens'] ?? 0,
                durationMs: $durationMs,
                owner: $owner,
            );

            return $data['choices'][0]['message']['content'];
        } catch (\Throwable $e) {
            $durationMs = (int) ((hrtime(true) - $startMs) / 1_000_000);

            $this->logRepo->save(
                module: $module,
                model: $model,
                tokensIn: 0,
                tokensOut: 0,
                durationMs: $durationMs,
                owner: $owner,
                status: 'error',
                error: $e->getMessage(),
            );

            throw new \RuntimeException('Błąd komunikacji z AI: ' . $e->getMessage(), 0, $e);
        }
    }
}
