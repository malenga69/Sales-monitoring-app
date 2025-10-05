# Simple Node server container
FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
COPY server ./server
WORKDIR /app/server
RUN npm install --production
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "index.js"]
