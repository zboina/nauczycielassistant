<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260407142248 extends AbstractMigration
{
    public function getDescription(): string
    {
        return '';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, module VARCHAR(50) NOT NULL, model VARCHAR(100) NOT NULL, tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL, cost_usd NUMERIC(10, 6) DEFAULT NULL, duration_ms INTEGER DEFAULT NULL, status VARCHAR(20) NOT NULL, error CLOB DEFAULT NULL, created_at DATETIME NOT NULL, owner_id INTEGER DEFAULT NULL, CONSTRAINT FK_558C6437E3C61F9 FOREIGN KEY (owner_id) REFERENCES "user" (id) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_558C6437E3C61F9 ON ai_log (owner_id)');
        $this->addSql('CREATE TABLE diploma (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, template_id INTEGER NOT NULL, student_name VARCHAR(200) NOT NULL, achievement CLOB DEFAULT NULL, class_level VARCHAR(10) DEFAULT NULL, date DATE DEFAULT NULL, file_path VARCHAR(500) DEFAULT NULL, created_at DATETIME NOT NULL, owner_id INTEGER NOT NULL, CONSTRAINT FK_EC2189577E3C61F9 FOREIGN KEY (owner_id) REFERENCES "user" (id) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_EC2189577E3C61F9 ON diploma (owner_id)');
        $this->addSql('CREATE TABLE generated_material (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, type VARCHAR(30) NOT NULL, title VARCHAR(200) DEFAULT NULL, class_level VARCHAR(10) DEFAULT NULL, subject_context CLOB DEFAULT NULL, prompt_used CLOB DEFAULT NULL, content CLOB NOT NULL, file_path VARCHAR(500) DEFAULT NULL, is_favorite BOOLEAN NOT NULL, created_at DATETIME NOT NULL, owner_id INTEGER NOT NULL, CONSTRAINT FK_3C1F422C7E3C61F9 FOREIGN KEY (owner_id) REFERENCES "user" (id) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_3C1F422C7E3C61F9 ON generated_material (owner_id)');
        $this->addSql('CREATE TABLE literature (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, title VARCHAR(200) NOT NULL, author VARCHAR(200) NOT NULL, class_level VARCHAR(5) DEFAULT NULL, epoch VARCHAR(50) DEFAULT NULL, summary CLOB DEFAULT NULL, characters CLOB DEFAULT NULL, themes CLOB DEFAULT NULL, is_obligatory BOOLEAN NOT NULL)');
        $this->addSql('CREATE TABLE literature_question (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, question CLOB NOT NULL, answer CLOB DEFAULT NULL, difficulty VARCHAR(10) DEFAULT NULL, question_type VARCHAR(20) DEFAULT NULL, created_at DATETIME NOT NULL, literature_id INTEGER NOT NULL, CONSTRAINT FK_8C33F3B6C0C5167B FOREIGN KEY (literature_id) REFERENCES literature (id) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_8C33F3B6C0C5167B ON literature_question (literature_id)');
        $this->addSql('CREATE TABLE "user" (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, email VARCHAR(180) NOT NULL, roles CLOB NOT NULL, password VARCHAR(255) NOT NULL, full_name VARCHAR(100) NOT NULL, school_name VARCHAR(200) DEFAULT NULL, city VARCHAR(100) DEFAULT NULL, created_at DATETIME NOT NULL)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_8D93D649E7927C74 ON "user" (email)');
        $this->addSql('CREATE TABLE messenger_messages (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, body CLOB NOT NULL, headers CLOB NOT NULL, queue_name VARCHAR(190) NOT NULL, created_at DATETIME NOT NULL, available_at DATETIME NOT NULL, delivered_at DATETIME DEFAULT NULL)');
        $this->addSql('CREATE INDEX IDX_75EA56E0FB7336F0E3BD61CE16BA31DBBF396750 ON messenger_messages (queue_name, available_at, delivered_at, id)');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('DROP TABLE ai_log');
        $this->addSql('DROP TABLE diploma');
        $this->addSql('DROP TABLE generated_material');
        $this->addSql('DROP TABLE literature');
        $this->addSql('DROP TABLE literature_question');
        $this->addSql('DROP TABLE "user"');
        $this->addSql('DROP TABLE messenger_messages');
    }
}
