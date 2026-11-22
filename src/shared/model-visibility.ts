export interface ModelRef {
  provider: string
  id: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

// `provider/id`, where `*` matches any run of characters (including `/`).
export function matchesModelPattern(pattern: string, model: ModelRef): boolean {
  const source = pattern.trim().split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${source}$`).test(`${model.provider}/${model.id}`)
}

// The model the session is using stays listed even when a pattern hides it.
export function filterHiddenModels<T extends ModelRef>(models: T[], hidden: string[], current?: ModelRef | null): T[] {
  const patterns = hidden.filter((pattern) => pattern.trim())
  if (!patterns.length) return models
  return models.filter((model) => {
    if (current && current.provider === model.provider && current.id === model.id) return true
    return !patterns.some((pattern) => matchesModelPattern(pattern, model))
  })
}

export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`
}

export function isWildcardPattern(pattern: string): boolean {
  return pattern.includes('*')
}

// The wildcard entry that hides this model, if any. Such a model cannot be
// toggled from the checkbox list; the pattern chip has to be removed instead.
export function hidingWildcard(hidden: string[], model: ModelRef): string | null {
  return hidden.find((pattern) => isWildcardPattern(pattern) && matchesModelPattern(pattern, model)) ?? null
}

export function isModelHidden(hidden: string[], model: ModelRef): boolean {
  return hidden.some((pattern) => pattern.trim() !== '' && matchesModelPattern(pattern, model))
}

// Show/hide one model with explicit `provider/id` entries. Wildcard entries and
// entries for models absent from the catalog are never rewritten or dropped.
export function toggleModel(hidden: string[], model: ModelRef, visible: boolean): string[] {
  if (hidingWildcard(hidden, model)) return hidden
  const key = modelKey(model)
  const without = hidden.filter((entry) => entry.trim() !== key)
  if (visible) return without.length === hidden.length ? hidden : without
  return hidden.some((entry) => entry.trim() === key) ? hidden : [...hidden, key]
}

// Show/hide every model of a provider that is present in `models`.
export function toggleProvider(hidden: string[], provider: string, models: ModelRef[], visible: boolean): string[] {
  return models
    .filter((model) => model.provider === provider)
    .reduce((acc, model) => toggleModel(acc, model, visible), hidden)
}
