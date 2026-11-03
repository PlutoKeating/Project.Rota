FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY storage/server.mjs storage/backup.mjs storage/
COPY migrations migrations
# SSH deployment checkouts can use umask 077; normalize packaged code permissions.
RUN chmod -R a+rX /app
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "storage/server.mjs"]
