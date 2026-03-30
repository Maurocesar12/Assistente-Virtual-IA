FROM node:20-slim

# Dependências do Chromium para o wppconnect/Puppeteer
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

# Copia arquivos de configuração do NPM
COPY package*.json ./

# 🚨 O PULO DO GATO: Copia a pasta do Prisma antes de instalar!
COPY Back-End/prisma ./prisma/

# Agora sim, instala as dependências (e o prisma generate vai rodar feliz da vida)
RUN npm ci

# Copia o resto do código
COPY . .

# Compila o TypeScript
RUN npm run build

# Expõe a porta que o Express usa
EXPOSE 3000

CMD ["node", "dist/index.js"]