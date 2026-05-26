<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\Newsletter;
use App\Entity\User;
use App\Repository\NewsletterRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\GazetkaArticlePromptBuilder;
use App\Service\PixabayClient;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/gazetka')]
class GazetkaController extends AbstractController
{
    /** Wymiary strony A5 w punktach (A4 złożone na pół). */
    private const PAGE_W = 420;
    private const PAGE_H = 595;

    private const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    private const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

    public function __construct(
        private readonly NewsletterRepository $repo,
        private readonly OpenRouterClient $ai,
        private readonly PixabayClient $pixabay,
    ) {}

    #[Route('', name: 'app_gazetka_index', methods: ['GET'])]
    public function index(): Response
    {
        return $this->render('gazetka/index.html.twig', [
            'newsletters' => $this->repo->findByOwner($this->currentUser()),
        ]);
    }

    #[Route('/new', name: 'app_gazetka_new', methods: ['POST'])]
    public function new(Request $request): Response
    {
        $title = trim((string) $request->request->get('title')) ?: 'Nowa gazetka';
        $pageCount = $request->request->getInt('pageCount', 4);

        // Zaokrąglij w górę do wielokrotności 4 (składka), w zakresie 4..40.
        $pageCount = max(4, min(40, (int) (ceil($pageCount / 4) * 4)));

        $newsletter = new Newsletter();
        $newsletter->setOwner($this->currentUser());
        $newsletter->setTitle(mb_substr($title, 0, 200));
        $newsletter->setPageCount($pageCount);
        $newsletter->setContent(json_encode($this->blankDocument($pageCount), JSON_UNESCAPED_UNICODE));

        $this->repo->save($newsletter);

        $allowedTemplates = ['cover', 'article2col', 'article1col', 'photopage', 'colophon'];
        $template = (string) $request->request->get('template');
        $params = ['id' => $newsletter->getId()];
        if (in_array($template, $allowedTemplates, true)) {
            $params['template'] = $template;
        }

        return $this->redirectToRoute('app_gazetka_edit', $params);
    }

    #[Route('/{id}/edit', name: 'app_gazetka_edit', methods: ['GET'])]
    public function edit(Newsletter $newsletter): Response
    {
        $this->denyUnlessOwner($newsletter);

        $doc = $newsletter->getContentArray();
        if (empty($doc['pages'])) {
            $doc = $this->blankDocument($newsletter->getPageCount());
        }

        return $this->render('gazetka/edit.html.twig', [
            'newsletter' => $newsletter,
            'doc' => json_encode($doc, JSON_UNESCAPED_UNICODE),
        ]);
    }

