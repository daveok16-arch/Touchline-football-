# Project Touchline — production image for Render (or any container host).
FROM node:22-slim

WORKDIR /app

# Install dependencies (including devDependencies: vite and tsx are needed to
# build the bundle and to run the TypeScript server).
COPY package.json ./
RUN npm install --include=dev

# Build the client bundle.
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Render injects PORT at runtime; server.ts reads it.
EXPOSE 3000

CMD ["npm", "start"]
