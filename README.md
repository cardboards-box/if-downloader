# Fetchkit

A Nuxt app for downloading batches of iFunny images and videos through a server-side proxy.

## Setup

```bash
cd src
bun install
bun run dev
```

Open `http://localhost:3000`, paste up to 30 iFunny picture or video links, and select **Download files**.

## How it works

1. The browser extracts and deduplicates supported iFunny links from pasted text.
2. `/api/resolve` fetches each iFunny post and locates its original media URL.
3. `/api/media` validates the CDN URL and streams the file through the Nuxt server.
4. The browser shows byte-level progress and saves each completed file.

The proxy only accepts HTTPS media from iFunny's `getfn.io` CDN. Media is streamed and is not persisted by the app.

## Production build

```bash
cd src
bun run typecheck
bun run build
bun .output/server/index.mjs
```

The production server listens on port `3000` by default. Set `PORT` and `HOST` to override it.

## Docker

Build and start the app with Docker Compose:

```bash
docker compose up --build -d
```

Open `http://localhost:3000`. To expose a different host port:

```bash
PORT=8080 docker compose up --build -d
```

Or build and run the image directly:

```bash
docker build -t app .
docker run --rm -p 3000:3000 app
```
