-- Durable whole-job deadline survives process restart and lease reclamation.
ALTER TABLE "novel_import_jobs" ADD COLUMN "parseDeadlineAt" TIMESTAMP(3);
