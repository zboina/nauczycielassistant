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
        private readonly ModelResolver $modelResolver,
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
        // Resolve model: explicit param > settings per module > env default
        if (!$model) {
            $model = $this->modelResolver->getModelForModule($module);
        }
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

            // OpenRouter cost: try multiple fields, then calculate from tokens
            $costUsd = $data['usage']['total_cost']
                ?? $data['usage']['cost']
                ?? $data['total_cost']
                ?? null;

            // If no cost returned, calculate from known model prices
            if (!$costUsd) {
                $tokIn = $data['usage']['prompt_tokens'] ?? 0;
                $tokOut = $data['usage']['completion_tokens'] ?? 0;
                $costUsd = $this->calculateCost($model, $tokIn, $tokOut);
            }

            $this->logRepo->save(
                module: $module,
                model: $model,
                tokensIn: $data['usage']['prompt_tokens'] ?? 0,
                tokensOut: $data['usage']['completion_tokens'] ?? 0,
                durationMs: $durationMs,
                owner: $owner,
                costUsd: $costUsd ? (string) $costUsd : null,
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

    /**
     * Calculate cost from tokens using known model prices (per million tokens).
     */
    private function calculateCost(string $model, int $tokIn, int $tokOut): ?string
    {
        // Prices per 1M tokens [input, output] in USD
        $prices = [
            'google/gemini-2.5-flash' => [0.15, 0.60],
            'google/gemini-2.5-flash-lite' => [0.10, 0.40],
            'google/gemini-2.5-flash-image' => [0.30, 2.50],
            'google/gemini-2.0-flash-001' => [0.10, 0.40],
            'google/gemini-3-flash-preview' => [0.50, 3.00],
            'google/gemini-2.5-pro' => [1.25, 10.00],
            'google/gemini-3.1-pro-preview' => [2.00, 12.00],
            'anthropic/claude-sonnet-4' => [3.00, 15.00],
            'anthropic/claude-opus-4' => [15.00, 75.00],
            'qwen/qwen2.5-vl-32b-instruct' => [0.40, 0.40],
        ];

        $p = $prices[$model] ?? null;
        if (!$p) return null;

        $cost = ($tokIn / 1_000_000) * $p[0] + ($tokOut / 1_000_000) * $p[1];
        return $cost > 0 ? number_format($cost, 8, '.', '') : null;
    }
}
