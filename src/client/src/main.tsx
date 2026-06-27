import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfirmProvider } from './Confirm';
import { initTheme } from './themes';

// Bootstrap only. All UI lives in ./App so that editing it during `pnpm dev`
// goes through React Fast Refresh (in-place hot-swap) instead of a full page
// reload — which would tear down the live terminal sockets. Keep this file
// component-free so it almost never needs editing.

// Apply the saved theme (and wire the live system light/dark listener) before
// the first React paint so there's no flash of the default colors.
initTheme();

createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <App />
  </ConfirmProvider>,
);
