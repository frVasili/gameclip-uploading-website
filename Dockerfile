# Game clip site: Node (no npm dependencies) + ffmpeg. Runs as the unprivileged "node" user (uid 1000).
# Alpine 3.22 on purpose: its Mesa (25.1) still drives AMD GPUs on kernels older than 6.6 (e.g. Debian 12's 6.1).
# Mesa 26.1+ refuses amdgpu DRM < 3.54, which breaks VAAPI there. Older Mesa works fine on newer kernels too.
FROM node:24-alpine3.22

ARG TARGETARCH
# ffmpeg; VAAPI drivers for optional GPU encoding (AMD via Mesa everywhere, Intel on x86 only); tini as init
RUN apk add --no-cache ffmpeg tini mesa-va-gallium \
 && if [ "$TARGETARCH" = "amd64" ]; then apk add --no-cache intel-media-driver libva-intel-driver; fi \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web

ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
