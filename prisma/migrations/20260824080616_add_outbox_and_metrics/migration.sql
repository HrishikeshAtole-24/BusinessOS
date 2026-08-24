-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "metric" VARCHAR(80) NOT NULL,
    "dimension" VARCHAR(80),
    "value" DECIMAL(16,2) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_organization_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("organization_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "metrics_daily_organization_id_metric_day_idx" ON "metrics_daily"("organization_id", "metric", "day");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_daily_organization_id_day_metric_dimension_key" ON "metrics_daily"("organization_id", "day", "metric", "dimension");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_daily" ADD CONSTRAINT "metrics_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
