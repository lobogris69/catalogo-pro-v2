# CatalogPRO · imagen de producción (Railway). 7-nov-2026, traído de Catalenza.
# node:22-slim en vez de nixpacks/nodejs_20: Node 20 no tiene parche del fallo de oct-2026 y
# nixpacks no deja fijar versión; la imagen oficial se actualiza sola en cada recompilación.
# OJO: NO se pone NODE_ENV=production. Con nixpacks no estaba puesto y cambia la conexión a
# Postgres (ssl) y los mensajes de error; así el comportamiento es idéntico al de antes.
FROM node:22-slim

# poppler-utils: pdftoppm (PDF → láminas). fontconfig + fonts-liberation: precios reescritos
# en las láminas con métricas de Arial (Liberation Sans).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils fontconfig fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# Los archivos subidos viven en el volumen de Railway montado en /app/data (UPLOADS_DIR ya
# está en las variables del servicio).
# node directo (no npm start): recibe él el SIGTERM de Railway y se apaga limpio.
CMD ["node", "dist/index.js"]
