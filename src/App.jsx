import { useState } from 'react';
import Uppy from '@uppy/core';
import Dashboard from '@uppy/react/dashboard';

import '@uppy/dashboard/css/style.css';
import './index.css';

export function App() {
	const [uppy] = useState(() => new Uppy());

	return (
		<main>
			<Dashboard
				uppy={uppy}
				theme="dark"
				width="100%"
				height={550}
				hideUploadButton={true}
				showProgressDetails={true}
				singleFileFullScreen={false}
			/>
		</main>
	);
}

export default App;
