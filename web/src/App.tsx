import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  Copy,
  Cookie,
  Link2,
  Network,
  PlayCircle,
  RefreshCw,
  Save,
  Server,
  Square,
  TerminalSquare,
  Trash2,
  Zap,
} from 'lucide-react'
import './App.css'
import { copyText } from './clipboard'
import { useI18n, LanguageToggle, type Language } from './i18n'
import type { TranslationDictionary } from './i18n/en'

type CookieInspection = {
  status: 'missing' | 'valid' | 'expiring' | 'expired'
  checkedAt: string
  expiresAt: string | null
  requiredMissing: string[]
  totalCookies: number
  expiringSoon: boolean
}

type StatusResponse = {
  service: 'running' | 'stopped'
  uptimeMs: number
  requestCount: number
  errorCount: number
  lastRequestAt: string | null
  proxy: string | null
  effectiveProxy: string | null
  defaultModel: string
  anchor: AnchorStatus
  cookieInspection: CookieInspection
  cookieFilePath: string
  lastInitError: string | null
  listenHost: string
  listenPort: number
  localUrl: string
  lanUrls: string[]
  preferredUrl: string
  traffic: TrafficSnapshot
}

type TrafficAggregate = {
  requests: number
  successCount: number
  errorCount: number
  streamCount: number
  requestBytes: number
  responseBytes: number
  totalBytes: number
  promptTokens: number
  completionTokens: number
  averageLatencyMs: number
  requestsPerMinute: number
  bytesPerMinute: number
  lastRequestAt: string | null
}

type TrafficModelStat = TrafficAggregate & {
  model: string
}

type TrafficSnapshot = {
  startedAt: string | null
  recentWindowMinutes: number
  inFlight: number
  lifetime: TrafficAggregate
  recentWindow: TrafficAggregate
  topModels: TrafficModelStat[]
}

type ModelsResponse = {
  models: string[]
  defaultModel: string
}

type AnchorStatus = {
  url: string | null
  sourcePath: string | null
  conversationId: string | null
  enabled: boolean
  valid: boolean
  error: string | null
}

type LogEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
}

type Banner = {
  tone: 'success' | 'error' | 'info'
  text: string
}

type CookiesResponse = {
  raw: string
}

async function requestJson<T>(url: string, init?: RequestInit, t?: TranslationDictionary): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(data.error?.message ?? `${t?.requestFailed ?? 'Request failed: '}${response.status}`)
  }

  return (await response.json()) as T
}

