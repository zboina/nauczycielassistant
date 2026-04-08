<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\GeneratedMaterial;
use App\Form\GenerateTestType;
use App\Form\GenerateWorksheetType;
use App\Form\GenerateParentInfoType;
use App\Repository\GeneratedMaterialRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\TestPromptBuilder;
use App\Service\AI\PromptBuilder\WorksheetPromptBuilder;
use App\Service\AI\PromptBuilder\ParentInfoPromptBuilder;
use App\Service\PdfGenerator;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/generate')]
class GeneratorController extends AbstractController
{
    public function __construct(
        private readonly OpenRouterClient $ai,
        private readonly EntityManagerInterface $em,
        private readonly PdfGenerator $pdf,
    ) {}

    // ─── LISTA SPRAWDZIANÓW ────────────────────────────────────

    #[Route('/test', name: 'app_generate_test_index')]
    public function testIndex(Request $request, GeneratedMaterialRepository $repo): Response
    {
        return $this->render('generator/test_index.html.twig', [
            'materials' => $repo->findByTypeAndOwner($this->getUser(), 'test', $request->query->get('class')),
            'currentClass' => $request->query->get('class'),
        ]);
    }

    #[Route('/test/new', name: 'app_generate_test')]
    public function test(Request $request): Response
    {
        $form = $this->createForm(GenerateTestType::class);
        $form->handleRequest($request);

        if ($form->isSubmitted() && $form->isValid()) {
            $data = $form->getData();

            $builder = new TestPromptBuilder();
            $userPrompt = $builder->buildUserPrompt(
                classLevel: $data['classLevel'],
                subject: $data['subject'],
                questionTypes: $data['questionTypes'],
                questionCount: (int) $data['questionCount'],
                difficulty: $data['difficulty'],
                notes: $data['notes'] ?? '',
            );

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: TestPromptBuilder::SYSTEM_PROMPT,
                    module: 'test_generator',
                    owner: $this->getUser(),
                );

                $parsed = TestPromptBuilder::parseResponse($result);

                $request->getSession()->set('last_test', [
                    'raw' => $result,
                    'parsed' => $parsed,
                    'classLevel' => $data['classLevel'],
                    'subject' => $data['subject'],
                    'prompt' => $userPrompt,
                ]);

                if (!$parsed) {
                    $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Wyświetlam tekst surowy.');
                }
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_generate_test');
        }

        $sessionData = $request->getSession()->get('last_test');

