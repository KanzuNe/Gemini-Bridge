import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { en, type TranslationDictionary } from './en'
import { zh } from './zh'

export type Language = 'en' | 'zh'

export type I18nContextValue = {
  lang: Language
  setLang: (lang: Language) => void
  toggleLang: () => void
  t: TranslationDictionary
}

const STORAGE_KEY = 'gemini_bridge_lang'

const translations: Record<Language, TranslationDictionary> = {
  en,
  zh,
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') {
      return saved
    }
    return 'en'
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = (nextLang: Language) => {
    setLangState(nextLang)
  }

  const toggleLang = () => {
    setLangState((current) => (current === 'en' ? 'zh' : 'en'))
  }

  const value: I18nContextValue = {
    lang,
    setLang,
    toggleLang,
    t: translations[lang],
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return context
}
