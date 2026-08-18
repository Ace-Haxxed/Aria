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

// Credentials are read before the first render. Rust already holds them in
// memory from startup, so this is one IPC round trip — and it means no part of
// the UI has to handle "keys not loaded yet", and sending the first message
// never blocks on finding out which provider is active.
void useKeys
  .getState()
  .load()
  .finally(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
