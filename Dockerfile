# build
FROM node:24-alpine AS builder

WORKDIR /app
RUN npm install -g pnpm@10.28.1
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN [ ! -e ".env" ] && cp .env.example .env || true
RUN pnpm build:web

# nginx
FROM nginx:1.27-alpine-slim AS app

COPY --from=builder /app/dist/web /usr/share/nginx/html

COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

CMD ["nginx", "-g", "daemon off;"]
