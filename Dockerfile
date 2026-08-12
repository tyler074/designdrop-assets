FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install the pinned Chromium build plus its system dependencies.
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY server.js ./

ENV PORT=8402
EXPOSE 8402

CMD ["node", "server.js"]
