-- AlterTable
ALTER TABLE "Message" ADD COLUMN "tokenCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows with a conservative text-based estimate.
-- Exact provider usage is recorded for new AI messages when available.
UPDATE "Message"
SET "tokenCount" = GREATEST(1, CEIL(LENGTH("content")::numeric / 4.0))::integer
WHERE LENGTH("content") > 0;
