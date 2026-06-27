import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Reset browser default margins/paddings globally
const style = document.createElement('style');
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body { background: #f9fafb; }
`;
document.head.appendChild(style);

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
