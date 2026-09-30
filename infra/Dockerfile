FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm run build
USER node
CMD ["./node_modules/.bin/tsx", "apps/worker/main.ts"]
