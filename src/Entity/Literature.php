<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\LiteratureRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: LiteratureRepository::class)]
class Literature
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 200)]
    private ?string $title = null;

    #[ORM\Column(length: 200)]
    private ?string $author = null;

    #[ORM\Column(length: 5, nullable: true)]
    private ?string $classLevel = null;

    #[ORM\Column(length: 50, nullable: true)]
    private ?string $epoch = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $summary = null;

    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $characters = null;

    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $themes = null;

    #[ORM\Column]
    private bool $isObligatory = true;

    /** @var Collection<int, LiteratureQuestion> */
    #[ORM\OneToMany(targetEntity: LiteratureQuestion::class, mappedBy: 'literature', cascade: ['persist', 'remove'])]
    private Collection $questions;

    public function __construct()
    {
        $this->questions = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getTitle(): ?string
    {
        return $this->title;
    }

    public function setTitle(string $title): static
    {
        $this->title = $title;
        return $this;
    }

    public function getAuthor(): ?string
    {
        return $this->author;
    }

    public function setAuthor(string $author): static
    {
        $this->author = $author;
        return $this;
    }

    public function getClassLevel(): ?string
    {
        return $this->classLevel;
    }

    public function setClassLevel(?string $classLevel): static
    {
        $this->classLevel = $classLevel;
        return $this;
    }

    public function getEpoch(): ?string
    {
        return $this->epoch;
    }

    public function setEpoch(?string $epoch): static
    {
        $this->epoch = $epoch;
        return $this;
    }

    public function getSummary(): ?string
    {
        return $this->summary;
    }

    public function setSummary(?string $summary): static
    {
        $this->summary = $summary;
        return $this;
    }

    public function getCharacters(): ?array
    {
        return $this->characters;
    }

    public function setCharacters(?array $characters): static
    {
        $this->characters = $characters;
        return $this;
    }

    public function getThemes(): ?array
    {
        return $this->themes;
    }

    public function setThemes(?array $themes): static
    {
        $this->themes = $themes;
        return $this;
    }

    public function isObligatory(): bool
    {
        return $this->isObligatory;
    }

    public function setIsObligatory(bool $isObligatory): static
    {
        $this->isObligatory = $isObligatory;
        return $this;
    }

    /** @return Collection<int, LiteratureQuestion> */
    public function getQuestions(): Collection
    {
        return $this->questions;
    }

    public function addQuestion(LiteratureQuestion $question): static
    {
        if (!$this->questions->contains($question)) {
            $this->questions->add($question);
            $question->setLiterature($this);
        }
        return $this;
    }
}
