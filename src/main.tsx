import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './narration-preferences';
import './account-password';
import './styles.css';
import './reader-overrides.css';
import './app-overrides.css';
import './mobile-library.css';
import './library-experience.css';
import './markdown-description.css';
import './cover-polish.css';
import './library-responsive.css';
import './audio-dock-fix.css';
import './account-password.css';
import './sidebar-fixed.css';
import './epub-replace-modal.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
