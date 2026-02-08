# ---- Build Stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY packages/web/package.json ./packages/web/
# Create stub for server workspace so npm ci doesn't fail
RUN mkdir -p packages/server && echo '{"name":"@channel-observer/server","version":"1.0.0","private":true}' > packages/server/package.json

RUN npm ci --workspace=packages/web --include-workspace-root

# Copy web source
COPY packages/web/ ./packages/web/

# Build
RUN npm run build --workspace=packages/web

# ---- Production Stage ----
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/packages/web/dist/ /usr/share/nginx/html/

# Copy nginx config
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
