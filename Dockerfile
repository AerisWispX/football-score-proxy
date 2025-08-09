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
    xvfb \
    && rm -rf /var/cache/apk/*

# Tell Puppeteer to skip installing Chromium and use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    DISPLAY=:99

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for better caching)
COPY package*.json ./

# Install app dependencies with verbose logging
RUN npm install --only=production --verbose

# Copy application files
COPY server.js .
COPY index.html .

# Create a non-privileged user to run the app
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Change ownership of the app directory
RUN chown -R nextjs:nodejs /usr/src/app

# Switch to non-privileged user
USER nextjs

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
