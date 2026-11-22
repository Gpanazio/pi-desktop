import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { Search, X } from 'lucide-react'
import { useAppStore } from '../store'
import type { ModelInfo } from '../../../shared/ipc-contracts'
import {
  hidingWildcard,
  isModelHidden,
  isWildcardPattern,
  toggleModel,
  toggleProvider,
} from '../../../shared/model-visibility'

// Lists the unfiltered model catalog and persists `hiddenModels` immediately,
// so the picker reflects each change the next time it opens.
export function VisibleModelsSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const listAllModels = useAppStore((state) => state.listAllModels)
  const hidden = useAppStore((state) => state.settings?.hiddenModels) ?? []
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    listAllModels().then(
      (list) => { if (!cancelled) setModels(list) },
      () => { if (!cancelled) setError(true) },
    )
    return () => { cancelled = true }
  }, [listAllModels])

  const persist = useCallback(async (compute: (current: string[]) => string[]) => {
    const current = useAppStore.getState().settings?.hiddenModels ?? []
    const next = compute(current)
    if (next === current) return
    await window.piDesktop.settings.save({ hiddenModels: next })
    await useAppStore.getState().loadSettings()
  }, [])

  const wildcards = hidden.filter(isWildcardPattern)
  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>()
    for (const model of models ?? []) {
      if (needle && !`${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)) continue
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [models, needle])

  const total = models?.length ?? 0
  const visible = (models ?? []).filter((model) => !isModelHidden(hidden, model)).length

  return (
    <div className="space-y-3">
      <p className="text-xs text-dim">{t('settings.visibleModels.description')}</p>

      {wildcards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-dim">{t('settings.visibleModels.patterns')}</span>
          {wildcards.map((pattern) => (
            <span key={pattern} className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-elevated px-2 py-0.5 text-xs text-primary">
              <code>{pattern}</code>
              <button
                type="button"
                aria-label={t('settings.visibleModels.removePattern', { pattern })}
                title={t('settings.visibleModels.removePattern', { pattern })}
                onClick={() => void persist((current) => current.filter((entry) => entry !== pattern))}
                className="text-dim hover:text-primary"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.visibleModels.search')}
            className="w-full rounded-md border border-border-strong bg-surface py-1.5 pl-9 pr-3 text-sm text-primary focus:border-focus focus:outline-none"
          />
        </div>
        {models && (
          <span className="shrink-0 text-xs text-dim">{t('settings.visibleModels.count', { visible, total })}</span>
        )}
      </div>

      {error && <p className="text-sm text-dim">{t('settings.visibleModels.loadFailed')}</p>}
      {models && groups.length === 0 && <p className="text-sm text-dim">{t('settings.visibleModels.empty')}</p>}

      <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
        {groups.map(([provider, list]) => {
          const toggleable = list.filter((model) => !hidingWildcard(hidden, model))
          const allVisible = toggleable.length > 0 && toggleable.every((model) => !isModelHidden(hidden, model))
          const providerLabel = t(allVisible ? 'settings.visibleModels.hideProvider' : 'settings.visibleModels.showProvider', { provider })
          return (
            <div key={provider}>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-secondary" title={providerLabel}>
                <input
                  type="checkbox"
                  aria-label={providerLabel}
                  checked={allVisible}
                  disabled={toggleable.length === 0}
                  onChange={() => void persist((current) => toggleProvider(current, provider, list, !allVisible))}
                />
                {provider}
              </label>
              <ul className="space-y-0.5 pl-6">
                {list.map((model) => {
                  const pattern = hidingWildcard(hidden, model)
                  const checked = !isModelHidden(hidden, model)
                  return (
                    <li key={model.id}>
                      <label
                        className={clsx('flex items-center gap-2 text-sm', pattern ? 'text-dim' : 'text-primary')}
                        title={pattern ? t('settings.visibleModels.hiddenByPattern', { pattern }) : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={pattern !== null}
                          onChange={() => void persist((current) => toggleModel(current, model, !checked))}
                        />
                        <span className="truncate">{model.name || model.id}</span>
                        {model.name && model.name !== model.id && <code className="truncate text-xs text-dim">{model.id}</code>}
                        {pattern && <span className="shrink-0 text-xs">({t('settings.visibleModels.hiddenByPattern', { pattern })})</span>}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
