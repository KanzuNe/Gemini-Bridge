import { Suspense, StrictMode, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'

// eslint-disable-next-line react-refresh/only-export-components
const LogsPage = lazy(() => import('./LogsPage.tsx'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Suspense fallback={<div className="route-loading">Loading...</div>}>
          <Routes>
            <Route element={<App />} path="/" />
            <Route element={<LogsPage />} path="/logs" />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
)
