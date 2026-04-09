<?php

declare(strict_types=1);

namespace App\Controller;

use App\Service\AI\OpenRouterClient;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/chat')]
class ChatController extends AbstractController
{
    private const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś pomocnym asystentem AI dla nauczyciela języka polskiego w szkole podstawowej (klasy 4-8).
Odpowiadasz po polsku, konkretnie i merytorycznie.
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

Możesz:
- Odpowiadać na pytania z zakresu języka polskiego, literatury, dydaktyki
- Pomagać w planowaniu lekcji, formułowaniu celów, kryteriów oceniania
- Wyjaśniać zagadnienia gramatyczne, literackie, stylistyczne
- Podpowiadać metody pracy z uczniami
- Generować przykłady, ćwiczenia, pomysły na lekcje
- Analizować treść stron internetowych (gdy użytkownik wklei URL, system automatycznie pobiera treść strony)

ANALIZA STRON INTERNETOWYCH:
Gdy w wiadomości pojawi się URL, system automatycznie pobierze treść tej strony i dołączy ją do kontekstu.
Treść pojawi się w sekcji [TREŚĆ STRONY: url]. Przeanalizuj ją i odpowiedz na pytanie nauczyciela.
Możesz: streszczać artykuły, analizować zadania, wyciągać informacje, oceniać materiały dydaktyczne.

GENEROWANIE OBRAZKÓW:
Gdy użytkownik prosi o obrazek, ilustrację, grafikę, schemat, plakat lub wizualizację:
1. Odpowiedz krótkim tekstem opisującym co wygenerujesz
2. Dodaj na KOŃCU odpowiedzi specjalny tag:
   [IMAGE: opis obrazka po angielsku, szczegółowy, educational style]

Przykłady:
- "Zrób plakat o środkach stylistycznych" → odpowiedź + [IMAGE: educational poster about literary devices in Polish language, colorful infographic style, epithets metaphors personification with examples]
- "Pokaż schemat rozprawki" → odpowiedź + [IMAGE: diagram showing structure of argumentative essay in Polish, introduction thesis arguments conclusion, clean educational infographic]
- "Narysuj mapę myśli o Hobbicie" → odpowiedź + [IMAGE: mind map about The Hobbit by Tolkien, characters Bilbo Gandalf Smaug, themes journey courage friendship, colorful educational diagram]

Dodawaj [IMAGE: ...] TYLKO gdy użytkownik wyraźnie prosi o obraz/grafikę/plakat/schemat/ilustrację.
Opis w tagu IMAGE pisz ZAWSZE po angielsku (lepsze wyniki generatora).
PROMPT;

    public function __construct(
        private readonly OpenRouterClient $ai,
        private readonly HttpClientInterface $httpClient,
    ) {}

    #[Route('', name: 'app_chat')]
    public function index(Request $request): Response
    {
        // Init chat history in session
        if (!$request->getSession()->has('chat_history')) {
            $request->getSession()->set('chat_history', []);
        }

        return $this->render('chat/index.html.twig');
    }

    #[Route('/send', name: 'app_chat_send', methods: ['POST'])]
    public function send(Request $request): JsonResponse
    {
        $message = trim($request->request->get('message', ''));
        if ($message === '') {
            return $this->json(['error' => 'Pusty komunikat'], 400);
        }

        $session = $request->getSession();
        $history = $session->get('chat_history', []);

        // Detect URLs and fetch page content
        $webContext = '';
        if (preg_match_all('/(https?:\/\/[^\s]+)/', $message, $urlMatches)) {
            foreach ($urlMatches[1] as $url) {
                $pageContent = $this->fetchPageContent($url);
                if ($pageContent) {
                    $webContext .= "\n\n[TREŚĆ STRONY: {$url}]\n{$pageContent}\n[KONIEC TREŚCI STRONY]\n";
                }
            }
        }

        // Build messages for AI (last 10 messages for context)
        $aiMessages = array_slice($history, -10);
        $aiMessages[] = ['role' => 'user', 'content' => $message];

        // Build prompt with history
        $contextPrompt = '';
        foreach ($aiMessages as $msg) {
            $role = $msg['role'] === 'user' ? 'Nauczyciel' : 'Asystent';
            $contextPrompt .= "{$role}: {$msg['content']}\n\n";
        }

        if ($webContext) {
            $contextPrompt .= "\n--- POBRANA TREŚĆ ZE STRON ---\n{$webContext}\n--- KONIEC ---\n\n";
            $contextPrompt .= "Asystent (przeanalizuj pobraną treść i odpowiedz na pytanie nauczyciela):";
        } else {
            $contextPrompt .= "Asystent:";
        }

        try {
            $result = $this->ai->generate(
                userPrompt: $contextPrompt,
                systemPrompt: self::SYSTEM_PROMPT,
                module: 'chat',
                maxTokens: 2000,
                owner: $this->getUser(),
            );

            // Extract image tag if present
            $imageUrl = null;
            $textResponse = $result;
            if (preg_match('/\[IMAGE:\s*(.+?)\]/', $result, $m)) {
                $imagePrompt = trim($m[1]);
                $textResponse = trim(str_replace($m[0], '', $result));
                $imageUrl = 'https://image.pollinations.ai/prompt/' . urlencode($imagePrompt) . '?width=800&height=600&nologo=true';
            }

            // Save to history
            $history[] = ['role' => 'user', 'content' => $message];
            $history[] = ['role' => 'assistant', 'content' => $textResponse, 'image' => $imageUrl];
            $session->set('chat_history', $history);

            return $this->json([
                'text' => $textResponse,
                'image' => $imageUrl,
            ]);
        } catch (\RuntimeException $e) {
            return $this->json(['error' => $e->getMessage()], 500);
        }
    }

    #[Route('/clear', name: 'app_chat_clear', methods: ['POST'])]
    public function clear(Request $request): Response
    {
        $request->getSession()->remove('chat_history');
        return $this->redirectToRoute('app_chat');
    }

    /**
     * Fetch and extract text content from a web page.
     */
    private function fetchPageContent(string $url): ?string
    {
        try {
            $response = $this->httpClient->request('GET', $url, [
                'timeout' => 10,
                'max_redirects' => 3,
                'headers' => [
                    'User-Agent' => 'Mozilla/5.0 (Nauczyciel Assistant Bot)',
                    'Accept' => 'text/html',
                ],
            ]);

            if ($response->getStatusCode() !== 200) {
                return null;
            }

            $html = $response->getContent();

            // Strip scripts, styles, nav, footer, header
            $html = preg_replace('/<script[^>]*>.*?<\/script>/si', '', $html);
            $html = preg_replace('/<style[^>]*>.*?<\/style>/si', '', $html);
            $html = preg_replace('/<nav[^>]*>.*?<\/nav>/si', '', $html);
            $html = preg_replace('/<footer[^>]*>.*?<\/footer>/si', '', $html);
            $html = preg_replace('/<header[^>]*>.*?<\/header>/si', '', $html);

            // Extract text
            $text = strip_tags($html);
            $text = html_entity_decode($text, ENT_QUOTES, 'UTF-8');

            // Clean whitespace
            $text = preg_replace('/[ \t]+/', ' ', $text);
            $text = preg_replace('/\n{3,}/', "\n\n", $text);
            $text = trim($text);

            // Limit to ~4000 chars to not blow up the prompt
            if (mb_strlen($text) > 4000) {
                $text = mb_substr($text, 0, 4000) . "\n\n[... treść skrócona do 4000 znaków ...]";
            }

            return $text ?: null;
        } catch (\Throwable $e) {
            return null;
        }
    }
}
