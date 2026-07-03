import { useState } from 'react';
import Uppy from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';
import Dashboard from '@uppy/react/dashboard';

import '@uppy/dashboard/css/style.css';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

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

export function App() {
	const [uppy] = useState(() =>
		new Uppy().use(AwsS3, {
			shouldUseMultipart: () => true,

			createMultipartUpload: (file) =>
				apiPost('/api/uploads', {
					filename: file.name,
					contentType: file.type,
				}),

			signPart: (file, { key, uploadId, partNumber }) =>
				apiPost('/api/uploads/sign-part', { key, uploadId, partNumber }),

			listParts: (file, { key, uploadId }) =>
				apiPost('/api/uploads/list-parts', { key, uploadId }).then(
					(r) => r.parts,
				),

			completeMultipartUpload: (file, { key, uploadId, parts }) =>
				apiPost('/api/uploads/complete', { key, uploadId, parts }),

			abortMultipartUpload: (file, { key, uploadId }) =>
				apiPost('/api/uploads/abort', { key, uploadId }),
		}),
	);

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
