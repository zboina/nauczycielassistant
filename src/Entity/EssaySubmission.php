<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\EssaySubmissionRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: EssaySubmissionRepository::class)]
class EssaySubmission
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'submissions')]
    #[ORM\JoinColumn(nullable: false)]
    private ?Essay $essay = null;

    #[ORM\Column(length: 100)]
    private ?string $studentName = null;

    #[ORM\Column(type: Types::TEXT)]
    private ?string $content = null;

    #[ORM\Column]
    private int $wordCount = 0;

    #[ORM\Column]
    private \DateTimeImmutable $submittedAt;

    /** AI analysis result: scores, errors, feedback */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $aiAnalysis = null;

    /** AI authorship detection result */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $aiDetection = null;

    /** Teacher's final scores per category */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $teacherScores = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $teacherComment = null;

    /** pending, ai_reviewed, approved */
    #[ORM\Column(length: 20)]
    private string $status = 'pending';

    public function __construct()
    {
        $this->submittedAt = new \DateTimeImmutable();
    }

    public function getId(): ?int { return $this->id; }

    public function getEssay(): ?Essay { return $this->essay; }
    public function setEssay(?Essay $essay): static { $this->essay = $essay; return $this; }

    public function getStudentName(): ?string { return $this->studentName; }
    public function setStudentName(string $studentName): static { $this->studentName = $studentName; return $this; }

    public function getContent(): ?string { return $this->content; }
    public function setContent(string $content): static
    {
        $this->content = $content;
        $this->wordCount = str_word_count($content);
        return $this;
    }

    public function getWordCount(): int { return $this->wordCount; }

    public function getSubmittedAt(): \DateTimeImmutable { return $this->submittedAt; }

    public function getAiAnalysis(): ?array { return $this->aiAnalysis; }
    public function setAiAnalysis(?array $aiAnalysis): static { $this->aiAnalysis = $aiAnalysis; return $this; }

    public function getAiDetection(): ?array { return $this->aiDetection; }
    public function setAiDetection(?array $aiDetection): static { $this->aiDetection = $aiDetection; return $this; }

    public function getAiDetectionVerdict(): ?string { return $this->aiDetection['verdict'] ?? null; }
    public function getAiDetectionScore(): ?int { return $this->aiDetection['score'] ?? null; }

    public function getTeacherScores(): ?array { return $this->teacherScores; }
    public function setTeacherScores(?array $teacherScores): static { $this->teacherScores = $teacherScores; return $this; }

    public function getTeacherComment(): ?string { return $this->teacherComment; }
    public function setTeacherComment(?string $teacherComment): static { $this->teacherComment = $teacherComment; return $this; }

    public function getStatus(): string { return $this->status; }
    public function setStatus(string $status): static { $this->status = $status; return $this; }

    public function getTotalAiScore(): ?int
    {
        if (!$this->aiAnalysis || !isset($this->aiAnalysis['scores'])) {
            return null;
        }
        return array_sum(array_column($this->aiAnalysis['scores'], 'score'));
    }

    public function getMaxAiScore(): ?int
    {
        if (!$this->aiAnalysis || !isset($this->aiAnalysis['scores'])) {
            return null;
        }
        return array_sum(array_column($this->aiAnalysis['scores'], 'max'));
    }

    public function getTotalTeacherScore(): ?int
    {
        if (!$this->teacherScores) {
            return null;
        }
        return array_sum(array_values($this->teacherScores));
    }

    public function getStatusLabel(): string
    {
        return match ($this->status) {
            'pending' => 'Oczekuje',
            'ai_reviewed' => 'Sprawdzone AI',
            'approved' => 'Zatwierdzone',
            default => $this->status,
        };
    }

    public function getStatusColor(): string
    {
        return match ($this->status) {
            'pending' => 'secondary',
            'ai_reviewed' => 'warning',
            'approved' => 'success',
            default => 'secondary',
        };
    }
}
