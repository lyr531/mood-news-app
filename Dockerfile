FROM node:20-alpine

WORKDIR /app

# 零依赖项目，不需要 npm install
ENV NODE_ENV=production \
    PORT=9000 \
    HOST=0.0.0.0 \
    DATA_DIR=/tmp

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

EXPOSE 9000

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

CMD ["node", "server.js"]