# Use Debian-based Node.js for stability (instead of Alpine)
FROM node:20-slim

# Install Chromium + fonts & deps for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    xdg-utils \
    wget \
    curl \
    gnupg \
 && rm -rf /var/lib/apt/lists/*

# Puppeteer env vars (use system Chromium)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (cache layer)
COPY package*.json ./

# Install dependencies
RUN npm install --only=production --verbose

# Copy app files
COPY server.js .
COPY index.html .

# Create non-root user
RUN useradd --create-home --shell /bin/bash nodeuser
USER nodeuser

# Expose API port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD curl -f http://127.0.0.1:3000/health || exit 1

# Start app
CMD ["npm", "start"]
