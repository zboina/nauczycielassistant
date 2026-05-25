<?php

declare(strict_types=1);

namespace App\Service;

use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Wyszukiwanie i pobieranie grafik z Pixabay (darmowa biblioteka, licencja Pixabay).
 * Pobieranie idzie przez serwer — obraz trafia do nas jako lokalny plik (czysty pod CORS, działa w eksporcie PDF).
 */
class PixabayClient
{
    private const BASE_URL = 'https://pixabay.com/api/';

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly string $pixabayApiKey,
    ) {}

    public function isConfigured(): bool
    {
        return $this->pixabayApiKey !== '' && !str_contains($this->pixabayApiKey, 'change');
    }

    /**
     * @return array{query:string, results:array<int, array{id:int, preview:string, full:string, tags:string, user:string, page:string}>}
     */
    public function search(string $query, string $type = 'illustration', int $page = 1): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('Brak klucza Pixabay. Dodaj PIXABAY_API_KEY w pliku .env.local (darmowa rejestracja na pixabay.com).');
        }
        if (!in_array($type, ['illustration', 'vector', 'photo', 'all'], true)) {
            $type = 'illustration';
        }

        // Pixabay ma najlepsze tagi po angielsku — tłumaczymy hasło z polskiego w locie.
        $en = $this->translateToEnglish($query);

        $response = $this->httpClient->request('GET', self::BASE_URL, [
            'query' => [
                'key' => $this->pixabayApiKey,
                'q' => mb_substr($en, 0, 100),
                'image_type' => $type,
                'per_page' => 28,
                'page' => max(1, min(20, $page)),
                'safesearch' => 'true',
                'lang' => 'en',
            ],
            'timeout' => 20,
        ]);

        $status = $response->getStatusCode();
        $content = $response->getContent(false);
        if ($status !== 200) {
            throw new \RuntimeException('Pixabay: ' . mb_substr(strip_tags($content), 0, 200));
        }

        $data = json_decode($content, true);
        $hits = is_array($data['hits'] ?? null) ? $data['hits'] : [];

        $results = array_map(static fn (array $h): array => [
            'id' => (int) ($h['id'] ?? 0),
            'preview' => (string) ($h['previewURL'] ?? ''),
            'full' => (string) ($h['largeImageURL'] ?? $h['webformatURL'] ?? ''),
            'tags' => (string) ($h['tags'] ?? ''),
            'user' => (string) ($h['user'] ?? ''),
            'page' => (string) ($h['pageURL'] ?? ''),
        ], $hits);

        return ['query' => $en, 'results' => $results];
    }

    /**
     * Tłumaczy hasło PL→EN (MyMemory — darmowe, bez klucza). Przy błędzie zwraca oryginał.
     */
    private function translateToEnglish(string $text): string
    {
        $text = trim($text);
        if ($text === '') {
            return $text;
        }

        try {
            $response = $this->httpClient->request('GET', 'https://api.mymemory.translated.net/get', [
                'query' => ['q' => $text, 'langpair' => 'pl|en'],
                'timeout' => 8,
            ]);
            if ($response->getStatusCode() !== 200) {
                return $text;
            }
            $data = json_decode($response->getContent(false), true);
            $translated = trim((string) ($data['responseData']['translatedText'] ?? ''));

            if ($translated === '' || stripos($translated, 'MYMEMORY WARNING') !== false || stripos($translated, 'INVALID') !== false) {
                return $text;
            }

            return $translated;
        } catch (\Throwable) {
            return $text;
        }
    }

    /**
     * Pobiera bajty obrazu z Pixabay (z whitelistą hosta — ochrona przed SSRF).
     */
    public function download(string $url): string
    {
        $host = (string) (parse_url($url, PHP_URL_HOST) ?: '');
        $scheme = (string) (parse_url($url, PHP_URL_SCHEME) ?: '');
        if ($scheme !== 'https' || (!str_ends_with($host, '.pixabay.com') && $host !== 'pixabay.com')) {
            throw new \RuntimeException('Niedozwolony adres obrazu.');
        }

        $response = $this->httpClient->request('GET', $url, ['timeout' => 30]);
        if ($response->getStatusCode() !== 200) {
            throw new \RuntimeException('Nie udało się pobrać grafiki (HTTP ' . $response->getStatusCode() . ').');
        }

        return $response->getContent();
    }
}
