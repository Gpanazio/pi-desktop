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
