<?php

declare(strict_types=1);

namespace App\Command;

use App\Entity\Literature;
use App\Entity\LiteratureQuestion;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

#[AsCommand(
    name: 'app:seed-literature',
    description: 'Seed literature database with obligatory readings for grades 4-8',
)]
class SeedLiteratureCommand extends Command
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly string $projectDir,
    ) {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $file = $this->projectDir . '/data/literature_seed.json';
        if (!file_exists($file)) {
            $io->error('Seed file not found: ' . $file);
            return Command::FAILURE;
        }

        $data = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);

        // Nullify orphaned references before deleting literature
        $this->em->getConnection()->executeStatement('UPDATE lesson_plan SET literature_id = NULL');
        // Clear existing data
        $this->em->createQuery('DELETE FROM App\Entity\LiteratureQuestion')->execute();
        $this->em->createQuery('DELETE FROM App\Entity\Literature')->execute();

        foreach ($data as $item) {
            $lit = new Literature();
            $lit->setTitle($item['title']);
            $lit->setAuthor($item['author']);
            $lit->setClassLevel($item['classLevel']);
            $lit->setEpoch($item['epoch'] ?? null);
            $lit->setSummary($item['summary'] ?? null);
            $lit->setCharacters($item['characters'] ?? null);
            $lit->setThemes($item['themes'] ?? null);
            $lit->setIsObligatory($item['isObligatory'] ?? true);

            $this->em->persist($lit);

            foreach ($item['questions'] ?? [] as $q) {
                $question = new LiteratureQuestion();
                $question->setQuestion($q['question']);
                $question->setAnswer($q['answer'] ?? null);
                $question->setDifficulty($q['difficulty'] ?? null);
                $question->setQuestionType($q['questionType'] ?? null);

                $lit->addQuestion($question);
                $this->em->persist($question);
            }

            $io->writeln('  + ' . $item['title'] . ' (' . count($item['questions'] ?? []) . ' pytań)');
        }

        $this->em->flush();

        $io->success(sprintf('Załadowano %d lektur.', count($data)));

        return Command::SUCCESS;
    }
}
