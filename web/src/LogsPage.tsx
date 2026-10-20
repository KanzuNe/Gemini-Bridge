import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react'
import './LogsPage.css'
import { copyText } from './clipboard'
import { useI18n, LanguageToggle, type Language } from './i18n'
import type { TranslationDictionary } from './i18n/en'

type ConversationStatus = 'success' | 'error'
type ConversationOutcome = 'answer' | 'refusal' | 'circuit_open' | 'error'
type CompletionStage = 'initial' | 'text_only_retry' | 'anchored_chat_retry' | 'none'

type ConversationLog = {
  id: string
  timestamp: string
  model: string
  requestedModel: string | null
  sessionKey: string
  anchorSourcePath: string | null
  anchorEphemeral: boolean
  compacted: boolean
  stream: boolean
  status: ConversationStatus
  statusCode: number | null
  errorMessage: string | null
  promptPreview: string
  responsePreview: string | null
  durationMs: number
  responseId: string
  promptTokens: number | null
  sourcePromptTokens: number | null
  memoryTokens: number | null
  memoryTurns: number | null
  completionTokens: number | null
  outcome: ConversationOutcome
  completionStage: CompletionStage
  refusalKind: 'image_mode' | 'generic_capability' | null
  promptFingerprint: string | null
  requestPayload: string | null
  promptBody: string | null
  responseBody: string | null
}

type Banner = {
  tone: 'error' | 'info'
  text: string
}

type FilterStatus = 'all' | ConversationStatus
type FilterOutcome = 'all' | ConversationOutcome

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

async function downloadExport(url: string, filenameFallback: string, t?: TranslationDictionary) {
  const response = await fetch(url)
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(data.error?.message ?? `${t?.exportFailed ?? 'Export failed: '}${response.status}`)
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const matched = disposition.match(/filename="?([^"]+)"?/)
  const filename = matched?.[1] ?? filenameFallback
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

function formatDate(value: string, lang: Language): string {
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
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')} ${t.sec}`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} ${t.min} ${seconds % 60} ${t.sec}`
}

function timeAgo(value: string, t: TranslationDictionary): string {
  const diff = Date.now() - new Date(value).getTime()
  if (diff < 5000) return t.justNow
  if (diff < 60000) return `${Math.floor(diff / 1000)} ${t.secsAgo}`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} ${t.minsAgo}`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${t.hoursAgo}`
  return `${Math.floor(diff / 86400000)} ${t.daysAgo}`
}

function outcomeLabel(outcome: ConversationOutcome, t: TranslationDictionary): string {
  if (outcome === 'answer') return t.outcomeAnswered
  if (outcome === 'refusal') return t.outcomeRefused
  if (outcome === 'circuit_open') return t.outcomeCircuitOpen
  return t.outcomeError
}

function completionStageLabel(stage: CompletionStage, t: TranslationDictionary): string {
  if (stage === 'initial') return t.stageInitial
  if (stage === 'text_only_retry') return t.stageTextOnlyRetry
  if (stage === 'anchored_chat_retry') return t.stageAnchoredRetry
  return t.stageNone
}

function buildConversationUrl(params: {
  limit?: number
  query?: string
  status?: FilterStatus
  outcome?: FilterOutcome
  dateFrom?: string
  dateTo?: string
}): string {
  const search = new URLSearchParams()
  search.set('limit', String(params.limit ?? 200))
  if (params.query?.trim()) {
    search.set('query', params.query.trim())
  }
  if (params.status && params.status !== 'all') {
    search.set('status', params.status)
  }
  if (params.outcome && params.outcome !== 'all') {
    search.set('outcome', params.outcome)
  }
  if (params.dateFrom) {
    search.set('dateFrom', `${params.dateFrom}T00:00:00.000Z`)
  }
  if (params.dateTo) {
    search.set('dateTo', `${params.dateTo}T23:59:59.999Z`)
  }
  return `/admin/conversations?${search.toString()}`
}

