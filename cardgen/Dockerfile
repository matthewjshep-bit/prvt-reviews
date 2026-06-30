FROM node:20-slim

# librsvg (used by sharp for SVG text) needs real fonts installed,
# otherwise the name renders blank on minimal base images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
