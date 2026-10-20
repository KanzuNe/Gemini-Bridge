import { Languages } from 'lucide-react'
import { useI18n } from './context'

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, toggleLang, t } = useI18n()

  return (
    <button
      aria-label={t.languageLabel}
      className={className ?? 'soft-button language-toggle-btn'}
      onClick={toggleLang}
      title={lang === 'en' ? t.toggleToZh : t.toggleToEn}
      type="button"
    >
      <Languages size={15} />
      <span>{lang === 'en' ? '中文' : 'EN'}</span>
    </button>
  )
}
