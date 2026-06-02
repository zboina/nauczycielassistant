<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\GazetkaBlock;
use App\Entity\GazetkaPageTemplate;
use App\Entity\Newsletter;
use App\Entity\User;
use App\Repository\GazetkaBlockRepository;
use App\Repository\GazetkaPageTemplateRepository;
use App\Repository\NewsletterRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\GazetkaArticlePromptBuilder;
use App\Service\AI\PromptBuilder\GazetkaRedactPromptBuilder;
use App\Service\PixabayClient;
use App\Service\UnsplashClient;
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

    /** Wymiary strony A4 w punktach (np. plakat — pojedyncza strona). */
    private const PAGE_A4_W = 595;
    private const PAGE_A4_H = 842;

    private const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    private const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

    public function __construct(
        private readonly NewsletterRepository $repo,
        private readonly OpenRouterClient $ai,
        private readonly PixabayClient $pixabay,
        private readonly UnsplashClient $unsplash,
    ) {}

    #[Route('', name: 'app_gazetka_index', methods: ['GET'])]
    public function index(): Response
    {
        $newsletters = $this->repo->findByOwner($this->currentUser());
        $previews = [];
        foreach ($newsletters as $n) {
            $previews[$n->getId()] = $this->buildPreview($n);
        }

        return $this->render('gazetka/index.html.twig', [
            'newsletters' => $newsletters,
            'previews' => $previews,
        ]);
    }

    /**
     * Buduje LEKKI JSON podglądu pierwszej strony — bez ciężkich data URI (te są zastępowane
     * placeholderem). URL-e uploadów zachowujemy. Renderer JS na liście używa tego do canvas.
     *
     * @return array<string,mixed>
     */
    private function buildPreview(Newsletter $n): array
    {
        $doc = $n->getContentArray();
        $pageW = (int) ($doc['pageW'] ?? self::PAGE_W);
        $pageH = (int) ($doc['pageH'] ?? self::PAGE_H);
        $page = $doc['pages'][0] ?? ['background' => '#ffffff', 'elements' => []];
        $out = [
            'pageW'      => $pageW,
            'pageH'      => $pageH,
            'background' => $page['background'] ?? '#ffffff',
            'elements'   => [],
        ];
        // Obraz/ikona: zostaje, jeśli to URL uploadu albo MAŁE data URI (ikony SVG do ~4 KB).
        // Większe data URI (zdjęcia) zastępujemy placeholderem — to lista, nie edytor.
        $keepSrc = static function (string $src): ?string {
            if ($src === '') {
                return null;
            }
            if (!str_starts_with($src, 'data:')) {
                return $src;
            }
            if (str_starts_with($src, 'data:image/svg+xml') && strlen($src) < 8000) {
                return $src;
            }

            return null; // duże data URI → placeholder
        };
        foreach (($page['elements'] ?? []) as $el) {
            $t = $el['type'] ?? '';
            $base = [
                't' => $t,
                'x' => $el['x'] ?? 0, 'y' => $el['y'] ?? 0,
                'w' => $el['width'] ?? 0, 'h' => $el['height'] ?? 0,
                'r' => $el['rotation'] ?? 0,
                'o' => $el['opacity'] ?? 1,
            ];
            if ($t === 'rect') {
                $base['fill'] = $el['fill'] ?? null;
                $base['stroke'] = $el['stroke'] ?? null;
                $base['sw'] = $el['strokeWidth'] ?? 0;
                $base['cr'] = $el['cornerRadius'] ?? 0;
            } elseif ($t === 'line') {
                $base['stroke'] = $el['stroke'] ?? '#000';
                $base['sw'] = $el['strokeWidth'] ?? 1;
            } elseif ($t === 'text') {
                $base['text'] = mb_substr((string) ($el['text'] ?? ''), 0, 160);
                $base['ff'] = $el['fontFamily'] ?? 'Arial';
                $base['fs'] = $el['fontSize'] ?? 12;
                $base['fst'] = $el['fontStyle'] ?? 'normal';
                $base['fill'] = $el['fill'] ?? '#1a2330';
                $base['align'] = $el['align'] ?? 'left';
                $base['lh'] = $el['lineHeight'] ?? 1.3;
            } elseif ($t === 'image' || $t === 'icon') {
                $src = $keepSrc((string) ($el['src'] ?? ''));
                if ($src !== null) {
                    $base['src'] = $src;
                }
            } else {
                continue;
            }
            $out['elements'][] = $base;
        }

        return $out;
    }

    #[Route('/new', name: 'app_gazetka_new', methods: ['POST'])]
    public function new(Request $request): Response
    {
        $title = trim((string) $request->request->get('title')) ?: 'Nowa gazetka';
        $format = $request->request->get('format') === 'a4' ? 'a4' : 'a5';

        if ($format === 'a4') {
            // Plakat / pojedyncza strona A4 — składasz ręcznie (tło + grafiki z biblioteki + teksty).
            $pageW = self::PAGE_A4_W;
            $pageH = self::PAGE_A4_H;
            $pageCount = 1;
        } else {
            // Gazetka A5: zaokrąglij liczbę stron w górę do wielokrotności 4 (składka), 4..40.
            $pageW = self::PAGE_W;
            $pageH = self::PAGE_H;
            $pageCount = max(4, min(40, (int) (ceil($request->request->getInt('pageCount', 4) / 4) * 4)));
        }

        $newsletter = new Newsletter();
        $newsletter->setOwner($this->currentUser());
        $newsletter->setTitle(mb_substr($title, 0, 200));
        $newsletter->setPageCount($pageCount);
        $newsletter->setContent(json_encode($this->blankDocument($pageCount, $pageW, $pageH), JSON_UNESCAPED_UNICODE));

        $this->repo->save($newsletter);

        $params = ['id' => $newsletter->getId()];
        // Szablony startowe są zaprojektowane pod A5 — dla A4 zaczynamy od pustej strony.
        if ($format !== 'a4') {
            $allowedTemplates = ['cover', 'article2col', 'article1col', 'photopage', 'colophon'];
            $template = (string) $request->request->get('template');
            if (in_array($template, $allowedTemplates, true)) {
                $params['template'] = $template;
            }
        }

        return $this->redirectToRoute('app_gazetka_edit', $params);
    }

    /**
     * Tworzy pustą gazetkę pod import projektu z pliku i zwraca URL-e (upload/save/edit).
     * Reszta importu (wgranie grafik po jednej + zapis dokumentu) dzieje się po stronie przeglądarki —
     * żeby ominąć limit post_max_size przy dużych paczkach.
     */
    #[Route('/import-create', name: 'app_gazetka_import_create', methods: ['POST'])]
    public function importCreate(Request $request): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        $title = trim((string) ($p['title'] ?? '')) ?: 'Gazetka (import)';
        $pageCount = max(4, min(40, (int) (ceil(((int) ($p['pageCount'] ?? 4)) / 4) * 4)));

        $newsletter = new Newsletter();
        $newsletter->setOwner($this->currentUser());
        $newsletter->setTitle(mb_substr($title, 0, 200));
        $newsletter->setPageCount($pageCount);
        $newsletter->setContent(json_encode($this->blankDocument($pageCount), JSON_UNESCAPED_UNICODE));
        $this->repo->save($newsletter);

        $id = $newsletter->getId();

        return new JsonResponse([
            'ok' => true,
            'id' => $id,
            'uploadUrl' => $this->generateUrl('app_gazetka_upload', ['id' => $id]),
            'saveUrl' => $this->generateUrl('app_gazetka_save', ['id' => $id]),
            'editUrl' => $this->generateUrl('app_gazetka_edit', ['id' => $id]),
        ]);
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

    /**
     * Redaguje z pomocą AI zaznaczony w ramce fragment tekstu (przeredaguj / skróć / rozwiń /
     * popraw język / uprość / oficjalny ton / własne polecenie). Zwraca SAM zredagowany tekst.
     */
    #[Route('/{id}/ai-redact', name: 'app_gazetka_ai_redact', methods: ['POST'])]
    public function aiRedact(Newsletter $newsletter, Request $request): JsonResponse
    {
        $this->denyUnlessOwner($newsletter);

        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        $fragment = trim((string) ($p['text'] ?? ''));
        if ($fragment === '') {
            return new JsonResponse(['ok' => false, 'error' => 'Zaznacz fragment tekstu do zredagowania.'], 400);
        }
        if (mb_strlen($fragment) > 4000) {
            return new JsonResponse(['ok' => false, 'error' => 'Zaznaczony fragment jest zbyt długi (max 4000 znaków).'], 400);
        }

        $allowed = ['rephrase', 'shorten', 'expand', 'fix', 'simplify', 'formal', 'custom'];
        $action = in_array($p['action'] ?? '', $allowed, true) ? (string) $p['action'] : 'rephrase';
        $instruction = mb_substr(trim((string) ($p['instruction'] ?? '')), 0, 400);
        $context = mb_substr(trim((string) ($p['context'] ?? '')), 0, 4000);

        $builder = new GazetkaRedactPromptBuilder();
        $userPrompt = $builder->buildUserPrompt($action, $instruction, $fragment, $context);

        // Limit odpowiedzi proporcjonalny do długości fragmentu (z zapasem na rozwinięcie).
        $maxTokens = max(256, min(3000, (int) (mb_strlen($fragment) / 2) + 400));
        if ($action === 'expand') {
            $maxTokens = (int) min(3000, $maxTokens * 2);
        }

        try {
            $result = $this->ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: GazetkaRedactPromptBuilder::SYSTEM_PROMPT,
                module: 'gazetka_redact',
                maxTokens: $maxTokens,
                owner: $this->currentUser(),
            );
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }

        $text = $this->cleanRedactedText($result);
        if ($text === '') {
            return new JsonResponse(['ok' => false, 'error' => 'AI nie zwróciło tekstu.'], 502);
        }

        return new JsonResponse(['ok' => true, 'text' => $text]);
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

        $source = $request->query->get('source', 'pixabay');
        try {
            if ($source === 'unsplash') {
                $r = $this->unsplash->search(
                    $q,
                    (string) $request->query->get('orientation', 'all'),
                    $request->query->getInt('page', 1),
                );
            } else {
                $r = $this->pixabay->search(
                    $q,
                    (string) $request->query->get('type', 'illustration'),
                    $request->query->getInt('page', 1),
                );
            }
        } catch (\RuntimeException $e) {
            return new JsonResponse(['ok' => false, 'error' => $e->getMessage()], 502);
        }

        return new JsonResponse(['ok' => true, 'query' => $r['query'], 'results' => $r['results'], 'source' => $source]);
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
            // Wybór klienta po hostname URL — automatycznie ten sam, którym wyszukiwano.
            $host = (string) (parse_url($url, PHP_URL_HOST) ?: '');
            $isUnsplash = str_ends_with($host, '.unsplash.com');
            $bytes = $isUnsplash ? $this->unsplash->download($url) : $this->pixabay->download($url);
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
            // Prefix nazwy: us_ dla Unsplash, px_ dla Pixabay — by „Magazyn mediów" rozpoznał źródło.
            $prefix = $isUnsplash ? 'us_' : 'px_';
            $name = $prefix . bin2hex(random_bytes(6)) . '.' . $ext;
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
                : (str_starts_with($name, 'px_') ? 'stock'
                : (str_starts_with($name, 'us_') ? 'stock' : 'upload'));

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

    // ─── Magazyn bloków (zapisane, zgrupowane zestawy elementów — per użytkownik) ───

    #[Route('/blocks', name: 'app_gazetka_blocks_list', methods: ['GET'])]
    public function blocksList(GazetkaBlockRepository $blocks): JsonResponse
    {
        $items = array_map(static fn (GazetkaBlock $b): array => [
            'id' => $b->getId(),
            'name' => $b->getName(),
            'w' => $b->getWidth(),
            'h' => $b->getHeight(),
            'count' => $b->getElementCount(),
            'preview' => $b->getPreview(),
            'els' => $b->getData(),
        ], $blocks->findByOwner($this->currentUser()));

        return new JsonResponse(['ok' => true, 'items' => $items]);
    }

    #[Route('/blocks', name: 'app_gazetka_blocks_create', methods: ['POST'])]
    public function blocksCreate(Request $request, GazetkaBlockRepository $blocks): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        if (!is_array($p)) {
            return new JsonResponse(['ok' => false, 'error' => 'Brak danych.'], 400);
        }

        $els = $p['els'] ?? null;
        if (!is_array($els) || count($els) < 1) {
            return new JsonResponse(['ok' => false, 'error' => 'Pusty blok.'], 400);
        }
        if (count($els) > 200 || strlen(json_encode($els)) > 500_000) {
            return new JsonResponse(['ok' => false, 'error' => 'Blok jest zbyt duży.'], 400);
        }
        if ($blocks->countByOwner($this->currentUser()) >= 300) {
            return new JsonResponse(['ok' => false, 'error' => 'Osiągnięto limit zapisanych bloków (300).'], 400);
        }

        // Miniatura — tylko mały data URI PNG/JPEG.
        $preview = is_string($p['preview'] ?? null) ? $p['preview'] : null;
        if ($preview !== null && (!preg_match('#^data:image/(png|jpeg);base64,#', $preview) || strlen($preview) > 600_000)) {
            $preview = null;
        }

        $block = new GazetkaBlock();
        $block->setOwner($this->currentUser());
        $block->setName(mb_substr(trim((string) ($p['name'] ?? '')) ?: 'Blok', 0, 120));
        $block->setWidth(max(1, min(5000, (int) ($p['w'] ?? 0))));
        $block->setHeight(max(1, min(5000, (int) ($p['h'] ?? 0))));
        $block->setElementCount(count($els));
        $block->setPreview($preview);
        $block->setData(array_values($els));
        $blocks->save($block);

        return new JsonResponse(['ok' => true, 'id' => $block->getId()]);
    }

    #[Route('/blocks/{block}/delete', name: 'app_gazetka_blocks_delete', methods: ['POST'])]
    public function blocksDelete(GazetkaBlock $block, Request $request, GazetkaBlockRepository $blocks): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }
        if ($block->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException('To nie jest Twój blok.');
        }

        $blocks->remove($block);

        return new JsonResponse(['ok' => true]);
    }

    // ─── Szablony stron (zapis CAŁEJ strony do biblioteki użytkownika) ───

    #[Route('/page-templates', name: 'app_gazetka_page_templates_list', methods: ['GET'])]
    public function pageTemplatesList(GazetkaPageTemplateRepository $tpls): JsonResponse
    {
        $items = array_map(static fn (GazetkaPageTemplate $t): array => [
            'id'         => $t->getId(),
            'name'       => $t->getName(),
            'category'   => $t->getCategory(),
            'pageW'      => $t->getPageWidth(),
            'pageH'      => $t->getPageHeight(),
            'background' => $t->getBackground(),
            'count'      => $t->getElementCount(),
            'preview'    => $t->getPreview(),
            'elements'   => $t->getElements(),
            'createdAt'  => $t->getCreatedAt()->format(\DateTimeInterface::ATOM),
        ], $tpls->findByOwner($this->currentUser()));

        return new JsonResponse(['ok' => true, 'items' => $items]);
    }

    #[Route('/page-templates', name: 'app_gazetka_page_templates_create', methods: ['POST'])]
    public function pageTemplatesCreate(Request $request, GazetkaPageTemplateRepository $tpls): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }

        $p = json_decode($request->getContent(), true);
        if (!is_array($p)) {
            return new JsonResponse(['ok' => false, 'error' => 'Brak danych.'], 400);
        }

        $els = $p['elements'] ?? null;
        if (!is_array($els)) {
            return new JsonResponse(['ok' => false, 'error' => 'Brak elementów.'], 400);
        }
        if (count($els) > 400 || strlen(json_encode($els)) > 6_000_000) {
            return new JsonResponse(['ok' => false, 'error' => 'Szablon jest zbyt duży (limit elementów lub objętości).'], 400);
        }
        if ($tpls->countByOwner($this->currentUser()) >= 200) {
            return new JsonResponse(['ok' => false, 'error' => 'Osiągnięto limit zapisanych szablonów (200).'], 400);
        }

        $preview = is_string($p['preview'] ?? null) ? $p['preview'] : null;
        if ($preview !== null && (!preg_match('#^data:image/(png|jpeg);base64,#', $preview) || strlen($preview) > 800_000)) {
            $preview = null;
        }

        $bg = is_string($p['background'] ?? null) && preg_match('/^#[0-9a-fA-F]{3,8}$/', (string) $p['background']) ? (string) $p['background'] : null;

        $tpl = new GazetkaPageTemplate();
        $tpl->setOwner($this->currentUser());
        $tpl->setName(mb_substr(trim((string) ($p['name'] ?? '')) ?: 'Szablon strony', 0, 120));
        $tpl->setCategory($this->normalizeCategory($p['category'] ?? null));
        $tpl->setPageWidth(max(1, min(5000, (int) ($p['pageW'] ?? 0))));
        $tpl->setPageHeight(max(1, min(5000, (int) ($p['pageH'] ?? 0))));
        $tpl->setBackground($bg);
        $tpl->setElementCount(count($els));
        $tpl->setPreview($preview);
        $tpl->setElements(array_values($els));
        $tpls->save($tpl);

        return new JsonResponse(['ok' => true, 'id' => $tpl->getId(), 'category' => $tpl->getCategory()]);
    }

    #[Route('/page-templates/{tpl}/update', name: 'app_gazetka_page_templates_update', methods: ['POST'])]
    public function pageTemplatesUpdate(GazetkaPageTemplate $tpl, Request $request, GazetkaPageTemplateRepository $tpls): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }
        if ($tpl->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException('To nie jest Twój szablon.');
        }

        $p = json_decode($request->getContent(), true);
        if (!is_array($p)) {
            return new JsonResponse(['ok' => false, 'error' => 'Brak danych.'], 400);
        }
        if (array_key_exists('name', $p)) {
            $name = mb_substr(trim((string) $p['name']) ?: $tpl->getName(), 0, 120);
            $tpl->setName($name);
        }
        if (array_key_exists('category', $p)) {
            $tpl->setCategory($this->normalizeCategory($p['category']));
        }
        $tpls->save($tpl);

        return new JsonResponse(['ok' => true, 'name' => $tpl->getName(), 'category' => $tpl->getCategory()]);
    }

    /** Normalizuje kategorię: trim + max 60 znaków; pusty/null → null („Inne"). */
    private function normalizeCategory(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $v = trim($raw);

        return $v === '' ? null : mb_substr($v, 0, 60);
    }

    #[Route('/page-templates/{tpl}/delete', name: 'app_gazetka_page_templates_delete', methods: ['POST'])]
    public function pageTemplatesDelete(GazetkaPageTemplate $tpl, Request $request, GazetkaPageTemplateRepository $tpls): JsonResponse
    {
        if (!$this->isCsrfTokenValid('gazetka', (string) $request->headers->get('X-CSRF-Token'))) {
            return new JsonResponse(['ok' => false, 'error' => 'Nieprawidłowy token CSRF.'], 419);
        }
        if ($tpl->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException('To nie jest Twój szablon.');
        }

        $tpls->remove($tpl);

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
     * Sprząta odpowiedź AI dla redagowania fragmentu: zdejmuje ewentualne ```fences```
     * oraz pojedynczą parę otaczających cudzysłowów, którą model mógł dodać mimo zakazu.
     */
    private function cleanRedactedText(string $s): string
    {
        $s = trim($s);
        $s = (string) preg_replace('/^```[a-z]*\s*/i', '', $s);
        $s = (string) preg_replace('/\s*```$/', '', $s);
        $s = trim($s);

        if (mb_strlen($s) >= 2) {
            $pairs = ['"' => '"', '„' => '”', '«' => '»', '»' => '«', '”' => '„'];
            $first = mb_substr($s, 0, 1);
            if (isset($pairs[$first]) && mb_substr($s, -1) === $pairs[$first]) {
                $s = trim(mb_substr($s, 1, mb_strlen($s) - 2));
            }
        }

        return $s;
    }

    /**
     * Pusty dokument: N stron A5 z białym tłem.
     *
     * @return array<string, mixed>
     */
    private function blankDocument(int $pageCount, int $pageW = self::PAGE_W, int $pageH = self::PAGE_H): array
    {
        $pages = [];
        for ($i = 0; $i < $pageCount; $i++) {
            $pages[] = ['background' => '#ffffff', 'elements' => []];
        }

        return [
            'version' => 1,
            'pageW' => $pageW,
            'pageH' => $pageH,
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
