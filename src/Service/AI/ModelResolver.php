<?php

declare(strict_types=1);

namespace App\Service\AI;

use App\Repository\AppSettingRepository;

class ModelResolver
{
    public const MODULES = [
        'test_generator' => 'Sprawdziany',
        'worksheet_generator' => 'Karty pracy',
        'dictation_generator' => 'Dyktanda',
        'parent_info_generator' => 'Info dla rodziców',
        'lesson_plan' => 'Konspekty lekcji',
        'mock_exam_generator' => 'Egzamin 8-klasisty',
        'essay_review' => 'Sprawdzanie wypracowań',
        'ai_detection' => 'Detekcja AI-autorstwa',
        'literature_add' => 'Dodawanie lektur',
        'literature_questions' => 'Pytania do lektur',
        'topic_suggestions' => 'Podpowiedzi tematów',
        'chat' => 'Asystent AI (chat)',
        'editor_ai_add' => 'Dogenerowanie w edytorze',
    ];

    public const AVAILABLE_MODELS = [
        // Tanie
        'google/gemini-2.5-flash-lite' => ['name' => 'Gemini 2.5 Flash Lite', 'tier' => 'budget', 'input' => '$0.10/M', 'output' => '$0.40/M', 'desc' => 'Najtańszy, szybki, OK dla prostych zadań'],
        'google/gemini-2.0-flash-001' => ['name' => 'Gemini 2.0 Flash', 'tier' => 'budget', 'input' => '$0.10/M', 'output' => '$0.40/M', 'desc' => 'Tani, starszy model Flash'],
        // Standardowe
        'google/gemini-2.5-flash' => ['name' => 'Gemini 2.5 Flash ⭐', 'tier' => 'standard', 'input' => '$0.15/M', 'output' => '$0.60/M', 'desc' => 'Domyślny — dobry balans ceny i jakości'],
        'google/gemini-3-flash-preview' => ['name' => 'Gemini 3 Flash (preview)', 'tier' => 'standard', 'input' => '$0.50/M', 'output' => '$3/M', 'desc' => 'Nowy Flash — lepszy od 2.5, droższy'],
        // Lepsze
        'google/gemini-2.5-pro' => ['name' => 'Gemini 2.5 Pro', 'tier' => 'premium', 'input' => '$1.25/M', 'output' => '$10/M', 'desc' => 'Bardzo dobry — świetna jakość tekstu'],
        'anthropic/claude-sonnet-4' => ['name' => 'Claude Sonnet 4', 'tier' => 'premium', 'input' => '$3/M', 'output' => '$15/M', 'desc' => 'Doskonały w języku polskim, drogi'],
        // Super
        'anthropic/claude-opus-4' => ['name' => 'Claude Opus 4 🏆', 'tier' => 'ultra', 'input' => '$15/M', 'output' => '$75/M', 'desc' => 'Najlepszy model — perfekcyjny polski, najdroższy'],
    ];

    public function __construct(
        private readonly AppSettingRepository $settings,
        private readonly string $defaultModel,
    ) {}

    public function getModelForModule(string $module): string
    {
        $key = 'model_' . $module;
        $model = $this->settings->get($key);
        return $model ?: $this->defaultModel;
    }

    public function getModelSettings(): array
    {
        $all = $this->settings->getAll();
        $result = [];
        foreach (self::MODULES as $module => $label) {
            $key = 'model_' . $module;
            $result[$module] = [
                'label' => $label,
                'model' => $all[$key] ?? '',
            ];
        }
        return $result;
    }
}
