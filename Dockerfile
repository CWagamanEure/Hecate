# Hecate v1 — research/MVP container.
# Single stage, tsx in image. Not optimized for production packaging.
# See docs/EIGEN_DEPLOYMENT.md for production considerations.

FROM node:20-slim AS hecate

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source (respects .dockerignore).
COPY . .

# Default DATA_DIR inside the container; ensure it exists and is owned by node.
RUN mkdir -p /app/data && chown -R node:node /app

# Defaults that are safe to bake in. ENGINE_PRIVATE_KEY is deliberately NOT
# set here — it must be supplied at runtime via `docker run -e`.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    RUNTIME_MODE=LOCAL_MOCK \
    CODE_DIGEST=sha256:dev-local

# Drop privileges.
USER node

EXPOSE 8787

# Lightweight health probe using Node's built-in fetch (Node 20+).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
