#!/bin/sh
set -e

echo "=== Running Prisma db push ==="
npx prisma db push --schema=prisma/schema.prisma --skip-generate --accept-data-loss

echo "=== Enabling pgvector extension and embedding column ==="
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  await p.\$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  const cols = await p.\$queryRawUnsafe(
    \"SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_entries' AND column_name = 'embedding'\"
  );
  if (cols.length === 0) {
    await p.\$executeRawUnsafe('ALTER TABLE knowledge_entries ADD COLUMN embedding vector(3072)');
    console.log('Added embedding column');
  } else {
    console.log('Embedding column already exists');
  }
  await p.\$disconnect();
})().catch(e => { console.error('pgvector setup error:', e.message); process.exit(0); });
"

echo "=== Running database seed ==="
node dist-seed/seed.js || echo "Seed skipped or already applied"

echo "=== Starting server ==="
exec node dist/index.js
