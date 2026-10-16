CREATE TABLE "PrintDocument" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrintDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrintDocument_expiresAt_idx" ON "PrintDocument"("expiresAt");
