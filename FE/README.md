# FE — upload frontend

Vite + React app with an [Uppy](https://uppy.io/) Dashboard that uploads files to
the `yeet` Worker using the [`@uppy/aws-s3`](https://uppy.io/docs/aws-s3/) plugin
in **multipart** mode. Uppy chunks each file and, for every part, calls the
Worker's `/api/uploads*` endpoints to get a presigned URL, then PUTs the bytes
**directly to R2** — the Worker only signs, it never proxies the bytes.

The upload logic lives in `src/App.jsx`, where the plugin's
`createMultipartUpload`, `signPart`, `listParts`, `completeMultipartUpload`, and
`abortMultipartUpload` hooks each map to a `POST /api/uploads*` call.

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts Vite on `http://localhost:5173`. Vite proxies `/api` to
`http://localhost:8787`, so **the Worker must also be running** for uploads to
work locally — run `wrangler dev` in `BE/` (see the
[root README](../README.md)). Uploads are also gated by the `YEET` KV kill
switch, so `uploads:enabled` must be `"true"` or the API returns 403.

## Configuration

The API base URL comes from `VITE_API_BASE` (read in `src/App.jsx`). It defaults
to empty, which means **same-origin** — the Vite `/api` proxy in dev, and the
combined Worker in production. Only set it to point the frontend at a Worker on a
different origin:

```sh
cp .env.example .env
# then edit VITE_API_BASE in .env
```

## Scripts

- `npm run dev` — start the Vite dev server (with the `/api` → `:8787` proxy).
- `npm run build` — build the SPA to `dist/` (the Worker serves this in prod).
- `npm run preview` — preview the production build locally.
- `npm run lint` — run ESLint.

## Backend

The Worker (R2 multipart signing, the `YEET` KV kill switch, and the **required
R2 bucket CORS** setup — including exposing the `ETag` header) is documented in
the [root README](../README.md).
