import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './login.css';
import './meeting.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await registration.update();
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
