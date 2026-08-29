import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// Installed before App so the buffer catches everything the app logs while it
// mounts, which is exactly where connection and auth failures show up.
import { installConsoleInterceptor } from './utils/logger';
import App from './App';
import reportWebVitals from './reportWebVitals';

installConsoleInterceptor();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
