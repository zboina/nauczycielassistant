<?php

declare(strict_types=1);

namespace App\Service;

use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Wyszukiwanie i pobieranie zdjęć z Unsplash (darmowa biblioteka kuratoryjna, licencja Unsplash).
 * Pobieranie idzie przez serwer — obraz trafia do nas jako lokalny plik (czysty pod CORS, działa w eksporcie PDF).
 */
class UnsplashClient
{
    private const BASE_URL = 'https://api.unsplash.com';

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly string $unsplashAccessKey,
    ) {}

    public function isConfigured(): bool
    {
        return $this->unsplashAccessKey !== '' && !str_contains($this->unsplashAccessKey, 'change');
    }

    /**
     * @return array{query:string, results:array<int, array{id:string, preview:string, full:string, tags:string, user:string, page:string}>}
     */
    public function search(string $query, string $orientation = 'all', int $page = 1): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('Brak klucza Unsplash. Dodaj UNSPLASH_ACCESS_KEY w .env.local (darmowa rejestracja na unsplash.com/developers).');
        }

        $en = $this->translateToEnglish($query);

        $params = [
            'query'          => mb_substr($en, 0, 100),
            'per_page'       => 24,
            'page'           => max(1, min(20, $page)),
            'content_filter' => 'high',  // odsiewa kontrowersyjne treści
        ];
        if (in_array($orientation, ['landscape', 'portrait', 'squarish'], true)) {
            $params['orientation'] = $orientation;
        }

        $response = $this->httpClient->request('GET', self::BASE_URL . '/search/photos', [
            'query'   => $params,
            'headers' => [
                'Accept-Version' => 'v1',
                'Authorization'  => 'Client-ID ' . $this->unsplashAccessKey,
            ],
            'timeout' => 20,
        ]);

        $status  = $response->getStatusCode();
        $content = $response->getContent(false);
        if ($status !== 200) {
            throw new \RuntimeException('Unsplash: ' . mb_substr(strip_tags($content), 0, 200));
        }

        $data = json_decode($content, true);
        $hits = is_array($data['results'] ?? null) ? $data['results'] : [];

        $results = array_map(static function (array $h): array {
            $urls = is_array($h['urls'] ?? null) ? $h['urls'] : [];
            $user = is_array($h['user'] ?? null) ? $h['user'] : [];
            $tags = '';
            if (!empty($h['tags']) && is_array($h['tags'])) {
                $tags = implode(', ', array_map(static fn ($t) => (string) ($t['title'] ?? ''), $h['tags']));
            }
            $tags = $tags ?: (string) ($h['alt_description'] ?? $h['description'] ?? '');

            return [
                'id'      => (string) ($h['id'] ?? ''),
                'preview' => (string) ($urls['small'] ?? $urls['thumb'] ?? ''),
                'full'    => (string) ($urls['regular'] ?? $urls['full'] ?? $urls['raw'] ?? ''),
                'tags'    => $tags,
                'user'    => (string) ($user['name'] ?? ''),
                'page'    => (string) (($h['links']['html'] ?? '')),
            ];
        }, $hits);

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
                'query'   => ['q' => $text, 'langpair' => 'pl|en'],
                'timeout' => 8,
            ]);
            if ($response->getStatusCode() !== 200) {
                return $text;
            }
            $data       = json_decode($response->getContent(false), true);
            $translated = trim((string) ($data['responseData']['translatedText'] ?? ''));

            if ($translated === '' || stripos($translated, 'MYMEMORY WARNING') !== false || stripos($translated, 'INVALID') !== false) {
                return $text;
            }

            return $translated;
        } catch (\Throwable) {
            return $text;
        }
    }

    /** Pobiera bajty obrazu z Unsplash (whitelist hosta — ochrona przed SSRF). */
    public function download(string $url): string
    {
        $host   = (string) (parse_url($url, PHP_URL_HOST) ?: '');
        $scheme = (string) (parse_url($url, PHP_URL_SCHEME) ?: '');
        // Unsplash CDN-y: images.unsplash.com, plus.unsplash.com
        $allowedHosts = ['images.unsplash.com', 'plus.unsplash.com'];
        if ($scheme !== 'https' || !in_array($host, $allowedHosts, true)) {
            throw new \RuntimeException('Niedozwolony adres obrazu.');
        }

        $response = $this->httpClient->request('GET', $url, ['timeout' => 30]);
        if ($response->getStatusCode() !== 200) {
            throw new \RuntimeException('Nie udało się pobrać grafiki (HTTP ' . $response->getStatusCode() . ').');
        }

        return $response->getContent();
    }
}
