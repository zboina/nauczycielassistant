<?php

declare(strict_types=1);

namespace App\Service;

use Dompdf\Dompdf;
use Dompdf\Options;
use Symfony\Component\HttpFoundation\Response;
use Twig\Environment;

class PdfGenerator
{
    public function __construct(
        private readonly Environment $twig,
        private readonly string $projectDir,
    ) {}

    public function generateResponse(
        string $template,
        array $context,
        string $filename,
        string $orientation = 'portrait',
    ): Response {
        $html = $this->twig->render($template, $context);

        $options = new Options();
        $options->set('isRemoteEnabled', true);
        $options->set('defaultFont', 'DejaVu Sans');

        $dompdf = new Dompdf($options);
        $dompdf->loadHtml($html);
        $dompdf->setPaper('A4', $orientation);
        $dompdf->render();

        return new Response($dompdf->output(), 200, [
            'Content-Type' => 'application/pdf',
            'Content-Disposition' => 'inline; filename="' . $filename . '"',
        ]);
    }

    public function saveToFile(
        string $template,
        array $context,
        string $relativePath,
        string $orientation = 'portrait',
    ): string {
        $html = $this->twig->render($template, $context);

        $options = new Options();
        $options->set('isRemoteEnabled', true);
        $options->set('defaultFont', 'DejaVu Sans');

        $dompdf = new Dompdf($options);
        $dompdf->loadHtml($html);
        $dompdf->setPaper('A4', $orientation);
        $dompdf->render();

        $fullPath = $this->projectDir . '/var/pdf/' . $relativePath;
        $dir = dirname($fullPath);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }

        file_put_contents($fullPath, $dompdf->output());

        return $relativePath;
    }
}
