FROM node:20-slim

# ── Dependências mínimas do Chromium ─────────────────────────────────────────
# Removemos pacotes desnecessários para reduzir a imagem e o uso de RAM
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Informa ao Puppeteer para usar o Chromium do sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
COPY Back-End/prisma ./Back-End/prisma/

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

# ✅ FIX MEMÓRIA: Limita o heap do Node.js a 350MB.
# Sem este limite, o V8 pode alocar até 2GB antes de rodar o GC.
# Com Chromium também em memória, ultrapassamos o limite do Railway (512MB).
# 350MB para Node + ~150MB para Chromium = ~500MB total (seguro para 512MB).
CMD ["node", "--max-old-space-size=350", "dist/index.js"]
