# Use Node.js 20 for better compatibility with newer Puppeteer
FROM node:20-alpine

# Install necessary dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    && rm -rf /var/cache/apk/*

# Tell Puppeteer to skip installing Chromium and use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for better caching)
COPY package*.json ./

# Install app dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create a non-privileged user to run the app
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 && \
    chown -R nextjs:nodejs /usr/src/app

# Switch to non-privileged user
USER nextjs

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
