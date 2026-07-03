import { AwsClient } from "aws4fetch";

// ─────────────────────────────────────────────────────────────────────────────
// yeet — signs R2 multipart uploads so file bytes go browser → R2 directly, and
// serves the SPA static assets. All signing uses aws4fetch (SigV4); we never
// pull in the AWS SDK.
//
// Two distinct signing paths are used below:
//   • Presigned URL (sign-part): aws.signQuery = true → SigV4 is baked into the
//     query string; the URL is handed to the browser, which PUTs bytes directly.
//   • Signed request (create / complete / abort / list): client.fetch(...) signs
//     an Authorization header and the Worker itself makes the S3 call.
//
// IMPORTANT: R2 does NOT support S3 object tagging. Never send `x-amz-tagging`
// (or any tagging header) — doing so breaks the request. We deliberately send no
// tagging headers anywhere in this file.
//
// The 50MB minimum part-size convention is now a CLIENT (Uppy) concern — the
// server does not enforce a part size.
// ─────────────────────────────────────────────────────────────────────────────

interface Env {
  ASSETS: Fetcher;
  YEET: KVNamespace;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

const PART_URL_EXPIRY_SECONDS = 3600; // 1 hour — generous slack for slow links
// & queued parts (Uppy signs each part lazily, so this bounds per-part start time)

// CORS: in production the SPA and /api are same-origin (one Worker), so this is
// mostly unnecessary. It exists for local dev (Vite :5173 → wrangler :8787).
// TODO: lock down to the FE origin.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function endpoint(env: Env): string {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function s3Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

// Build the object URL for a key, encoding each path segment.
function objectUrl(env: Env, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint(env)}/${env.R2_BUCKET}/${encodedKey}`;
}

// Sanitize a user-supplied filename: strip path separators, "..", control
// chars, and leading slashes/dots. Fall back to a uuid if nothing remains.
function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== "string") return crypto.randomUUID();
  let name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "") // control chars
    .replace(/[\\/]/g, "") // path separators
    .replace(/\.\./g, "") // parent-dir traversal
    .replace(/^[.\s]+/, ""); // leading dots / whitespace
  name = name.trim();
  return name.length > 0 ? name : crypto.randomUUID();
}

// Minimal XML escaping for values placed into request bodies. Keys are
// uuid + sanitized filename, but we escape defensively regardless.
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Extract the first occurrence of a tag's text content from an XML string.
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

// ── /api/uploads — CreateMultipartUpload ─────────────────────────────────────
async function createUpload(request: Request, env: Env): Promise<Response> {
  const { filename, contentType } = (await request.json()) as {
    filename?: unknown;
    contentType?: unknown;
  };

  const safeName = sanitizeFilename(filename);
  const key = `public-uploads/${crypto.randomUUID()}/${safeName}`;

  const client = s3Client(env);
  const url = `${objectUrl(env, key)}?uploads`;
  const headers: Record<string, string> = {};
  if (typeof contentType === "string" && contentType.length > 0) {
    // Set on create so the stored object ends up with the correct Content-Type.
    headers["Content-Type"] = contentType;
  }

  const res = await client.fetch(url, { method: "POST", headers });
  if (!res.ok) {
    return json({ error: "Failed to create upload", detail: await res.text() }, 502);
  }

  const xml = await res.text();
  const uploadId = extractTag(xml, "UploadId");
  if (!uploadId) {
    return json({ error: "Missing UploadId in R2 response" }, 502);
  }

  return json({ key, uploadId });
}

// Presign a single UploadPart PUT. Pure local crypto (aws4fetch computes the
// SigV4 into the query string) — NO network call — so signing many parts in one
// request is cheap. This is the shared core of both sign endpoints below.
async function presignPart(
  client: AwsClient,
  env: Env,
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const url = new URL(
    `${objectUrl(env, key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
  );
  // Expiry MUST go in the query string, not a header: with signQuery, aws4fetch
  // reads X-Amz-Expires from url.searchParams (falling back to a 24h default if
  // absent) and never from headers. Setting it here keeps our chosen expiry AND
  // keeps `host` as the only signed header — a stray X-Amz-Expires *header* would
  // otherwise be added to X-Amz-SignedHeaders, which the browser's PUT can't
  // satisfy (→ SignatureDoesNotMatch).
  url.searchParams.set("X-Amz-Expires", String(PART_URL_EXPIRY_SECONDS));

  // The Request carries NO Content-Type header, so aws4fetch signs only `host`.
  // This is deliberate: if Content-Type were signed, the browser's own PUT
  // Content-Type header would not match and would invalidate the signature.
  const signed = await client.sign(
    new Request(url.toString(), { method: "PUT" }),
    { aws: { signQuery: true } }, // presigned: SigV4 goes into the query string
  );
  return signed.url;
}

// ── /api/uploads/sign-part — presigned PUT URL for a single UploadPart ───────
// Kept for compatibility / single-part paths; batch clients use /sign-parts.
async function signPart(request: Request, env: Env): Promise<Response> {
  const { key, uploadId, partNumber } = (await request.json()) as {
    key?: unknown;
    uploadId?: unknown;
    partNumber?: unknown;
  };

  if (typeof key !== "string" || typeof uploadId !== "string" || typeof partNumber !== "number") {
    return json({ error: "key, uploadId and partNumber are required" }, 400);
  }

  const url = await presignPart(s3Client(env), env, key, uploadId, partNumber);
  return json({ url });
}

// ── /api/uploads/sign-parts — batch presign to cut inbound request volume ────
// Uppy signs each part lazily, one POST per part. For a large file that is
// hundreds of near-identical POSTs to one path in seconds, which trips
// Cloudflare rate limiting. Since presigning is local (no subrequest), we sign
// a whole window of parts in ONE request; the client caches the results.
// Defensive cap on how many parts a SINGLE /sign-parts request may ask for — a
// request-size guard, NOT the per-upload part limit (that is 10,000 parts per
// uploadId, scoped to one multipart upload and independent across concurrent
// uploads). The client's SIGN_BATCH_SIZE (100) stays well under this.
const MAX_PARTS_PER_BATCH = 1000;

async function signParts(request: Request, env: Env): Promise<Response> {
  const { key, uploadId, partNumbers } = (await request.json()) as {
    key?: unknown;
    uploadId?: unknown;
    partNumbers?: unknown;
  };

  if (
    typeof key !== "string" ||
    typeof uploadId !== "string" ||
    !Array.isArray(partNumbers) ||
    partNumbers.length === 0 ||
    partNumbers.length > MAX_PARTS_PER_BATCH ||
    !partNumbers.every((n) => Number.isInteger(n) && (n as number) >= 1)
  ) {
    return json(
      { error: `key, uploadId and partNumbers[] (1..${MAX_PARTS_PER_BATCH}, each ≥ 1) are required` },
      400,
    );
  }

  const client = s3Client(env);
  const entries = await Promise.all(
    (partNumbers as number[]).map(
      async (n) => [n, await presignPart(client, env, key, uploadId, n)] as const,
    ),
  );

  // { [partNumber]: url } — the client keys its cache by part number.
  return json({ urls: Object.fromEntries(entries) });
}

// ── /api/uploads/complete — CompleteMultipartUpload ──────────────────────────
async function completeUpload(request: Request, env: Env): Promise<Response> {
  const { key, uploadId, parts } = (await request.json()) as {
    key?: unknown;
    uploadId?: unknown;
    parts?: Array<{ PartNumber?: unknown; ETag?: unknown }>;
  };

  if (typeof key !== "string" || typeof uploadId !== "string" || !Array.isArray(parts)) {
    return json({ error: "key, uploadId and parts are required" }, 400);
  }

  // Sort ascending by PartNumber. CompleteMultipartUpload requires ordered parts.
  const sorted = [...parts].sort(
    (a, b) => Number(a.PartNumber) - Number(b.PartNumber),
  );

  const partsXml = sorted
    .map((p) => {
      // CRITICAL: preserve the ETag EXACTLY as received, including its
      // surrounding double-quotes. Stripping the quotes causes InvalidPart.
      const etag = String(p.ETag);
      return `<Part><PartNumber>${Number(p.PartNumber)}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`;
    })
    .join("");

  const body = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const client = s3Client(env);
  const url = `${objectUrl(env, key)}?uploadId=${encodeURIComponent(uploadId)}`;

  const res = await client.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body,
  });

  if (!res.ok) {
    return json({ error: "Failed to complete upload", detail: await res.text() }, 502);
  }

  return json({ location: objectUrl(env, key), key });
}