function formatDate(value: string | null, lang: Language, emptyText: string): string {
  if (!value) return emptyText

  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDuration(ms: number, t: TranslationDictionary): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} ${t.sec}`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${t.min} ${seconds % 60} ${t.sec}`

  const hours = Math.floor(minutes / 60)
  return `${hours} ${t.hour} ${minutes % 60} ${t.min}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatRate(value: number, perMinuteText: string): string {
  return `${value.toFixed(2)}${perMinuteText}`
}

function cookieStatusLabel(status: CookieInspection['status'] | undefined, t: TranslationDictionary) {
  if (!status) return t.statusPending
  if (status === 'valid') return t.statusHealthy
  if (status === 'expiring') return t.statusExpiring
  if (status === 'expired') return t.statusExpired
  return t.statusMissing
}

function logLevelLabel(level: LogEntry['level'], t: TranslationDictionary) {
  if (level === 'info') return t.logInfo
  if (level === 'warn') return t.logWarn
  if (level === 'error') return t.logError
  return t.logDebug
}

function mergeLogs(current: LogEntry[], incoming: LogEntry[]) {
  const map = new Map(current.map((entry) => [entry.id, entry]))
  incoming.forEach((entry) => {
    map.set(entry.id, entry)
  })

  return [...map.values()]
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .slice(-200)
}

function buildApiBase(url: string): string {
  return new URL('/v1', `${url}/`).toString()
}

export default function App() {
  const { t, lang } = useI18n()

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [modelDirty, setModelDirty] = useState(false)
  const [cookieText, setCookieText] = useState('')
  const [cookieDirty, setCookieDirty] = useState(false)
  const [proxyInput, setProxyInput] = useState('')
  const [proxyDirty, setProxyDirty] = useState(false)
  const [anchorInput, setAnchorInput] = useState('')
  const [anchorDirty, setAnchorDirty] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const reconnectTimer = useRef<number | null>(null)

  const browserApiBase = new URL('/v1', window.location.origin).toString()
  const localApiBase = status?.localUrl ? buildApiBase(status.localUrl) : browserApiBase
  const lanApiBases = (status?.lanUrls ?? []).map((url) => buildApiBase(url))
  const copyableApiBase = lanApiBases.length > 0 ? lanApiBases.join('\n') : localApiBase
  const traffic = status?.traffic
  const lifetimeTraffic = traffic?.lifetime
  const recentTraffic = traffic?.recentWindow
  const successRate =
    lifetimeTraffic && lifetimeTraffic.requests > 0
      ? (lifetimeTraffic.successCount / lifetimeTraffic.requests) * 100
      : 0
  const isBusy = busyAction !== null
  const serviceLabel = status?.service === 'running' ? t.running : t.stopped
  const cookieLabel = cookieStatusLabel(status?.cookieInspection.status, t)
  const missingCookies = status?.cookieInspection.requiredMissing.length
    ? status.cookieInspection.requiredMissing.join(', ')
    : t.none

  const clearReconnectTimer = () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }

  const loadStatus = useCallback(
    async (syncProxy = false) => {
      const next = await requestJson<StatusResponse>('/admin/status', undefined, t)
      setStatus(next)

      if (syncProxy || !proxyDirty) {
        setProxyInput(next.proxy ?? '')
      }

      if (!anchorDirty) {
        setAnchorInput(next.anchor.url ?? '')
      }

      if (!modelDirty) {
        setDefaultModel(next.defaultModel)
      }
    },
    [anchorDirty, modelDirty, proxyDirty, t],
  )

  const loadModels = useCallback(
    async (forceSync = false) => {
      const next = await requestJson<ModelsResponse>('/admin/models', undefined, t)
      setModels(next.models)

      if (forceSync || !modelDirty) {
        setDefaultModel(next.defaultModel)
      }
    },
    [modelDirty, t],
  )

  const loadCookies = useCallback(
    async (forceSync = false) => {
      const next = await requestJson<CookiesResponse>('/admin/cookies', undefined, t)
      if (forceSync || !cookieDirty) {
        setCookieText(next.raw)
      }
    },
    [cookieDirty, t],
  )

  const loadLogs = useCallback(async () => {
    const next = await requestJson<{ logs: LogEntry[] }>('/admin/logs?lines=200', undefined, t)
    setLogs((current) => mergeLogs(current, next.logs))
  }, [t])

  const loadInitialData = useCallback(async () => {
    await Promise.all([loadStatus(true), loadModels(true), loadCookies(true), loadLogs()])
  }, [loadCookies, loadLogs, loadModels, loadStatus])

  const refreshDashboard = useCallback(async () => {
    await Promise.all([loadStatus(), loadLogs()])
  }, [loadLogs, loadStatus])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitialData().catch((error: Error) => {
      setBanner({ tone: 'error', text: error.message })
    })

    const interval = window.setInterval(() => {
      void refreshDashboard().catch(() => undefined)
    }, 15000)

    return () => window.clearInterval(interval)
  }, [loadInitialData, refreshDashboard])

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null

    const connect = () => {
      if (cancelled) return

      source = new EventSource('/admin/logs/stream')

      source.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as LogEntry
          setLogs((current) => mergeLogs(current, [next]))
        } catch {
          // ignore malformed event
        }
      }

      source.onerror = () => {
        source?.close()
        clearReconnectTimer()

        if (!cancelled) {
          reconnectTimer.current = window.setTimeout(() => {
            connect()
          }, 2500)
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      source?.close()
      clearReconnectTimer()
    }
  }, [])

  const runAction = async (successText: string, handler: () => Promise<void>, fallbackError?: string) => {
    setBusyAction(successText)
    setBanner(null)

    try {
      await handler()
      setBanner({ tone: 'success', text: successText })
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : fallbackError ?? t.failed,
      })
    } finally {
      setBusyAction(null)
    }
  }

  const saveCookies = async () => {
    await runAction(
      t.cookiesSaved,
      async () => {
        const next = await requestJson<CookiesResponse>('/admin/cookies', {
          method: 'POST',
          body: JSON.stringify({ raw: cookieText }),
        }, t)
        setCookieText(next.raw)
        setCookieDirty(false)
        await loadStatus(true)
      },
      t.saveCookiesFailed,
    )
  }

  const saveDefaultModel = async () => {
    if (!defaultModel) {
      setBanner({ tone: 'error', text: t.selectModelFirst })
      return
    }

    await runAction(
      t.modelSaved,
      async () => {
        const next = await requestJson<{ defaultModel: string }>('/admin/models', {
          method: 'POST',
          body: JSON.stringify({ defaultModel }),
        }, t)
        setDefaultModel(next.defaultModel)
        setModelDirty(false)
        await Promise.all([loadStatus(), loadModels(true)])
      },
      t.saveModelFailed,
    )
  }

  const saveProxy = async () => {
    await runAction(
      t.proxySaved,
      async () => {
        await requestJson('/admin/proxy', {
          method: 'POST',
          body: JSON.stringify({ proxy: proxyInput.trim() || null }),
        }, t)
        setProxyDirty(false)
        await loadStatus(true)
      },
      t.saveProxyFailed,
    )
  }

  const saveAnchor = async () => {
    await runAction(
      t.anchorSaved,
      async () => {
        await requestJson('/admin/anchor', {
          method: 'POST',
          body: JSON.stringify({ url: anchorInput.trim() || null }),
        }, t)
        setAnchorDirty(false)
        await loadStatus()
      },
      t.saveAnchorFailed,
    )
  }

  const controlService = async (action: 'start' | 'stop' | 'restart') => {
    const successText =
      action === 'start' ? t.serviceStarted : action === 'stop' ? t.serviceStopped : t.serviceRestarted

    await runAction(
      successText,
      async () => {
        await requestJson('/admin/service', {
          method: 'POST',
          body: JSON.stringify({ action }),
        }, t)
        await refreshDashboard()
      },
      t.serviceActionFailed,
    )
  }

  const copyEndpoint = async () => {
    try {
      const copied = await copyText(copyableApiBase)
      if (!copied) {
        throw new Error(t.copyFailed)
      }
      setBanner({ tone: 'info', text: lanApiBases.length > 0 ? t.lanEndpointCopied : t.endpointCopied })
    } catch {
      setBanner({ tone: 'error', text: t.copyFailed })
    }
  }

  const handleTest = async () => {
    setBusyAction(t.testing)
    setBanner(null)

    try {
      const result = await requestJson<{ ok: boolean; model: string; latencyMs: number; content: string }>(
        '/admin/test',
        { method: 'POST' },
        t,
      )
      setBanner({
        tone: 'success',
        text: t.testPassed(result.model, result.latencyMs, result.content),
      })
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : t.testFailed,
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleClearHistory = async () => {
    if (!window.confirm(t.clearHistoryConfirm)) return

    await runAction(
      t.historyCleared,
      async () => {
        await requestJson('/admin/data/reset', { method: 'POST' }, t)
        await refreshDashboard()
      },
      t.clearHistoryFailed,
    )
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        {t.skipToMain}
      </a>

      <main className="page-shell app-shell" id="main-content">
        <header className="page-header">
          <div className="header-copy">
            <div className="eyebrow">{t.eyebrow}</div>
            <h1>{t.appTitle}</h1>
            <p>{t.appSubtitle}</p>
          </div>

          <div className="header-actions">
            <LanguageToggle />

            <button className="primary-button" disabled={isBusy} onClick={() => void handleTest()} type="button">
              <Zap size={16} />
              {t.testConnection}
            </button>

            <button className="soft-button" onClick={() => void loadInitialData()} type="button">
              <RefreshCw size={16} />
              {t.refresh}
            </button>

            <button className="soft-button" onClick={() => void copyEndpoint()} type="button">
              <Copy size={16} />
              {t.copyEndpoint}
            </button>

            <Link className="soft-link" to="/logs">
              {t.conversationLogs}
            </Link>
          </div>
        </header>

        {banner ? (
          <div
            aria-live="polite"
            className={`banner ${banner.tone}`}
            role={banner.tone === 'error' ? 'alert' : 'status'}
          >
            {banner.text}
          </div>
        ) : null}

        <section className="summary-strip">
          <div className="summary-item">
            <span className="summary-label">{t.serviceStatus}</span>
            <strong>{serviceLabel}</strong>
            <span className="summary-text">{status ? formatDuration(status.uptimeMs, t) : t.loadingStatus}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">{t.cookieStatus}</span>
            <strong>{cookieLabel}</strong>
            <span className="summary-text">
              {missingCookies === t.none ? t.allRequiredPresent : `${t.missingCookiesPrefix}${missingCookies}`}
            </span>
          </div>
          <div className="summary-item summary-item-wide">
            <span className="summary-label">{t.apiEndpoint}</span>
            <strong>/v1</strong>
            <span className="summary-text">{t.localPrefix}{localApiBase}</span>
            <span className="summary-text">
              {lanApiBases.length > 0 ? `${t.lanPrefix}${lanApiBases.join(' / ')}` : t.lanLocalOnly}
            </span>
          </div>
        </section>

        <section className="content-stack">
          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <Server size={18} />
                <h2>{t.serviceControl}</h2>
              </div>
              <span className="status-pill">{serviceLabel}</span>
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="default-model">
                {t.defaultModel}
              </label>
              <div className="inline-form">
                <select
                  className="text-input select-input"
                  id="default-model"
                  onChange={(event) => {
                    setDefaultModel(event.target.value)
                    setModelDirty(true)
                  }}
                  value={defaultModel}
                >
                  <option disabled value="">
                    {models.length === 0 ? t.loadingModels : t.selectDefaultModel}
                  </option>
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>

                <button
                  className="primary-button"
                  disabled={isBusy || models.length === 0 || !defaultModel || !modelDirty}
                  onClick={() => void saveDefaultModel()}
                  type="button"
                >
                  <Save size={16} />
                  {t.saveModel}
                </button>
              </div>
              <p className="field-help">{t.modelHelp}</p>
            </div>

            <div className="mini-list">
              <div>
                <span>{t.lastRequest}</span>
                <strong>{formatDate(status?.lastRequestAt ?? null, lang, t.noRecord)}</strong>
              </div>
              <div>
                <span>{t.requestsAndErrors}</span>
                <strong>
                  {status?.requestCount ?? 0} / {status?.errorCount ?? 0}
                </strong>
              </div>
            </div>

            <div className="action-row">
              <button className="primary-button" disabled={isBusy} onClick={() => void controlService('start')} type="button">
                <PlayCircle size={16} />
                {t.start}
              </button>
              <button className="soft-button" disabled={isBusy} onClick={() => void controlService('restart')} type="button">
                <RefreshCw size={16} />
                {t.restart}
              </button>
              <button className="soft-button" disabled={isBusy} onClick={() => void controlService('stop')} type="button">
                <Square size={16} />
                {t.stop}
              </button>
            </div>

            {status?.lastInitError ? (
              <div className="error-box">{t.initErrorPrefix}{status.lastInitError}</div>
            ) : null}
          </article>

          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <Activity size={18} />
                <h2>{t.trafficAnalytics}</h2>
              </div>
              <span className="status-pill">{traffic ? t.inFlightBadge(traffic.inFlight) : t.statsLoading}</span>
            </div>

            <div className="mini-list traffic-grid">
              <div>
                <span>{t.totalRequests}</span>
                <strong>{lifetimeTraffic?.requests ?? 0}</strong>
                <span>{t.recentRequestPrefix}{formatDate(lifetimeTraffic?.lastRequestAt ?? null, lang, t.noRecord)}</span>
              </div>
              <div>
                <span>{t.successRateLatency}</span>
                <strong>{formatPercent(successRate)}</strong>
                <span>{lifetimeTraffic?.averageLatencyMs ?? 0} ms</span>
              </div>
              <div>
                <span>{t.totalDataTransfer}</span>
                <strong>{formatBytes(lifetimeTraffic?.totalBytes ?? 0)}</strong>
                <span>
                  {t.inboundOutbound(
                    formatBytes(lifetimeTraffic?.requestBytes ?? 0),
                    formatBytes(lifetimeTraffic?.responseBytes ?? 0),
                  )}
                </span>
              </div>
              <div>
                <span>{t.recentWindowMinutes(traffic?.recentWindowMinutes ?? 5)}</span>
                <strong>{recentTraffic?.requests ?? 0} {t.timesSuffix}</strong>
                <span>
                  {formatRate(recentTraffic?.requestsPerMinute ?? 0, t.perMinute)} ｜ {formatBytes(recentTraffic?.totalBytes ?? 0)}
                </span>
              </div>
            </div>

            <div className="mini-list traffic-grid">
              <div>
                <span>{t.promptTokens}</span>
                <strong>{lifetimeTraffic?.promptTokens ?? 0}</strong>
                <span>{t.completionTokensPrefix}{lifetimeTraffic?.completionTokens ?? 0}</span>
              </div>
              <div>
                <span>{t.streamRequests}</span>
                <strong>{lifetimeTraffic?.streamCount ?? 0}</strong>
                <span>{t.errorRequestsPrefix}{lifetimeTraffic?.errorCount ?? 0}</span>
              </div>
              <div>
                <span>{t.throughput}</span>
                <strong>{formatRate(lifetimeTraffic?.requestsPerMinute ?? 0, t.perMinute)}</strong>
                <span>{formatBytes(lifetimeTraffic?.bytesPerMinute ?? 0)}{t.perMinute}</span>
              </div>
              <div>
                <span>{t.trackingStarted}</span>
                <strong>{formatDate(traffic?.startedAt ?? null, lang, t.noRecord)}</strong>
              </div>
            </div>

            <div className="field-group">
              <div className="panel-title">
                <h3>{t.modelDistribution}</h3>
              </div>
              {traffic && traffic.topModels.length > 0 ? (
                <div className="traffic-model-list">
                  {traffic.topModels.map((model) => {
                    const modelSuccessRate =
                      model.requests > 0 ? (model.successCount / model.requests) * 100 : 0

                    return (
                      <div className="traffic-model-row" key={model.model}>
                        <div>
                          <strong>{model.model}</strong>
                          <span>{t.recentRequestPrefix}{formatDate(model.lastRequestAt, lang, t.noRecord)}</span>
                        </div>
                        <div>
                          <strong>{model.requests} {t.timesSuffix}</strong>
                          <span>{t.successRatePrefix}{formatPercent(modelSuccessRate)}</span>
                        </div>
                        <div>
                          <strong>{formatBytes(model.totalBytes)}</strong>
                          <span>{model.averageLatencyMs} ms</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="log-empty">{t.trafficEmpty}</div>
              )}
            </div>

            <div className="panel-foot">
              <span className="subtle">{t.clearHistoryDisclaimer}</span>
              <button className="soft-button" disabled={isBusy} onClick={() => void handleClearHistory()} type="button">
                <Trash2 size={16} />
                {t.clearHistory}
              </button>
            </div>
          </article>

          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <Cookie size={18} />
                <h2>{t.cookiesPanelTitle}</h2>
              </div>
              <span className="status-pill">{cookieLabel}</span>
            </div>

            <div className="cookie-note">
              <span>{t.earliestExpiryPrefix}{formatDate(status?.cookieInspection.expiresAt ?? null, lang, t.noRecord)}</span>
              <span>{t.recheckNote}</span>
            </div>

            <details className="cookie-details">
              <summary className="field-label cookie-toggle">{t.editCookiesToggle}</summary>
              <label className="field-label" htmlFor="cookie-input">
                {t.pasteCookieJsonLabel}
              </label>
              <textarea
                className="editor"
                id="cookie-input"
                onChange={(event) => {
                  setCookieText(event.target.value)
                  setCookieDirty(true)
                }}
                placeholder={t.cookiePlaceholder}
                spellCheck={false}
                value={cookieText}
              />

              <div className="panel-foot">
                <span className="subtle">{t.criticalCookieHelp}</span>
                <button className="primary-button" disabled={isBusy} onClick={() => void saveCookies()} type="button">
                  <Save size={16} />
                  {t.saveCookies}
                </button>
              </div>
            </details>
          </article>

          <details className="panel advanced-panel">
            <summary>
              <span>{t.advancedSettings}</span>
              <span className="subtle">{t.proxyAndAnchor}</span>
            </summary>

            <div className="advanced-content">
              <div className="field-group">
                <div className="panel-title">
                  <Network size={18} />
                  <h3>{t.proxyTitle}</h3>
                </div>
                <p className="field-help">{t.proxyHelp}</p>
                <input
                  className="text-input"
                  onChange={(event) => {
                    setProxyInput(event.target.value)
                    setProxyDirty(true)
                  }}
                  placeholder={t.proxyPlaceholder}
                  value={proxyInput}
                />
                <div className="inline-meta">
                  <span>{t.currentRoutePrefix}{status?.effectiveProxy ?? t.direct}</span>
                  <button className="soft-button" disabled={isBusy} onClick={() => void saveProxy()} type="button">
                    {t.saveProxy}
                  </button>
                </div>
              </div>

              <div className="field-group">
                <div className="panel-title">
                  <Link2 size={18} />
                  <h3>{t.anchorTitle}</h3>
                </div>
                <p className="field-help">{t.anchorHelp}</p>
                <input
                  className="text-input"
                  onChange={(event) => {
                    setAnchorInput(event.target.value)
                    setAnchorDirty(true)
                  }}
                  placeholder={t.anchorPlaceholder}
                  value={anchorInput}
                />
                <div className="inline-meta">
                  <span>{status?.anchor.sourcePath ?? t.anchorNotEnabled}</span>
                  <button className="soft-button" disabled={isBusy} onClick={() => void saveAnchor()} type="button">
                    {t.saveAnchor}
                  </button>
                </div>
                {status?.anchor.error ? <div className="error-box">{t.invalidAnchorPrefix}{status.anchor.error}</div> : null}
              </div>
            </div>
          </details>

          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <TerminalSquare size={18} />
                <h2>{t.liveLogs}</h2>
              </div>
              <span className="subtle">{t.logEntriesCount(logs.length)}</span>
            </div>

            <div aria-live="polite" aria-relevant="additions text" className="log-console" role="log">
              {logs.length === 0 ? <div className="log-empty">{t.noLogsYet}</div> : null}
              {logs.map((entry) => (
                <div className="log-line" key={entry.id}>
                  <span className="log-time">{formatDate(entry.timestamp, lang, t.noRecord)}</span>
                  <span className="log-level">{logLevelLabel(entry.level, t)}</span>
                  <span className="log-message">{entry.message}</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </main>
    </>
  )
}
