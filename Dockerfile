FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3012
EXPOSE 3012

CMD ["node", "server.js"]
