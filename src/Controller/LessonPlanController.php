<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\LessonPlan;
use App\Entity\Literature;
use App\Form\LessonPlanType;
use App\Repository\LessonPlanRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\LessonPlanPromptBuilder;
use App\Service\DocxGenerator;
use App\Service\PdfGenerator;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/lesson-plans')]
class LessonPlanController extends AbstractController
{
    public function __construct(
        private readonly OpenRouterClient $ai,
        private readonly EntityManagerInterface $em,
        private readonly PdfGenerator $pdf,
        private readonly DocxGenerator $docx,
    ) {}

    #[Route('/suggest-topics', name: 'app_lesson_plan_suggest_topics', methods: ['POST'])]
    public function suggestTopics(Request $request): Response
    {
        $litId = $request->request->getInt('literatureId');
        $classLevel = $request->request->get('classLevel', '');

        $literature = $litId ? $this->em->getRepository(Literature::class)->find($litId) : null;
        if (!$literature) {
            return $this->json(['error' => 'Wybierz lekturę'], 400);
        }

        $prompt = <<<PROMPT
Podaj 10 konkretnych, różnorodnych tematów lekcji języka polskiego do lektury "{$literature->getTitle()}" ({$literature->getAuthor()}) dla klasy {$classLevel} szkoły podstawowej.

Tematy powinny być:
- Zgodne z podstawą programową MEN
- Zróżnicowane: analiza tekstu, charakterystyka bohaterów, problematyka, kontekst, język, dyskusja, twórcze pisanie
- Sformułowane jak prawdziwe tematy lekcji (nie pytania)
- Dostosowane do poziomu klasy {$classLevel}

Odpowiedz WYŁĄCZNIE jako JSON array stringów, np:
["Temat 1", "Temat 2", "Temat 3"]
PROMPT;

        try {
            $result = $this->ai->generate(
                userPrompt: $prompt,
                systemPrompt: 'Jesteś doświadczonym nauczycielem języka polskiego. Odpowiadaj WYŁĄCZNIE poprawnym JSON-em (array stringów).',
                module: 'topic_suggestions',
                maxTokens: 1500,
                owner: $this->getUser(),
            );

            $json = trim($result);
            $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
            $json = preg_replace('/\s*```$/', '', $json);
            $topics = json_decode(trim($json), true);

            if (!is_array($topics)) {
                return $this->json(['topics' => []]);
            }

            return $this->json(['topics' => array_values($topics)]);
        } catch (\RuntimeException $e) {
            return $this->json(['error' => $e->getMessage()], 500);
        }
    }

    #[Route('', name: 'app_lesson_plan_index')]
    public function index(Request $request, LessonPlanRepository $repo): Response
    {
        $classLevel = $request->query->get('class');
        $plans = $repo->findByOwner($this->getUser(), $classLevel);

        return $this->render('lesson_plan/index.html.twig', [
            'plans' => $plans,
            'currentClass' => $classLevel,
        ]);
    }

    #[Route('/generate', name: 'app_lesson_plan_generate')]
    public function generate(Request $request): Response
    {
        $form = $this->createForm(LessonPlanType::class);

        // Pre-fill literature if coming from literature page
        $litId = $request->query->getInt('literature');
        if ($litId) {
            $lit = $this->em->getRepository(Literature::class)->find($litId);
            if ($lit) {
                $form->get('literature')->setData($lit);
                $form->get('classLevel')->setData($lit->getClassLevel());
            }
        }

        $form->handleRequest($request);

        if ($form->isSubmitted() && $form->isValid()) {
            $data = $form->getData();
            /** @var Literature $literature */
            $literature = $data['literature'];

            $builder = new LessonPlanPromptBuilder();
            $userPrompt = $builder->buildUserPrompt(
                classLevel: $data['classLevel'],
                literatureTitle: $literature->getTitle(),
                literatureAuthor: $literature->getAuthor(),
                lessonTopic: $data['lessonTopic'],
                durationMinutes: (int) $data['duration'],
                focus: $data['focus'],
                notes: $data['notes'] ?? '',
            );

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: LessonPlanPromptBuilder::SYSTEM_PROMPT,
                    module: 'lesson_plan_generator',
                    maxTokens: 6000,
                    owner: $this->getUser(),
                );

                $parsed = LessonPlanPromptBuilder::parseResponse($result);

                $request->getSession()->set('last_lesson_plan', [
                    'raw' => $result,
                    'parsed' => $parsed,
                    'classLevel' => $data['classLevel'],
                    'literatureId' => $literature->getId(),
                    'literatureTitle' => $literature->getTitle(),
                    'lessonTopic' => $data['lessonTopic'],
                    'duration' => $data['duration'],
                    'prompt' => $userPrompt,
                ]);

                if (!$parsed) {
                    $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Wyświetlam tekst surowy.');
                }
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_lesson_plan_generate', $litId ? ['literature' => $litId] : []);
        }

        $sessionData = $request->getSession()->get('last_lesson_plan');

