import { useState } from 'react';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import Dashboard from '@uppy/react/dashboard';

import '@uppy/dashboard/css/style.css';
import './index.css';

export function App() {
	const [uppy] = useState(() =>
		new Uppy().use(Tus, {
			endpoint: 'https://tusd.bfportal.gg/files/',
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
