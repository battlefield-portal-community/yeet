# file-uploader

Resumable file uploads. React + [Uppy](https://uppy.io/) on the frontend, [tusd](https://github.com/tus/tusd) on the backend storing files in Cloudflare R2.

## Layout

- `FE/` — Vite + React app with an Uppy dashboard that uploads over the [tus](https://tus.io/) protocol.
- `BE/` — `docker-compose` for the tusd server.

## Backend

tusd runs via Docker Compose and pushes uploads straight to an R2 bucket.

Create `BE/.env` with the R2 credentials tusd needs:

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
```

Then:

```sh
cd BE
docker compose up
```

Server listens on `:8080`, with the S3 endpoint and bucket configured in `docker-compose.yml`.

## Frontend

```sh
cd FE
npm install
npm run dev
```

The tus endpoint is set in `src/App.jsx` — point it at your tusd server (defaults to the hosted one).

Other scripts: `npm run build`, `npm run preview`, `npm run lint`.
