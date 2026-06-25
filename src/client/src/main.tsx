import { createRoot } from 'react-dom/client';
import { App } from './App';

// Bootstrap only. All UI lives in ./App so that editing it during `pnpm dev`
// goes through React Fast Refresh (in-place hot-swap) instead of a full page
// reload — which would tear down the live terminal sockets. Keep this file
// component-free so it almost never needs editing.
createRoot(document.getElementById('root')!).render(<App />);