// ── /api/uploads/abort — AbortMultipartUpload ────────────────────────────────
async function abortUpload(request: Request, env: Env): Promise<Response> {
  const { key, uploadId } = (await request.json()) as {
    key?: unknown;
    uploadId?: unknown;
  };

  if (typeof key !== "string" || typeof uploadId !== "string") {
    return json({ error: "key and uploadId are required" }, 400);
  }

  const client = s3Client(env);
  const url = `${objectUrl(env, key)}?uploadId=${encodeURIComponent(uploadId)}`;

  const res = await client.fetch(url, { method: "DELETE" });
  if (!res.ok) {
    return json({ error: "Failed to abort upload", detail: await res.text() }, 502);
  }

  return json({ ok: true });
}

// ── /api/uploads/list-parts — ListParts (used by Uppy to resume) ─────────────
async function listParts(request: Request, env: Env): Promise<Response> {
  const { key, uploadId } = (await request.json()) as {
    key?: unknown;
    uploadId?: unknown;
  };

  if (typeof key !== "string" || typeof uploadId !== "string") {
    return json({ error: "key and uploadId are required" }, 400);
  }

  const client = s3Client(env);
  const url = `${objectUrl(env, key)}?uploadId=${encodeURIComponent(uploadId)}`;

  const res = await client.fetch(url, { method: "GET" });
  if (!res.ok) {
    return json({ error: "Failed to list parts", detail: await res.text() }, 502);
  }

  const xml = await res.text();
  const parts: Array<{ PartNumber: number; ETag: string; Size: number }> = [];
  const partRegex = /<Part>([\s\S]*?)<\/Part>/g;
  let match: RegExpExecArray | null;
  while ((match = partRegex.exec(xml)) !== null) {
    const block = match[1];
    const partNumber = extractTag(block, "PartNumber");
    const etag = extractTag(block, "ETag");
    const size = extractTag(block, "Size");
    if (partNumber && etag) {
      parts.push({
        PartNumber: Number(partNumber),
        ETag: etag, // keep quotes as returned
        Size: size ? Number(size) : 0,
      });
    }
  }

  return json({ parts });
}

// ── Router ───────────────────────────────────────────────────────────────────
async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  // KV gate: every /api/uploads* handler is behind the YEET kill switch.
  if (pathname.startsWith("/api/uploads")) {
    const enabled = await env.YEET.get("uploads:enabled");
    if (enabled !== "true") {
      return json({ error: "Uploads are currently disabled" }, 403);
    }
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  switch (pathname) {
    case "/api/uploads":
      return createUpload(request, env);
    case "/api/uploads/sign-part":
      return signPart(request, env);
    case "/api/uploads/sign-parts":
      return signParts(request, env);
    case "/api/uploads/complete":
      return completeUpload(request, env);
    case "/api/uploads/abort":
      return abortUpload(request, env);
    case "/api/uploads/list-parts":
      return listParts(request, env);
    default:
      return json({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight (for local dev cross-origin requests).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        return json({ error: "Internal error", detail: String(err) }, 500);
      }
    }

    // Everything else: serve the SPA static assets.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
