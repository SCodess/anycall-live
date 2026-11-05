FROM node:18-alpine AS base
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --production
COPY server/ ./
EXPOSE 3000
CMD ["node", "index.js"]
