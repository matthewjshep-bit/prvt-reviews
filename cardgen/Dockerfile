FROM node:20-slim

# librsvg (used by sharp for SVG text) needs real fonts installed, otherwise
# text renders with a fallback. DejaVu is the safety-net fallback; our 3 bundled
# families (Inter / Source Serif 4 / Archivo Black) are installed below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

# Register the bundled TTFs system-wide and rebuild the fontconfig cache so
# librsvg resolves 'Inter', 'Source Serif 4', and 'Archivo Black' by name.
RUN mkdir -p /usr/share/fonts/truetype/cardgen \
  && cp /app/fonts/*.ttf /usr/share/fonts/truetype/cardgen/ \
  && fc-cache -f \
  && fc-list | grep -Ei 'inter|source serif|archivo' || true

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
