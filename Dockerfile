# node:sqlite needs Node >= 22.13, package.json asks for 22.18+. The 22 tag always has it.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# The server writes .env on first start and the database into data/, both as the node user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3012 \
    DATABASE_PATH=data/neopin.db

VOLUME /app/data
EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3012)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
