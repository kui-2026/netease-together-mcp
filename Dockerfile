FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src

ENV PORT=3456
EXPOSE 3456
USER node
CMD ["node", "src/server.js"]
