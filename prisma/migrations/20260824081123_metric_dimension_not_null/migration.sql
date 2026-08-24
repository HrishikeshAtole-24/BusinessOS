/*
  Warnings:

  - Made the column `dimension` on table `metrics_daily` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "metrics_daily" ALTER COLUMN "dimension" SET NOT NULL,
ALTER COLUMN "dimension" SET DEFAULT '';
