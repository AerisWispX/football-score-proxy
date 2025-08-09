# Use Node.js 20 with better Puppeteer compatibility
FROM node:20-alpine

# Install necessary dependencies for Puppeteer with better stability
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ttf-dejavu \
    ttf-droid \
    ttf-liberation \
    udev \
    xvfb \
    wget \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Configure Puppeteer environment variables for better stability
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    DISPLAY=:99 \
    NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_DEVEL_SANDBOX=/usr/lib/chromium/chrome_sandbox \
    NODE_OPTIONS="--max-old-space-size=512"

# Create app directory with proper permissions
WORKDIR /usr/src/app

# Create a non-privileged user first
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs

# Copy package files and install dependencies with proper ownership
COPY --chown=nextjs:nodejs package*.json ./

# Switch to non-privileged user before installing dependencies
USER nextjs

# Install app dependencies with verbose logging and timeout settings
RUN npm ci --only=production --verbose --timeout=300000

# Copy application files with proper ownership
COPY --chown=nextjs:nodejs server.js .
COPY --chown=nextjs:nodejs index.html .

# Create necessary directories with proper permissions
RUN mkdir -p /tmp/chrome-user-data && \
    chmod 755 /tmp/chrome-user-data

# Expose port
EXPOSE 3000

# Health check with better configuration
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider --prefer-family=IPv4 --timeout=25 http://127.0.0.1:3000/health || exit 1

# Use dumb-init to handle signals properly and start the application
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
