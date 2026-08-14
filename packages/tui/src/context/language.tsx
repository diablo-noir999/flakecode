import { createMemo, type ParentProps } from "solid-js"
import { useKV } from "./kv"
import { createSimpleContext } from "./helper"

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const kv = useKV()
    const [preference, setPreference] = kv.signal<string>("locale", "auto")

    const t = (key: string, _params?: Record<string, string | number | boolean>) => key

    return {
      preference,
      t,
    }
  },
})