        return $this->render('generator/test.html.twig', [
            'form' => $form,
            'testData' => $sessionData['parsed'] ?? null,
            'testRaw' => $sessionData['raw'] ?? null,
            'sessionData' => $sessionData,
        ]);
    }

    #[Route('/test/save', name: 'app_generate_test_save', methods: ['POST'])]
    public function testSave(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_test');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do zapisania. Wygeneruj najpierw sprawdzian.');
            return $this->redirectToRoute('app_generate_test');
        }

        $material = new GeneratedMaterial();
        $material->setType('test');
        $material->setTitle('Sprawdzian — ' . $sessionData['subject']);
        $material->setClassLevel($sessionData['classLevel']);
        $material->setSubjectContext($sessionData['subject']);
        $material->setPromptUsed($sessionData['prompt']);
        $material->setContent($sessionData['raw'] ?? json_encode($sessionData['parsed'] ?? [], JSON_UNESCAPED_UNICODE));
        $material->setOwner($this->getUser());

        $this->em->persist($material);
        $this->em->flush();

        $this->addFlash('success', 'Sprawdzian zapisany w historii.');

        return $this->redirectToRoute('app_generate_test');
    }

    #[Route('/test/pdf', name: 'app_generate_test_pdf')]
    public function testPdf(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_test');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do eksportu. Wygeneruj najpierw sprawdzian.');
            return $this->redirectToRoute('app_generate_test');
        }

        $includeAnswers = $request->query->getBoolean('answers', false);

        return $this->pdf->generateResponse(
            'pdf/test.html.twig',
            [
                'testData' => $sessionData['parsed'] ?? null,
                'testRaw' => $sessionData['raw'] ?? null,
                'subject' => $sessionData['subject'],
                'classLevel' => $sessionData['classLevel'],
                'includeAnswers' => $includeAnswers,
                'materialId' => null,
            ],
            'sprawdzian_' . date('Y-m-d_His') . '.pdf',
        );
    }

    // ─── LISTA KART PRACY ──────────────────────────────────────

    #[Route('/worksheet', name: 'app_generate_worksheet_index')]
    public function worksheetIndex(Request $request, GeneratedMaterialRepository $repo): Response
    {
        return $this->render('generator/worksheet_index.html.twig', [
            'materials' => $repo->findByTypeAndOwner($this->getUser(), 'worksheet', $request->query->get('class')),
            'currentClass' => $request->query->get('class'),
        ]);
    }

    #[Route('/worksheet/new', name: 'app_generate_worksheet')]
    public function worksheet(Request $request): Response
    {
        $form = $this->createForm(GenerateWorksheetType::class);
        $form->handleRequest($request);

        if ($form->isSubmitted() && $form->isValid()) {
            $data = $form->getData();

            $builder = new WorksheetPromptBuilder();
            $userPrompt = $builder->buildUserPrompt(
                classLevel: $data['classLevel'],
                topic: $data['topic'],
                exerciseTypes: $data['exerciseTypes'],
                taskCount: (int) $data['taskCount'],
                duration: $data['duration'],
                baseText: $data['baseText'] ?? '',
            );

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: WorksheetPromptBuilder::SYSTEM_PROMPT,
                    module: 'worksheet_generator',
                    owner: $this->getUser(),
                );

                $parsed = WorksheetPromptBuilder::parseResponse($result);

                $request->getSession()->set('last_worksheet', [
                    'raw' => $result,
                    'parsed' => $parsed,
                    'classLevel' => $data['classLevel'],
                    'topic' => $data['topic'],
                    'prompt' => $userPrompt,
                ]);

                if (!$parsed) {
                    $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Wyświetlam tekst surowy.');
                }
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_generate_worksheet');
        }

        $sessionData = $request->getSession()->get('last_worksheet');

        return $this->render('generator/worksheet.html.twig', [
            'form' => $form,
            'wsData' => $sessionData['parsed'] ?? null,
            'wsRaw' => $sessionData['raw'] ?? null,
            'sessionData' => $sessionData,
        ]);
    }

    #[Route('/worksheet/save', name: 'app_generate_worksheet_save', methods: ['POST'])]
    public function worksheetSave(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_worksheet');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do zapisania.');
            return $this->redirectToRoute('app_generate_worksheet');
        }

        $material = new GeneratedMaterial();
        $material->setType('worksheet');
        $material->setTitle('Karta pracy — ' . $sessionData['topic']);
        $material->setClassLevel($sessionData['classLevel']);
        $material->setSubjectContext($sessionData['topic']);
        $material->setPromptUsed($sessionData['prompt']);
        $material->setContent($sessionData['raw'] ?? json_encode($sessionData['parsed'] ?? [], JSON_UNESCAPED_UNICODE));
        $material->setOwner($this->getUser());

        $this->em->persist($material);
        $this->em->flush();

        $this->addFlash('success', 'Karta pracy zapisana w historii.');

        return $this->redirectToRoute('app_generate_worksheet');
    }

    #[Route('/worksheet/pdf', name: 'app_generate_worksheet_pdf')]
    public function worksheetPdf(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_worksheet');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do eksportu.');
            return $this->redirectToRoute('app_generate_worksheet');
        }

        $includeAnswers = $request->query->getBoolean('answers', false);

        return $this->pdf->generateResponse(
            'pdf/worksheet.html.twig',
            [
                'wsData' => $sessionData['parsed'] ?? null,
                'wsRaw' => $sessionData['raw'] ?? null,
                'topic' => $sessionData['topic'],
                'classLevel' => $sessionData['classLevel'],
                'includeAnswers' => $includeAnswers,
            ],
            'karta_pracy_' . date('Y-m-d_His') . '.pdf',
        );
    }

    // ─── LISTA INFO DLA RODZICÓW ─────────────────────────────

    #[Route('/parent-info', name: 'app_generate_parent_info_index')]
    public function parentInfoIndex(GeneratedMaterialRepository $repo): Response
    {
        return $this->render('generator/parent_info_index.html.twig', [
            'materials' => $repo->findByTypeAndOwner($this->getUser(), 'parent_info'),
        ]);
    }

    #[Route('/parent-info/new', name: 'app_generate_parent_info')]
    public function parentInfo(Request $request): Response
    {
        $form = $this->createForm(GenerateParentInfoType::class);
        $form->handleRequest($request);

        if ($form->isSubmitted() && $form->isValid()) {
            $data = $form->getData();

            $builder = new ParentInfoPromptBuilder();
            $userPrompt = $builder->buildUserPrompt(
                infoType: $data['infoType'],
                details: $data['details'],
                tone: $data['tone'],
            );

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: ParentInfoPromptBuilder::SYSTEM_PROMPT,
                    module: 'parent_info_generator',
                    owner: $this->getUser(),
                );

                if (str_contains($result, '---WERSJA KRÓTKA---')) {
                    $parts = explode('---WERSJA KRÓTKA---', $result, 2);
                    $resultFull = trim($parts[0]);
                    $resultShort = trim($parts[1]);
                } else {
                    $resultFull = trim($result);
                    $resultShort = '';
                }

                $request->getSession()->set('last_parent_info', [
                    'full' => $resultFull,
                    'short' => $resultShort,
                    'infoType' => $data['infoType'],
                    'prompt' => $userPrompt,
                ]);
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_generate_parent_info');
        }

        $sessionData = $request->getSession()->get('last_parent_info');

        return $this->render('generator/parent_info.html.twig', [
            'form' => $form,
            'resultFull' => $sessionData['full'] ?? null,
            'resultShort' => $sessionData['short'] ?? null,
        ]);
    }

    #[Route('/parent-info/save', name: 'app_generate_parent_info_save', methods: ['POST'])]
    public function parentInfoSave(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_parent_info');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do zapisania.');
            return $this->redirectToRoute('app_generate_parent_info');
        }

        $material = new GeneratedMaterial();
        $material->setType('parent_info');
        $material->setTitle('Info — ' . $sessionData['infoType']);
        $material->setSubjectContext($sessionData['infoType']);
        $material->setPromptUsed($sessionData['prompt']);
        $material->setContent($sessionData['full'] . "\n\n---WERSJA KRÓTKA---\n\n" . $sessionData['short']);
        $material->setOwner($this->getUser());

        $this->em->persist($material);
        $this->em->flush();

        $this->addFlash('success', 'Informacja zapisana w historii.');

        return $this->redirectToRoute('app_generate_parent_info');
    }

    // ─── DELETE MATERIAL ────────────────────────────────────────

    #[Route('/material/{id}/delete', name: 'app_generate_material_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function deleteMaterial(GeneratedMaterial $material, Request $request): Response
    {
        if ($material->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $type = $material->getType();
        $this->em->remove($material);
        $this->em->flush();

        $this->addFlash('success', 'Materiał usunięty.');

        $routes = ['test' => 'app_generate_test_index', 'worksheet' => 'app_generate_worksheet_index', 'parent_info' => 'app_generate_parent_info_index'];
        return $this->redirectToRoute($routes[$type] ?? 'app_generate_history');
    }

    #[Route('/material/{id}/favorite', name: 'app_generate_material_favorite', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function toggleFavorite(GeneratedMaterial $material): Response
    {
        if ($material->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $material->setIsFavorite(!$material->isFavorite());
        $this->em->flush();

        return $this->redirectToRoute('app_generate_history_show', ['id' => $material->getId()]);
    }

    // ─── HISTORIA ──────────────────────────────────────────────

    #[Route('/history', name: 'app_generate_history')]
    public function history(): Response
    {
        $materials = $this->em->getRepository(GeneratedMaterial::class)->findBy(
            ['owner' => $this->getUser()],
            ['createdAt' => 'DESC'],
            50,
        );

        return $this->render('generator/history.html.twig', [
            'materials' => $materials,
        ]);
    }

    #[Route('/history/{id}', name: 'app_generate_history_show')]
    public function historyShow(GeneratedMaterial $material): Response
    {
        if ($material->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $testData = null;
        $wsData = null;
        if ($material->getType() === 'test') {
            $testData = TestPromptBuilder::parseResponse($material->getContent());
        } elseif ($material->getType() === 'worksheet') {
            $wsData = WorksheetPromptBuilder::parseResponse($material->getContent());
        }

        return $this->render('generator/history_show.html.twig', [
            'material' => $material,
            'testData' => $testData,
            'wsData' => $wsData,
        ]);
    }

    #[Route('/history/{id}/pdf', name: 'app_generate_history_pdf')]
    public function historyPdf(Request $request, GeneratedMaterial $material): Response
    {
        if ($material->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $includeAnswers = $request->query->getBoolean('answers', false);

        if ($material->getType() === 'test') {
            $testData = TestPromptBuilder::parseResponse($material->getContent());
            return $this->pdf->generateResponse(
                'pdf/test.html.twig',
                [
                    'testData' => $testData,
                    'testRaw' => $testData ? null : $material->getContent(),
                    'subject' => $material->getSubjectContext(),
                    'classLevel' => $material->getClassLevel(),
                    'includeAnswers' => $includeAnswers,
                    'materialId' => $material->getId(),
                ],
                'sprawdzian_' . date('Y-m-d_His') . '.pdf',
            );
        }

        if ($material->getType() === 'worksheet') {
            $wsData = WorksheetPromptBuilder::parseResponse($material->getContent());
            return $this->pdf->generateResponse(
                'pdf/worksheet.html.twig',
                [
                    'wsData' => $wsData,
                    'wsRaw' => $wsData ? null : $material->getContent(),
                    'topic' => $material->getSubjectContext(),
                    'classLevel' => $material->getClassLevel(),
                    'includeAnswers' => $includeAnswers,
                ],
                'karta_pracy_' . date('Y-m-d_His') . '.pdf',
            );
        }

        // Fallback — generic text PDF
        return $this->pdf->generateResponse(
            'pdf/worksheet.html.twig',
            [
                'content' => $material->getContent(),
                'topic' => $material->getTitle(),
                'classLevel' => $material->getClassLevel() ?? '',
            ],
            'material_' . date('Y-m-d_His') . '.pdf',
        );
    }
}
