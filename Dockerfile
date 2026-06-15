FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --legacy-peer-deps --ignore-scripts

COPY . .

RUN mkdir -p public && \
    if [ -f "index.html" ]; then mv index.html public/index.html; fi

EXPOSE 3000

CMD ["node", "server.js"]
