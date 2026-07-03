# file-uploader

All-Cloudflare resumable file uploads. A single Cloudflare Worker (`yeet`) signs
[R2](https://developers.cloudflare.com/r2/) multipart uploads so file bytes go
**browser → R2 directly** — the Worker never sits in the byte path — and the same
Worker serves the built React SPA as static assets, so the frontend and the
`/api/*` endpoints share one origin. Signing uses
[`aws4fetch`](https://github.com/mhart/aws4fetch) (SigV4); the AWS SDK is never
pulled in. An upload kill switch lives in a KV namespace (`YEET`). There is **no
auth yet** beyond that kill switch.

## How it works

Uploads use the S3 multipart flow, driven by Uppy's `@uppy/aws-s3` plugin on the
frontend and signed by the Worker:

1. **Create** — `POST /api/uploads` asks the Worker to `CreateMultipartUpload`
   on R2. The Worker returns `{ key, uploadId }`. Keys look like
   `public-uploads/<uuid>/<filename>`.
2. **Sign each part** — for every part, `POST /api/uploads/sign-part` returns a
   **presigned PUT URL** (SigV4 in the query string, 1-hour expiry).
3. **Upload parts** — the **browser PUTs each part's bytes straight to R2** using
   those presigned URLs. Bytes never pass through the Worker.
4. **Complete** — `POST /api/uploads/complete` sends the ordered part list
   (`PartNumber` + `ETag`) to R2's `CompleteMultipartUpload`. `list-parts` and
   `abort` support resume and cancel.

The R2 S3 credentials are Worker **secrets** and are used only to sign — they
never reach the browser. Only opaque presigned URLs do.

## Layout

- `FE/` — Vite + React + Uppy frontend (`@uppy/aws-s3` in multipart mode). See
  [`FE/README.md`](FE/README.md).
- `BE/` — the `yeet` Worker (`src/index.ts`) and its `wrangler.toml` config.

## Setup (one-time)

### 1. Install dependencies

```sh
cd BE && npm install
cd FE && npm install
```

### 2. Create the KV namespace

The Worker reads the upload kill switch from a KV namespace bound as `YEET`:

```sh
wrangler kv namespace create YEET
```

Paste the printed `id` into `BE/wrangler.toml` under `[[kv_namespaces]]`:

```toml
[[kv_namespaces]]
binding = "YEET"
id = "<paste the id printed above>"
```

### 3. Set the R2 secrets

The R2 S3-API credentials are Worker secrets — never commit them. Run from `BE/`:

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

The non-secret vars `R2_ACCOUNT_ID` and `R2_BUCKET` (default `horde`) already
live in `BE/wrangler.toml`.

### 4. Configure R2 bucket CORS (required)

**This is the most common reason uploads silently fail.** Because part bytes are
PUT **browser → R2 directly** via presigned URLs, the **R2 bucket's own CORS
policy** (on bucket `horde`) must allow it. This is configured on the bucket
itself — in the Cloudflare R2 dashboard or via the S3 `PutBucketCors` API — and
is completely separate from anything in the Worker code.

The bucket CORS must:

- Allow method **`PUT`** (and the `OPTIONS` preflight) from the frontend's
  origin — `http://localhost:5173` for local dev, your deployed site origin for
  production.
- **Expose the `ETag` response header.** Uppy reads each part's `ETag` from the
  PUT response to build the `complete` request; cross-origin that header is
  hidden unless explicitly exposed, and without it `complete` fails.

Example CORS JSON to paste into the R2 dashboard (or send via `PutBucketCors`):

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "https://your-deployed-site.example.com"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace the origins with your own. Keep `ExposeHeaders: ["ETag"]`.

## The upload kill switch (KV toggle)

Every `/api/uploads*` request first reads the KV key `uploads:enabled`. Unless
it is **exactly** the string `"true"`, the endpoint returns HTTP `403`
`{ "error": "Uploads are currently disabled" }`.

```sh
# Enable uploads
wrangler kv key put --binding=YEET uploads:enabled true

# Disable uploads
wrangler kv key put --binding=YEET uploads:enabled false
```

`YEET` is a general-purpose settings store, not an uploads-only flag. Keep future
keys feature-namespaced (e.g. `uploads:*`) so the store stays organized.

## Local development

Run two processes:

```sh
# Terminal 1 — the Worker/API on http://localhost:8787
cd BE && wrangler dev

# Terminal 2 — the Vite dev server (proxies /api → :8787)
cd FE && npm run dev
```

Vite proxies `/api` to `http://localhost:8787`, so the frontend and API are
same-origin in dev too. `VITE_API_BASE` (see `FE/.env.example`) is only needed
to point the frontend at a non-same-origin API; leave it empty otherwise.

Remember the kill switch — with `uploads:enabled` unset or not `"true"`, every
upload endpoint returns 403 locally as well.

## Deploy

Order matters: the single Worker serves both the API and the built frontend, so
the frontend must be built first.

```sh
# 1. Build the SPA → produces FE/dist
cd FE && npm run build

# 2. Deploy the Worker (bundles src/index.ts, uploads ../FE/dist as assets)
cd BE && wrangler deploy
```

`wrangler deploy` reads `BE/wrangler.toml`: it bundles the Worker and uploads
`../FE/dist` as static assets bound to `ASSETS`. At runtime the Worker's fetch
handler routes `/api/*` to the upload logic and everything else to
`ASSETS.fetch` (with SPA fallback to `index.html`). One deployment, one origin,
both the frontend and the API.

## Endpoints

All endpoints are `POST`, take/return JSON, and are gated by the `uploads:enabled`
kill switch.

| Endpoint | Request body | Response |
| --- | --- | --- |
| `POST /api/uploads` | `{ filename, contentType }` | `{ key, uploadId }` |
| `POST /api/uploads/sign-part` | `{ key, uploadId, partNumber }` | `{ url }` (presigned PUT URL, 1-hour expiry) |
| `POST /api/uploads/complete` | `{ key, uploadId, parts: [{ PartNumber, ETag }] }` | `{ location, key }` |
| `POST /api/uploads/abort` | `{ key, uploadId }` | `{ ok: true }` |
| `POST /api/uploads/list-parts` | `{ key, uploadId }` | `{ parts: [{ PartNumber, ETag, Size }] }` |

Disabled uploads return `403 { "error": "Uploads are currently disabled" }`.

## Constraints / notes

- **`aws4fetch` only** — signing is done with `aws4fetch` (SigV4); the AWS SDK is
  never bundled into the Worker.
- **No R2 object tagging** — R2 does not support `x-amz-tagging`, so no tagging
  header is ever sent.
- **Secrets stay in the Worker** — R2 credentials are Worker secrets used only
  for signing; the browser only ever receives opaque presigned URLs.
- **Part size is a client concern** — the Worker does not enforce a part size;
  chunking is Uppy's responsibility.
- **CORS is currently open** — the Worker's own response CORS is `*` (needed for
  cross-origin dev). TODO: lock it down to the frontend origin. This is separate
  from the R2 bucket CORS above, which you must still configure.
