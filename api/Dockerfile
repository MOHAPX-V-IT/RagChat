FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
