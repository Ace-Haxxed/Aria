import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useKeys } from './store/keys';

// Bundled rather than fetched from a CDN: the CSP allows fonts only from
// 'self', and ARIA has to look right with no internet at all.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

import './styles/globals.css';
// Styles resolve a frame or two after the document appears. Without this the
// window plays every entrance transition at once as they land, which looks
// like a fault rather than an animation.
document.documentElement.classList.add('aria-booting');
requestAnimationFrame(() =>
  requestAnimationFrame(() => document.documentElement.classList.remove('aria-booting')),
);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// ARIA is dark-theme only; the class is set in index.html but re-asserted
// here so a hot reload cannot drop it.
document.documentElement.classList.add('dark');

/**
 * Read credentials before the first render, but never wait forever for them.
 *
 * On the desktop this is one IPC round trip against a config Rust already
 * holds in memory, so the wait is invisible and it means no part of the UI has
 * to handle "keys not loaded yet".
 *
 * On a phone it is a call into the Capacitor bridge, which is not necessarily
 * up yet during a cold start. Gating the render on it unconditionally is how
 * this shipped a black screen: the plugin call never settled, so `finally`
 * never ran and nothing was ever mounted. Rendering is now racing a deadline —
 * whichever comes first, the app appears, and the store fills in behind it.
 */
const KEYS_RENDER_DEADLINE_MS = 1_500;

/**
 * Show a render failure instead of a black screen.
 *
 * On a phone there are no devtools and no console, so an exception during the
 * first render is indistinguishable from a hung app, a bad build, or a dead
 * install — all of which look like a black rectangle. This turns that into
 * something readable and reportable.
 */
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          padding: '24px',
          font: '13px/1.5 ui-monospace, monospace',
          color: '#e6edf3',
          background: '#05080d',
          minHeight: '100vh',
          overflowWrap: 'anywhere',
        }}
      >
        <h1 style={{ fontSize: '15px', marginBottom: '12px' }}>ARIA failed to start</h1>
        <p style={{ opacity: 0.75, marginBottom: '12px' }}>{String(error.message || error)}</p>
        <pre style={{ opacity: 0.5, fontSize: '11px', whiteSpace: 'pre-wrap' }}>
          {error.stack?.slice(0, 1500)}
        </pre>
      </div>
    );
  }
}

function mount() {
  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      <Boundary>
        <App />
      </Boundary>
    </React.StrictMode>,
  );
}

let mounted = false;
const mountOnce = () => {
  if (mounted) return;
  mounted = true;
  mount();
};

void Promise.race([
  useKeys.getState().load(),
  new Promise((resolve) => setTimeout(resolve, KEYS_RENDER_DEADLINE_MS)),
]).finally(mountOnce);

// A belt-and-braces guard: if the race itself somehow cannot settle, the app
// still has to appear. A blank window is the one outcome with no way back.
setTimeout(mountOnce, KEYS_RENDER_DEADLINE_MS * 2);
