import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { OverlayRoot } from './overlay/OverlayRoot';
import { AppProvider } from './state/app-store';
import { PreviewProvider } from './audio/preview-context';
import { PerformanceProvider } from './performance/performance-context';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1';
if (isOverlay) {
  document.documentElement.classList.add('overlay-mode');
  createRoot(container).render(<OverlayRoot />);
} else {
  createRoot(container).render(
    <StrictMode>
      <AppProvider>
        <PreviewProvider>
          <PerformanceProvider>
            <App />
          </PerformanceProvider>
        </PreviewProvider>
      </AppProvider>
    </StrictMode>,
  );
}
