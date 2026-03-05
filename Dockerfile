FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=33001

EXPOSE 33001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:33001/health || exit 1

CMD ["node", "src/index.js"]
