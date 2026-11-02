FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
