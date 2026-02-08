# ---- Build Stage ----
FROM node:22-alpine AS builder

# bcrypt requires native build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
# Create stub for web workspace so npm ci doesn't fail
RUN mkdir -p packages/web && echo '{"name":"@channel-observer/web","version":"1.0.0","private":true}' > packages/web/package.json

RUN npm ci --workspace=packages/server --include-workspace-root

# Copy server source & prisma schema
COPY packages/server/ ./packages/server/

# Generate Prisma client
RUN npx prisma generate --schema=packages/server/prisma/schema.prisma

# Build TypeScript
RUN npm run build --workspace=packages/server

# Compile seed script separately (not included in tsconfig src)
RUN cd packages/server && npx tsc --esModuleInterop --module ESNext --moduleResolution bundler --target ES2022 --outDir dist-seed prisma/seed.ts --skipLibCheck

# ---- Production Stage ----
FROM node:22-alpine

# bcrypt native module needs libstdc++; openssl for Prisma
RUN apk add --no-cache libstdc++ openssl

# Install cloudflared for tunnel support
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then CF_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then CF_ARCH="arm64"; \
    else CF_ARCH="amd64"; fi && \
    wget -q "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -O /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
RUN mkdir -p packages/web && echo '{"name":"@channel-observer/web","version":"1.0.0","private":true}' > packages/web/package.json

RUN npm ci --workspace=packages/server --include-workspace-root --omit=dev

# Copy Prisma schema (needed for db push / seed at runtime)
COPY packages/server/prisma/ ./packages/server/prisma/

# Re-generate Prisma client in production node_modules
RUN npx prisma generate --schema=packages/server/prisma/schema.prisma

# Copy compiled output from builder
COPY --from=builder /app/packages/server/dist/ ./packages/server/dist/
COPY --from=builder /app/packages/server/dist-seed/ ./packages/server/dist-seed/

# Copy entrypoint
COPY packages/server/entrypoint.sh ./packages/server/entrypoint.sh
RUN chmod +x ./packages/server/entrypoint.sh

WORKDIR /app/packages/server

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