    #[Route('/{id}/save', name: 'app_gazetka_save', methods: ['POST'])]
    public function save(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload) || !isset($payload['doc']) || !is_array($payload['doc'])) {
            return new JsonResponse(['ok' => false, 'error' => 'Brak danych dokumentu.'], 400);
        }

        $doc = $payload['doc'];
        $pageCount = is_array($doc['pages'] ?? null) ? count($doc['pages']) : $newsletter->getPageCount();

        if (isset($payload['title'])) {
            $newsletter->setTitle(mb_substr(trim((string) $payload['title']) ?: 'Nowa gazetka', 0, 200));
        }
        $newsletter->setPageCount($pageCount);
        $newsletter->setContent(json_encode($doc, JSON_UNESCAPED_UNICODE));
        $newsletter->setUpdatedAt(new \DateTimeImmutable());

        $this->repo->save($newsletter);

        return new JsonResponse([
            'ok' => true,
            'savedAt' => $newsletter->getUpdatedAt()?->format('H:i:s'),
        ]);
    }

    #[Route('/{id}/upload', name: 'app_gazetka_upload', methods: ['POST'])]
    public function upload(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $file = $request->files->get('image');
        if (!$file) {
            return new JsonResponse(['ok' => false, 'error' => 'Nie przesłano pliku.'], 400);
        }

        if ($file->getSize() > self::MAX_UPLOAD_BYTES) {
            return new JsonResponse(['ok' => false, 'error' => 'Plik za duży (max 8 MB).'], 400);
        }

        $mime = $file->getMimeType() ?: '';
        if (!in_array($mime, self::ALLOWED_MIME, true)) {
            return new JsonResponse(['ok' => false, 'error' => 'Dozwolone formaty: JPG, PNG, WEBP, GIF.'], 400);
        }

        $ext = match ($mime) {
            'image/jpeg' => 'jpg',
            'image/png' => 'png',
            'image/webp' => 'webp',
            'image/gif' => 'gif',
            default => 'img',
        };

        try {
            [$absDir, $relDir] = $this->ownerUploadDir();
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 500);
        }

        $name = bin2hex(random_bytes(8)) . '.' . $ext;
        try {
            $file->move($absDir, $name);
        } catch (\Throwable $e) {
            return new JsonResponse(['ok' => false, 'error' => 'Błąd zapisu pliku.'], 500);
        }

        $url = $relDir . '/' . $name;
        [$w, $h] = @getimagesize($absDir . '/' . $name) ?: [0, 0];

        return new JsonResponse(['ok' => true, 'url' => $url, 'width' => $w, 'height' => $h]);
    }

    #[Route('/{id}/delete', name: 'app_gazetka_delete', methods: ['POST'])]
    public function delete(Newsletter $newsletter, Request $request): Response
    {
        $this->denyUnlessOwner($newsletter);

        if ($this->isCsrfTokenValid('gazetka_delete_' . $newsletter->getId(), (string) $request->request->get('_token'))) {
            $this->repo->remove($newsletter);
            $this->addFlash('success', 'Gazetka została usunięta.');
        }

        return $this->redirectToRoute('app_gazetka_index');
    }

    #[Route('/{id}/ai-text', name: 'app_gazetka_ai_text', methods: ['POST'])]
    public function aiText(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        $topic = trim((string) ($p['topic'] ?? ''));
        if ($topic === '') {
            return new JsonResponse(['ok' => false, 'error' => 'Podaj temat artykułu.'], 400);
        }

        $builder = new GazetkaArticlePromptBuilder();
        $userPrompt = $builder->buildUserPrompt(
            (string) ($p['type'] ?? 'artykul'),
            $topic,
            trim((string) ($p['details'] ?? '')),
            (string) ($p['length'] ?? 'medium'),
            (string) ($p['tone'] ?? 'lekki'),
        );

        try {
            $result = $this->ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: GazetkaArticlePromptBuilder::SYSTEM_PROMPT,
                module: 'gazetka_article',
                maxTokens: 2500,
                owner: $this->currentUser(),
            );
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }

        $parsed = GazetkaArticlePromptBuilder::parseResponse($result)
            ?? ['title' => '', 'lead' => '', 'body' => trim($result)];

        return new JsonResponse(['ok' => true] + $parsed);
    }

    #[Route('/{id}/ai-image', name: 'app_gazetka_ai_image', methods: ['POST'])]
    public function aiImage(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        $prompt = trim((string) ($p['prompt'] ?? ''));
        $style = trim((string) ($p['style'] ?? ''));
        $ref = trim((string) ($p['ref'] ?? ''));

        if ($prompt === '' && $ref === '') {
            return new JsonResponse(['ok' => false, 'error' => 'Opisz, co ma przedstawiać obraz.'], 400);
        }

        // Grafika wzorcowa (np. winietka) → generowanie w jej stylu/kolorystyce.
        $refUris = [];
        if ($ref !== '') {
            $uri = $this->refImageDataUri($ref);
            if ($uri === null) {
                return new JsonResponse(['ok' => false, 'error' => 'Nie udało się wczytać grafiki wzorcowej.'], 400);
            }
            $refUris[] = $uri;
        }

        if ($ref !== '') {
            $fullPrompt = 'W załączeniu grafika wzorcowa — winietka/nagłówek tej gazetki. '
                . 'Stwórz NOWĄ, mniejszą grafikę (mini-winietkę / ikonę działu) w dokładnie tym samym stylu graficznym, '
                . 'tej samej kolorystyce oraz z tym samym charakterem kresek, kształtów i klimatem co grafika wzorcowa. '
                . ($prompt !== '' ? 'Motyw / nazwa działu: ' . $prompt . '. ' : '')
                . 'Prosty, czytelny, wyrazisty motyw, wyśrodkowany, na jednolitym jasnym lub przezroczystym tle. Bez żadnego tekstu i napisów.';
        } else {
            $fullPrompt = $prompt
                . ($style !== '' ? ' Styl: ' . $style . '.' : '')
                . ' Ilustracja do szkolnej gazetki. Bez żadnych napisów ani tekstu na obrazie.';
        }

        try {
            $dataUri = $this->ai->generateImage($fullPrompt, owner: $this->currentUser(), referenceImages: $refUris);
            [$url, $w, $h] = $this->storeDataUriImage($dataUri);
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }

        return new JsonResponse(['ok' => true, 'url' => $url, 'width' => $w, 'height' => $h]);
    }

    #[Route('/{id}/stock-search', name: 'app_gazetka_stock_search', methods: ['GET'])]
    public function stockSearch(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        $q = trim((string) $request->query->get('q'));
        if ($q === '') {
            return new JsonResponse(['ok' => false, 'error' => 'Wpisz, czego szukasz.'], 400);
        }

        try {
            $r = $this->pixabay->search(
                $q,
                (string) $request->query->get('type', 'illustration'),
                $request->query->getInt('page', 1),
            );
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }

        return new JsonResponse(['ok' => true, 'query' => $r['query'], 'results' => $r['results']]);
    }

    #[Route('/{id}/stock-import', name: 'app_gazetka_stock_import', methods: ['POST'])]
    public function stockImport(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $url = trim((string) (json_decode($request->getContent(), true)['url'] ?? ''));
        if ($url === '') {
            return new JsonResponse(['ok' => false, 'error' => 'Brak adresu grafiki.'], 400);
        }

        try {
            $bytes = $this->pixabay->download($url);
            $info = @getimagesizefromstring($bytes);
            if (!$info) {
                throw new \RuntimeException('Pobrany plik nie jest obrazem.');
            }
            $ext = match ($info[2]) {
                IMAGETYPE_PNG => 'png',
                IMAGETYPE_JPEG => 'jpg',
                IMAGETYPE_GIF => 'gif',
                IMAGETYPE_WEBP => 'webp',
                default => 'png',
            };

            [$absDir, $relDir] = $this->ownerUploadDir();
            $name = 'px_' . bin2hex(random_bytes(6)) . '.' . $ext;
            if (@file_put_contents($absDir . '/' . $name, $bytes) === false) {
                throw new \RuntimeException('Nie udało się zapisać grafiki.');
            }

            return new JsonResponse(['ok' => true, 'url' => $relDir . '/' . $name, 'width' => $info[0], 'height' => $info[1]]);
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }
    }

    #[Route('/{id}/media', name: 'app_gazetka_media_list', methods: ['GET'])]
    public function mediaList(Newsletter $newsletter): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        try {
            [$absDir, $relDir] = $this->ownerUploadDir();
        } catch (\RuntimeException) {
            return new JsonResponse(['ok' => true, 'items' => []]);
        }

        $items = [];
        foreach (glob($absDir . '/*') ?: [] as $path) {
            if (!is_file($path)) {
                continue;
            }
            $info = @getimagesize($path);
            if (!$info) {
                continue; // tylko prawidłowe obrazy
            }
            $name = basename($path);
            // Pochodzenie po prefiksie nazwy (patrz storeDataUriImage / stockImport / upload).
            $kind = str_starts_with($name, 'ai_') ? 'ai'
                : (str_starts_with($name, 'px_') ? 'stock' : 'upload');

            $items[] = [
                'url' => $relDir . '/' . $name,
                'name' => $name,
                'kind' => $kind,
                'width' => $info[0],
                'height' => $info[1],
                'size' => @filesize($path) ?: 0,
                'mtime' => @filemtime($path) ?: 0,
            ];
        }
        // Najnowsze na górze.
        usort($items, static fn (array $a, array $b): int => $b['mtime'] <=> $a['mtime']);

        return new JsonResponse(['ok' => true, 'items' => $items]);
    }

    #[Route('/{id}/media-delete', name: 'app_gazetka_media_delete', methods: ['POST'])]
    public function mediaDelete(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $url = trim((string) (json_decode($request->getContent(), true)['url'] ?? ''));
        $abs = $url !== '' ? $this->ownedUploadAbsPath($url) : null;
        if ($abs === null) {
            return new JsonResponse(['ok' => false, 'error' => 'Nie znaleziono grafiki.'], 400);
        }

        if (!@unlink($abs)) {
            return new JsonResponse(['ok' => false, 'error' => 'Nie udało się usunąć pliku.'], 500);
        }

        return new JsonResponse(['ok' => true]);
    }

    /**
     * Katalog uploadów bieżącego użytkownika (tworzy go w razie potrzeby).
     *
     * @return array{0:string,1:string} [absDir, relDir]
     */
    private function ownerUploadDir(): array
    {
        $relDir = '/uploads/gazetka/' . $this->currentUser()->getId();
        $absDir = $this->getParameter('kernel.project_dir') . '/public' . $relDir;
        if (!is_dir($absDir) && !@mkdir($absDir, 0775, true) && !is_dir($absDir)) {
            throw new \RuntimeException('Nie można utworzyć katalogu uploadów.');
        }

        return [$absDir, $relDir];
    }

    /**
     * Zamienia URL grafiki na bezwzględną ścieżkę pliku TYLKO jeśli wskazuje na własny upload
     * bieżącego użytkownika. Zwraca null w każdym innym przypadku.
     * Twarda ochrona przed path-traversal i sięganiem do cudzych/obcych plików (IDOR).
     */
    private function ownedUploadAbsPath(string $url): ?string
    {
        [$absDir, $relDir] = $this->ownerUploadDir();
        // Tylko pojedynczy segment nazwy pliku w katalogu tego użytkownika (bez „/", więc bez wyjścia z katalogu).
        if (!preg_match('#^' . preg_quote($relDir, '#') . '/([A-Za-z0-9._-]+)$#', $url, $m)) {
            return null;
        }

        $abs = realpath($absDir . '/' . $m[1]);
        $base = realpath($absDir);
        if ($abs === false || $base === false || !str_starts_with($abs, $base . \DIRECTORY_SEPARATOR)) {
            return null;
        }

        return $abs;
    }

    /**
     * Zamienia URL grafiki wzorcowej (z uploadów BIEŻĄCEGO użytkownika lub data URI) na data URI base64
     * do wysłania jako wzór do AI. Zwraca null, gdy URL nie wskazuje na własny, prawidłowy plik graficzny.
     */
    private function refImageDataUri(string $url): ?string
    {
        if (str_starts_with($url, 'data:image/')) {
            return $url;
        }

        $abs = $this->ownedUploadAbsPath($url);
        if ($abs === null) {
            return null;
        }

        $bytes = @file_get_contents($abs);
        if ($bytes === false || $bytes === '') {
            return null;
        }
        $info = @getimagesizefromstring($bytes);
        if (!$info) {
            return null;
        }

        return 'data:' . image_type_to_mime_type($info[2]) . ';base64,' . base64_encode($bytes);
    }

    /**
     * Zapisuje obraz z data URI do katalogu uploadów.
     *
     * @return array{0:string,1:int,2:int} [url, width, height]
     */
    private function storeDataUriImage(string $dataUri): array
    {
        if (preg_match('#^data:image/(png|jpeg|jpg|webp);base64,#i', $dataUri, $m)) {
            $ext = strtolower($m[1]) === 'jpeg' ? 'jpg' : strtolower($m[1]);
            $raw = base64_decode(substr($dataUri, (int) strpos($dataUri, ',') + 1), true);
        } else {
            // Brak/nietypowy prefiks — spróbuj zdekodować część po przecinku jako PNG.
            $ext = 'png';
            $raw = base64_decode((string) preg_replace('#^data:[^,]*,#', '', $dataUri), true);
        }

        if ($raw === false || $raw === '') {
            throw new \RuntimeException('Nie udało się zdekodować wygenerowanego obrazu.');
        }

        [$absDir, $relDir] = $this->ownerUploadDir();
        $name = 'ai_' . bin2hex(random_bytes(6)) . '.' . $ext;
        if (@file_put_contents($absDir . '/' . $name, $raw) === false) {
            throw new \RuntimeException('Nie udało się zapisać wygenerowanego obrazu.');
        }

        [$w, $h] = @getimagesizefromstring($raw) ?: [0, 0];

        return [$relDir . '/' . $name, (int) $w, (int) $h];
    }

    /**
     * Pusty dokument: N stron A5 z białym tłem.
     *
     * @return array<string, mixed>
     */
    private function blankDocument(int $pageCount): array
    {
        $pages = [];
        for ($i = 0; $i < $pageCount; $i++) {
            $pages[] = ['background' => '#ffffff', 'elements' => []];
        }

        return [
            'version' => 1,
            'pageW' => self::PAGE_W,
            'pageH' => self::PAGE_H,
            'pages' => $pages,
        ];
    }

    private function currentUser(): User
    {
        /** @var User $user */
        $user = $this->getUser();

        return $user;
    }

    private function denyUnlessOwner(Newsletter $newsletter): void
    {
        if ($newsletter->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException('To nie jest Twoja gazetka.');
        }
    }
}
