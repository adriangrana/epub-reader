import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './reader-overrides.css';
import './app-overrides.css';
import './mobile-library.css';
import './library-experience.css';
import './markdown-description.css';
import './cover-polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
