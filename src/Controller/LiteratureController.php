<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\Literature;
use App\Entity\LiteratureQuestion;
use App\Repository\LiteratureRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\LiteratureQuestionsPromptBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/literature')]
class LiteratureController extends AbstractController
{
    #[Route('', name: 'app_literature_index')]
    public function index(Request $request, LiteratureRepository $repo): Response
    {
        $classLevel = $request->query->get('class');
        $search = $request->query->get('q');

        $literatures = $repo->findByFilters($classLevel, $search);

        return $this->render('literature/index.html.twig', [
            'literatures' => $literatures,
            'currentClass' => $classLevel,
            'search' => $search,
        ]);
    }

    #[Route('/{id}', name: 'app_literature_show', requirements: ['id' => '\d+'])]
    public function show(Literature $literature): Response
    {
        return $this->render('literature/show.html.twig', [
            'literature' => $literature,
        ]);
    }

    #[Route('/{id}/generate-questions', name: 'app_literature_generate_questions', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function generateQuestions(Literature $literature, Request $request, OpenRouterClient $ai): Response
    {
        $builder = new LiteratureQuestionsPromptBuilder();
        $userPrompt = $builder->buildUserPrompt(
            title: $literature->getTitle(),
            author: $literature->getAuthor(),
            classLevel: $literature->getClassLevel() ?? '7',
        );

        try {
            $result = $ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: LiteratureQuestionsPromptBuilder::SYSTEM_PROMPT,
                module: 'literature_questions',
                owner: $this->getUser(),
            );

            $request->getSession()->set('generated_questions_' . $literature->getId(), $result);
        } catch (\RuntimeException $e) {
            $this->addFlash('error', $e->getMessage());
        }

        return $this->redirectToRoute('app_literature_show', ['id' => $literature->getId()]);
    }

    #[Route('/{id}/change-class', name: 'app_literature_change_class', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function changeClass(Literature $literature, Request $request, EntityManagerInterface $em): Response
    {
        $newClass = $request->request->get('classLevel');
        if ($newClass && in_array($newClass, ['4', '5', '6', '7', '8'], true)) {
            $literature->setClassLevel($newClass);
            $em->flush();

            if ($request->headers->get('X-Requested-With') === 'XMLHttpRequest') {
                return new JsonResponse(['ok' => true]);
            }
            $this->addFlash('success', sprintf('Lektura przeniesiona do klasy %s.', $newClass));
        }

        return $this->redirectToRoute('app_literature_show', ['id' => $literature->getId()]);
    }

    #[Route('/add', name: 'app_literature_add')]
    public function add(Request $request, OpenRouterClient $ai, EntityManagerInterface $em): Response
    {
        if ($request->isMethod('POST')) {
            $title = trim($request->request->get('title', ''));
            $classLevel = $request->request->get('classLevel', '7');

            if ($title === '') {
                $this->addFlash('error', 'Podaj tytuł lektury.');
                return $this->redirectToRoute('app_literature_add');
            }

            $prompt = <<<PROMPT
Przygotuj dane o lekturze "{$title}" dla klasy {$classLevel} szkoły podstawowej.

Odpowiedz WYŁĄCZNIE poprawnym JSON-em:
{
  "title": "Pełny tytuł lektury",
  "author": "Imię i Nazwisko autora",
  "epoch": "Epoka literacka (np. romantyzm, pozytywizm, XX wiek)",
  "summary": "Streszczenie lektury (8-12 zdań, najważniejsze wydarzenia i przesłanie)",
  "characters": [
    {"name": "Imię postaci", "description": "Krótki opis roli i cech (1-2 zdania)"}
  ],
  "themes": ["motyw1", "motyw2", "motyw3"],
  "isObligatory": false,
  "questions": [
    {"question": "Treść pytania", "answer": "Odpowiedź", "difficulty": "easy|medium|hard", "questionType": "open|closed|true_false"}
  ]
}

Wymagania:
- 3-6 bohaterów z opisami
- 5-8 motywów/tematów
- 6-10 pytań (mix typów: open, closed z opcjami ABCD, true_false)
- Pytania zamknięte: dodaj opcje w treści (A/B/C/D), answer = litera
- isObligatory: true jeśli jest w podstawie programowej MEN kl. {$classLevel}, false jeśli nie
- Odpowiadaj TYLKO JSON-em
PROMPT;

            try {
                $result = $ai->generate(
                    userPrompt: $prompt,
                    systemPrompt: 'Jesteś ekspertem od literatury polskiej i światowej. Odpowiadaj WYŁĄCZNIE poprawnym JSON-em.',
                    module: 'literature_add',
                    maxTokens: 4000,
                    owner: $this->getUser(),
                );

                $json = trim($result);
                $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
                $json = preg_replace('/\s*```$/', '', $json);
                $data = json_decode(trim($json), true);

                if (!$data || !isset($data['title'])) {
                    $this->addFlash('error', 'AI nie zwróciło poprawnych danych. Spróbuj ponownie.');
                    return $this->redirectToRoute('app_literature_add');
                }

                $lit = new Literature();
                $lit->setTitle($data['title']);
                $lit->setAuthor($data['author'] ?? 'Nieznany');
                $lit->setClassLevel($classLevel);
                $lit->setEpoch($data['epoch'] ?? null);
                $lit->setSummary($data['summary'] ?? null);
                $lit->setCharacters($data['characters'] ?? null);
                $lit->setThemes($data['themes'] ?? null);
                $lit->setIsObligatory($data['isObligatory'] ?? false);

                $em->persist($lit);

                foreach ($data['questions'] ?? [] as $q) {
                    $question = new LiteratureQuestion();
                    $question->setQuestion($q['question'] ?? '');
                    $question->setAnswer($q['answer'] ?? null);
                    $question->setDifficulty($q['difficulty'] ?? null);
                    $question->setQuestionType($q['questionType'] ?? null);
                    $lit->addQuestion($question);
                    $em->persist($question);
                }

                $em->flush();

                $this->addFlash('success', 'Lektura "' . $lit->getTitle() . '" dodana z ' . count($data['questions'] ?? []) . ' pytaniami.');
                return $this->redirectToRoute('app_literature_show', ['id' => $lit->getId()]);

            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
                return $this->redirectToRoute('app_literature_add');
            }
        }

        return $this->render('literature/add.html.twig');
    }

    #[Route('/organize', name: 'app_literature_organize')]
    public function organize(LiteratureRepository $repo): Response
    {
        $all = $repo->findBy([], ['classLevel' => 'ASC', 'title' => 'ASC']);
        $byClass = [];
        foreach (['4','5','6','7','8'] as $cl) {
            $byClass[$cl] = [];
        }
        foreach ($all as $lit) {
            $cl = $lit->getClassLevel() ?? '4';
            $byClass[$cl][] = $lit;
        }

        return $this->render('literature/organize.html.twig', [
            'byClass' => $byClass,
        ]);
    }

    #[Route('/{id}/delete', name: 'app_literature_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function delete(Literature $literature, EntityManagerInterface $em): Response
    {
        $title = $literature->getTitle();
        $em->remove($literature);
        $em->flush();
        $this->addFlash('success', 'Lektura "' . $title . '" usunięta.');
        return $this->redirectToRoute('app_literature_index');
    }
}
