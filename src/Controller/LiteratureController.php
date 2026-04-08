<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\Literature;
use App\Repository\LiteratureRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\LiteratureQuestionsPromptBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
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
            $this->addFlash('success', sprintf('Lektura przeniesiona do klasy %s.', $newClass));
        }

        return $this->redirectToRoute('app_literature_show', ['id' => $literature->getId()]);
    }
}
