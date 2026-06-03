FROM node:18-slim

# Install Chrome dependencies in one layer
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libnss3 \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libgbm1 \
  libasound2 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Fail the build early (visible in Railway build logs) if the real Chromium
# binary isn't where PUPPETEER_EXECUTABLE_PATH points — avoids silently
# breaking all PDF generation at runtime if the distro moves it.
RUN test -x /usr/lib/chromium/chromium \
  || (echo "ERROR: chromium binary not at /usr/lib/chromium/chromium" && ls -la /usr/lib/chromium 2>/dev/null; exit 1)

# Tell puppeteer to use installed chromium, not download its own.
# Point at the REAL binary, not /usr/bin/chromium — that's a shell wrapper that
# forks to source /etc/chromium.d/* on every launch, which fails under memory/
# PID pressure on Railway ("/usr/bin/chromium: …: Cannot fork"). Skipping it
# removes those extra forks. Symlink it back to /usr/bin/chromium if the
# distro ever moves the binary.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/lib/chromium/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "quote-server.js"]
