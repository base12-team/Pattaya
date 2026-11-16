FROM node:20-alpine
WORKDIR /app
COPY server.js seed.json ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
