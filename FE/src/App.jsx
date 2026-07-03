import { useState } from 'react';
import Uppy from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import Dashboard from '@uppy/react/dashboard';

import '@uppy/dashboard/css/style.css';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// Larger parts → fewer parts → fewer sign requests. 50MB honors the existing
// server-side convention and keeps part counts low for multi-GB files.
const PART_SIZE = 50 * 1024 * 1024;

// How many parts to presign per batch request. One /sign-parts POST covers a
// window of this many parts; the rest are served from the client cache. This is
// the main lever against Cloudflare rate-limiting sign requests.
const SIGN_BATCH_SIZE = 100;

async function apiPost(path, body) {
	const res = await fetch(`${API_BASE}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`${path} failed: ${res.status} ${detail}`);
	}
	return res.json();
}

// Per-upload cache of batch presign promises, keyed by uploadId then by batch
// window index. Uppy signs parts lazily and concurrently; caching the in-flight
// promise (not just the result) dedupes the many concurrent signPart calls that
// fall in the same window down to a single /sign-parts POST.
function createSignCache() {
	const byUpload = new Map(); // uploadId -> Map<batchIndex, Promise<{[partNumber]: url}>>

	return function signPartCached(key, uploadId, partNumber) {
		let batches = byUpload.get(uploadId);
		if (!batches) {
			batches = new Map();
			byUpload.set(uploadId, batches);
		}

		const batchIndex = Math.floor((partNumber - 1) / SIGN_BATCH_SIZE);
		let batch = batches.get(batchIndex);
		if (!batch) {
			const first = batchIndex * SIGN_BATCH_SIZE + 1;
			const partNumbers = Array.from({ length: SIGN_BATCH_SIZE }, (_, i) => first + i);
			batch = apiPost('/api/uploads/sign-parts', { key, uploadId, partNumbers }).then(
				(r) => r.urls,
			);
			batches.set(batchIndex, batch);
		}

		return batch.then((urls) => ({ url: urls[partNumber] }));
	};
}

export function App() {
	const [uppy] = useState(() => {
		const signPartCached = createSignCache();

		return new Uppy().use(AwsS3, {
			shouldUseMultipart: () => true,
			getChunkSize: () => PART_SIZE,

			createMultipartUpload: (file) =>
				apiPost('/api/uploads', {
					filename: file.name,
					contentType: file.type,
				}),

			signPart: (file, { key, uploadId, partNumber }) =>
				signPartCached(key, uploadId, partNumber),

			listParts: (file, { key, uploadId }) =>
				apiPost('/api/uploads/list-parts', { key, uploadId }).then(
					(r) => r.parts,
				),

			completeMultipartUpload: (file, { key, uploadId, parts }) =>
				apiPost('/api/uploads/complete', { key, uploadId, parts }),

			abortMultipartUpload: (file, { key, uploadId }) =>
				apiPost('/api/uploads/abort', { key, uploadId }),
		});
	});

	return (
		<main>
			<Dashboard
				uppy={uppy}
				theme="dark"
				width="100%"
				height={550}
				showProgressDetails={true}
				singleFileFullScreen={false}
			/>
		</main>
	);
}

export default App;