        return $this->render('lesson_plan/generate.html.twig', [
            'form' => $form,
            'lpData' => $sessionData['parsed'] ?? null,
            'lpRaw' => $sessionData['raw'] ?? null,
            'sessionData' => $sessionData,
        ]);
    }

    #[Route('/save', name: 'app_lesson_plan_save', methods: ['POST'])]
    public function save(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_lesson_plan');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do zapisania. Wygeneruj najpierw konspekt.');
            return $this->redirectToRoute('app_lesson_plan_generate');
        }

        $literature = $sessionData['literatureId']
            ? $this->em->getRepository(Literature::class)->find($sessionData['literatureId'])
            : null;

        $plan = new LessonPlan();
        $plan->setTitle($sessionData['lessonTopic']);
        $plan->setClassLevel($sessionData['classLevel']);
        $plan->setLiterature($literature);
        $plan->setLessonTopic($sessionData['lessonTopic']);
        $plan->setContent($sessionData['raw'] ?? json_encode($sessionData['parsed'] ?? [], JSON_UNESCAPED_UNICODE));
        $plan->setPromptUsed($sessionData['prompt']);
        $plan->setDurationMinutes((int) $sessionData['duration']);
        $plan->setOwner($this->getUser());

        $this->em->persist($plan);
        $this->em->flush();

        $this->addFlash('success', 'Konspekt zapisany!');

        return $this->redirectToRoute('app_lesson_plan_show', ['id' => $plan->getId()]);
    }

    #[Route('/{id}', name: 'app_lesson_plan_show', requirements: ['id' => '\d+'])]
    public function show(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $lpData = LessonPlanPromptBuilder::parseResponse($plan->getContent());

        return $this->render('lesson_plan/show.html.twig', [
            'plan' => $plan,
            'lpData' => $lpData,
        ]);
    }

    #[Route('/{id}/pdf', name: 'app_lesson_plan_pdf', requirements: ['id' => '\d+'])]
    public function pdf(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $lpData = LessonPlanPromptBuilder::parseResponse($plan->getContent());

        return $this->pdf->generateResponse(
            'pdf/lesson_plan.html.twig',
            ['plan' => $plan, 'lpData' => $lpData],
            'konspekt_' . date('Y-m-d_His') . '.pdf',
        );
    }

    #[Route('/create-manual', name: 'app_lesson_plan_create_manual')]
    public function createManual(Request $request): Response
    {
        if ($request->isMethod('POST')) {
            $title = trim($request->request->get('title', ''));
            $classLevel = $request->request->get('classLevel', '');
            if ($title === '') {
                $this->addFlash('error', 'Podaj tytuł.');
                return $this->redirectToRoute('app_lesson_plan_create_manual');
            }

            $emptyData = [
                'title' => $title,
                'classLevel' => $classLevel,
                'duration' => 45,
                'goalsGeneral' => [],
                'goalsSpecific' => [],
                'methods' => [],
                'materials' => [],
                'phases' => [
                    ['name' => 'Faza wstępna', 'duration' => '5 min', 'activities' => []],
                    ['name' => 'Faza realizacji', 'duration' => '30 min', 'activities' => []],
                    ['name' => 'Faza podsumowująca', 'duration' => '10 min', 'activities' => []],
                ],
                'homework' => '',
                'evaluation' => '',
            ];

            $plan = new LessonPlan();
            $plan->setTitle($title);
            $plan->setClassLevel($classLevel);
            $plan->setLessonTopic($title);
            $plan->setContent(json_encode($emptyData, JSON_UNESCAPED_UNICODE));
            $plan->setDurationMinutes(45);
            $plan->setOwner($this->getUser());

            $this->em->persist($plan);
            $this->em->flush();

            $this->addFlash('success', 'Utworzono konspekt. Uzupełnij w edytorze.');
            return $this->redirectToRoute('app_lesson_plan_edit', ['id' => $plan->getId()]);
        }

        return $this->render('lesson_plan/create_manual.html.twig');
    }

    #[Route('/{id}/edit', name: 'app_lesson_plan_edit', requirements: ['id' => '\d+'])]
    public function edit(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) { throw $this->createAccessDeniedException(); }
        $lpData = LessonPlanPromptBuilder::parseResponse($plan->getContent());
        return $this->render('lesson_plan/edit.html.twig', ['plan' => $plan, 'data' => $lpData]);
    }

    #[Route('/{id}/api-save', name: 'app_lesson_plan_api_save', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function apiSave(Request $request, LessonPlan $plan): JsonResponse
    {
        if ($plan->getOwner() !== $this->getUser()) { return new JsonResponse(['error' => 'Brak dostępu'], 403); }
        $data = json_decode($request->getContent(), true);
        if (!$data) { return new JsonResponse(['error' => 'Nieprawidłowy JSON'], 400); }
        $plan->setContent(json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        if (isset($data['title'])) { $plan->setTitle($data['title']); }
        $this->em->flush();
        return new JsonResponse(['ok' => true]);
    }

    #[Route('/{id}/docx', name: 'app_lesson_plan_docx', requirements: ['id' => '\d+'])]
    public function docx(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $lpData = LessonPlanPromptBuilder::parseResponse($plan->getContent());
        if (!$lpData) {
            $this->addFlash('error', 'Nie można wyeksportować — brak danych strukturalnych.');
            return $this->redirectToRoute('app_lesson_plan_show', ['id' => $plan->getId()]);
        }

        $word = $this->docx->generateLessonPlanDocx($lpData, $plan->getLessonTopic());
        return $this->docx->generateResponse($word, 'konspekt_' . date('Y-m-d') . '.docx');
    }

    #[Route('/{id}/favorite', name: 'app_lesson_plan_favorite', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function toggleFavorite(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $plan->setIsFavorite(!$plan->isFavorite());
        $this->em->flush();

        return $this->redirectToRoute('app_lesson_plan_show', ['id' => $plan->getId()]);
    }

    #[Route('/{id}/delete', name: 'app_lesson_plan_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function delete(LessonPlan $plan): Response
    {
        if ($plan->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $this->em->remove($plan);
        $this->em->flush();

        $this->addFlash('success', 'Konspekt usunięty.');

        return $this->redirectToRoute('app_lesson_plan_index');
    }
}