export default function LogsPage() {
  const { t, lang } = useI18n()

  const [conversations, setConversations] = useState<ConversationLog[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const deferredSearchText = useDeferredValue(searchText)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterOutcome, setFilterOutcome] = useState<FilterOutcome>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, ConversationLog>>({})
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null)
  const [exportingKey, setExportingKey] = useState<string | null>(null)
  const reconnectTimer = useRef<number | null>(null)

  const clearReconnectTimer = () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }

  const queryUrl = buildConversationUrl({
    limit: 200,
    query: deferredSearchText,
    status: filterStatus,
    outcome: filterOutcome,
    dateFrom,
    dateTo,
  })

  const loadConversations = useCallback(async () => {
    try {
      const data = await requestJson<ConversationLog[]>(queryUrl, undefined, t)
      setConversations(data)
      setBanner(null)
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : t.loadConversationsFailed,
      })
    } finally {
      setLoading(false)
    }
  }, [queryUrl, t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (!autoRefresh) {
      clearReconnectTimer()
      return
    }

    let cancelled = false
    let source: EventSource | null = null

    const connect = () => {
      if (cancelled) return

      source = new EventSource('/admin/conversations/stream')
      source.onmessage = () => {
        void loadConversations()
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
  }, [autoRefresh, loadConversations])

  useEffect(() => {
    if (!autoRefresh) return

    const interval = window.setInterval(() => {
      void loadConversations()
    }, 5000)

    return () => window.clearInterval(interval)
  }, [autoRefresh, loadConversations])

  const handleCopy = async (text: string, id: string) => {
    try {
      const copied = await copyText(text)
      if (!copied) {
        throw new Error(t.copyFailed)
      }
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(null), 1800)
    } catch {
      setBanner({ tone: 'info', text: t.copyFailed })
    }
  }

  const ensureDetail = useCallback(
    async (id: string) => {
      if (detailCache[id]) {
        return detailCache[id]
      }

      setDetailLoadingId(id)
      try {
        const detail = await requestJson<ConversationLog>(`/admin/conversations/${id}`, undefined, t)
        setDetailCache((current) => ({ ...current, [id]: detail }))
        return detail
      } finally {
        setDetailLoadingId((current) => (current === id ? null : current))
      }
    },
    [detailCache, t],
  )

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }

    setExpandedId(id)
    try {
      await ensureDetail(id)
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : t.loadDetailFailed,
      })
    }
  }

  const handleExport = async (preset: 'current' | 'recent_failures') => {
    const search = new URLSearchParams()
    search.set('format', 'jsonl')

    if (preset === 'recent_failures') {
      search.set('preset', 'recent_failures')
      search.set('limit', '200')
    } else {
      search.set('limit', '500')
      if (deferredSearchText.trim()) {
        search.set('query', deferredSearchText.trim())
      }
      if (filterStatus !== 'all') {
        search.set('status', filterStatus)
      }
      if (filterOutcome !== 'all') {
        search.set('outcome', filterOutcome)
      }
      if (dateFrom) {
        search.set('dateFrom', `${dateFrom}T00:00:00.000Z`)
      }
      if (dateTo) {
        search.set('dateTo', `${dateTo}T23:59:59.999Z`)
      }
    }

    setExportingKey(preset)
    try {
      const fallbackName =
        preset === 'recent_failures'
          ? (lang === 'zh' ? '近期失败记录.jsonl' : 'failure-logs.jsonl')
          : (lang === 'zh' ? '会话记录.jsonl' : 'conversation-logs.jsonl')

      await downloadExport(`/admin/conversations/export?${search.toString()}`, fallbackName, t)
      setBanner({
        tone: 'info',
        text: preset === 'recent_failures' ? t.failuresExported : t.currentExported,
      })
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : t.exportFailed,
      })
    } finally {
      setExportingKey(null)
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        {t.skipToMain}
      </a>

      <main className="page-shell logs-shell" id="main-content">
        <header className="logs-header">
          <div className="header-copy">
            <Link className="back-link" to="/">
              <ArrowLeft size={16} />
              {t.backToBridge}
            </Link>
            <h1>{t.logsPageTitle}</h1>
            <p>{t.logsPageSubtitle}</p>
          </div>

          <div className="header-actions">
            <LanguageToggle />

            <button className="soft-button" onClick={() => void loadConversations()} type="button">
              <RefreshCw size={16} />
              {t.refresh}
            </button>

            <button
              className="soft-button"
              disabled={exportingKey !== null}
              onClick={() => void handleExport('current')}
              type="button"
            >
              {exportingKey === 'current' ? <Loader2 className="spin" size={14} /> : <ArrowDownToLine size={14} />}
              {t.exportCurrentResult}
            </button>
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

        <section className="filters-panel">
          <div className="search-box">
            <label className="sr-only" htmlFor="conversation-search">
              {t.searchAriaLabel}
            </label>
            <Search size={15} />
            <input
              id="conversation-search"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t.searchPlaceholder}
              spellCheck={false}
              type="text"
              value={searchText}
            />
          </div>

          <div aria-label={t.statusFilterAria} className="filter-pills" role="group">
            <button className={`pill ${filterStatus === 'all' ? 'active' : ''}`} onClick={() => setFilterStatus('all')} type="button">
              {t.all}
            </button>
            <button
              className={`pill ${filterStatus === 'success' ? 'active' : ''}`}
              onClick={() => setFilterStatus('success')}
              type="button"
            >
              {t.statusSuccess}
            </button>
            <button className={`pill ${filterStatus === 'error' ? 'active' : ''}`} onClick={() => setFilterStatus('error')} type="button">
              {t.statusError}
            </button>
          </div>

          <div className="filter-inline">
            <label className="filter-select">
              <span>{t.outcomeType}</span>
              <select value={filterOutcome} onChange={(event) => setFilterOutcome(event.target.value as FilterOutcome)}>
                <option value="all">{t.all}</option>
                <option value="answer">{t.outcomeAnswered}</option>
                <option value="refusal">{t.outcomeRefused}</option>
                <option value="circuit_open">{t.outcomeCircuitOpen}</option>
                <option value="error">{t.outcomeError}</option>
              </select>
            </label>

            <label className="filter-date">
              <span>{t.startDate}</span>
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>

            <label className="filter-date">
              <span>{t.endDate}</span>
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>

            <label className="toggle-auto">
              <input checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} type="checkbox" />
              {t.autoRefresh}
            </label>
          </div>

          <details className="more-actions">
            <summary>{t.moreActions}</summary>
            <button
              className="soft-button"
              disabled={exportingKey !== null}
              onClick={() => void handleExport('recent_failures')}
              type="button"
            >
              {exportingKey === 'recent_failures' ? <Loader2 className="spin" size={14} /> : <TriangleAlert size={14} />}
              {t.exportRecentFailures}
            </button>
          </details>
        </section>

        <section className="conv-list">
          {loading && conversations.length === 0 ? (
            <div className="empty-state">
              <Loader2 className="spin" size={36} />
              <p>{t.loadingLogs}</p>
            </div>
          ) : conversations.length === 0 ? (
            <div className="empty-state">
              <FileText size={40} strokeWidth={1.3} />
              <p>{t.noMatchingLogs}</p>
              <p className="subtle">{t.clearFiltersAdvice}</p>
            </div>
          ) : (
            conversations.map((conversation) => {
              const isExpanded = expandedId === conversation.id
              const detail = detailCache[conversation.id] ?? conversation
              const isDetailLoading = detailLoadingId === conversation.id
              const promptText = detail.promptBody ?? detail.promptPreview
              const responseText = detail.responseBody ?? detail.responsePreview
              const requestPayload = detail.requestPayload

              return (
                <article className={`conv-card ${isExpanded ? 'expanded' : ''}`} key={conversation.id}>
                  <button
                    aria-controls={`conv-detail-${conversation.id}`}
                    aria-expanded={isExpanded}
                    className="conv-header"
                    onClick={() => void handleExpand(conversation.id)}
                    type="button"
                  >
                    <div className="conv-status-icon">
                      {conversation.status === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                    </div>

                    <div className="conv-main">
                      <div className="conv-meta">
                        <code className="conv-model">{conversation.model}</code>
                        <span className={`badge ${conversation.stream ? 'stream' : 'sync'}`}>
                          {conversation.stream ? t.streamingTag : t.syncTag}
                        </span>
                        <span className={`badge outcome ${conversation.outcome}`}>
                          {outcomeLabel(conversation.outcome, t)}
                        </span>
                        <span className="conv-time" title={formatDate(conversation.timestamp, lang)}>
                          {timeAgo(conversation.timestamp, t)}
                        </span>
                      </div>
                      <p className="conv-preview">{conversation.promptPreview}</p>
                    </div>

                    <div className="conv-side">
                      <span className="duration">{formatDuration(conversation.durationMs, t)}</span>
                      {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="conv-detail" id={`conv-detail-${conversation.id}`}>
                      {isDetailLoading ? (
                        <div className="detail-loading">
                          <Loader2 className="spin" size={16} />
                          {t.loadingFullContent}
                        </div>
                      ) : null}

                      {conversation.status === 'error' && conversation.errorMessage ? (
                        <div className="error-box">
                          {t.errorPrefix}{conversation.errorMessage}
                          {conversation.statusCode ? ` (HTTP ${conversation.statusCode})` : ''}
                        </div>
                      ) : null}

                      {requestPayload ? (
                        <div className="detail-section">
                          <div className="detail-head">
                            <h3>{t.rawRequestPayload}</h3>
                            <button
                              className={`copy-btn ${copiedId === `req-${conversation.id}` ? 'copied' : ''}`}
                              onClick={() => void handleCopy(requestPayload, `req-${conversation.id}`)}
                              type="button"
                            >
                              {copiedId === `req-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                          </div>
                          <pre className="detail-pre">{requestPayload}</pre>
                        </div>
                      ) : null}

                      <div className="detail-section">
                        <div className="detail-head">
                          <h3>{t.promptTitle}</h3>
                          <button
                            className={`copy-btn ${copiedId === `prompt-${conversation.id}` ? 'copied' : ''}`}
                            onClick={() => void handleCopy(promptText, `prompt-${conversation.id}`)}
                            type="button"
                          >
                            {copiedId === `prompt-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                        <pre className="detail-pre">{promptText}</pre>
                      </div>

                      {responseText ? (
                        <div className="detail-section">
                          <div className="detail-head">
                            <h3>{t.responseTitle}</h3>
                            <button
                              className={`copy-btn ${copiedId === `resp-${conversation.id}` ? 'copied' : ''}`}
                              onClick={() => void handleCopy(responseText, `resp-${conversation.id}`)}
                              type="button"
                            >
                              {copiedId === `resp-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                          </div>
                          <pre className="detail-pre">{responseText}</pre>
                        </div>
                      ) : null}

                      <details className="more-meta">
                        <summary>{t.moreMetadata}</summary>
                        <div className="meta-grid">
                          <div>
                            <span>{t.recordId}</span>
                            <strong>{conversation.id}</strong>
                          </div>
                          <div>
                            <span>{t.timestamp}</span>
                            <strong>{formatDate(conversation.timestamp, lang)}</strong>
                          </div>
                          <div>
                            <span>{t.outcomeLabel}</span>
                            <strong>{outcomeLabel(conversation.outcome, t)}</strong>
                          </div>
                          <div>
                            <span>{t.modeLabel}</span>
                            <strong>{conversation.stream ? t.streamingReturn : t.syncReturn}</strong>
                          </div>
                          <div>
                            <span>{t.stageLabel}</span>
                            <strong>{completionStageLabel(conversation.completionStage, t)}</strong>
                          </div>
                          <div>
                            <span>{t.statusCodeLabel}</span>
                            <strong>{conversation.statusCode ?? t.statusHealthy}</strong>
                          </div>
                        </div>
                      </details>
                    </div>
                  ) : null}
                </article>
              )
            })
          )}
        </section>
      </main>
    </>
  )
}
