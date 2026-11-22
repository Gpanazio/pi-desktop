import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterHiddenModels, hidingWildcard, isModelHidden, matchesModelPattern, toggleModel, toggleProvider } from './model-visibility'

const models = [
  { provider: 'anthropic', id: 'claude-fable-5' },
  { provider: 'anthropic', id: 'claude-opus-5-5' },
  { provider: 'openai-codex', id: 'gpt-5.6-sol' },
  { provider: 'openai-codex', id: 'gpt-6.2-sol' },
  { provider: 'locais', id: 'Gabqwen X' },
]

test('matchesModelPattern matches exact ids and * wildcards, escaping the rest', () => {
  assert.equal(matchesModelPattern('anthropic/claude-fable-5', models[0]), true)
  assert.equal(matchesModelPattern('anthropic/claude-fable', models[0]), false)
  assert.equal(matchesModelPattern('*/gpt-5*', models[2]), true)
  assert.equal(matchesModelPattern('*/gpt-5*', models[3]), false)
  assert.equal(matchesModelPattern('openai-codex/gpt-5.6-sol', { provider: 'openai-codex', id: 'gpt-5x6-sol' }), false)
  assert.equal(matchesModelPattern('locais/*', models[4]), true)
})

test('filterHiddenModels hides matches, keeps the rest and the current model', () => {
  const hidden = ['*/gpt-5*', 'anthropic/claude-fable-5']
  assert.deepEqual(filterHiddenModels(models, hidden).map((m) => m.id), ['claude-opus-5-5', 'gpt-6.2-sol', 'Gabqwen X'])
  assert.deepEqual(
    filterHiddenModels(models, hidden, { provider: 'openai-codex', id: 'gpt-5.6-sol' }).map((m) => m.id),
    ['claude-opus-5-5', 'gpt-5.6-sol', 'gpt-6.2-sol', 'Gabqwen X'],
  )
  assert.equal(filterHiddenModels(models, []), models)
  assert.equal(filterHiddenModels(models, ['', '  ']), models)
})

test('toggleModel adds and removes explicit entries, keeping orphans and wildcards', () => {
  const orphan = 'ghost/old-model'
  const wildcard = 'openai-codex/gpt-5*'
  const fable = models[0]
  assert.deepEqual(toggleModel([orphan], fable, false), [orphan, 'anthropic/claude-fable-5'])
  assert.deepEqual(toggleModel([orphan, 'anthropic/claude-fable-5'], fable, true), [orphan])
  // idempotent
  const hidden = [orphan, 'anthropic/claude-fable-5']
  assert.equal(toggleModel(hidden, fable, false), hidden)
  const shown = [orphan]
  assert.equal(toggleModel(shown, fable, true), shown)
  // wildcard-hidden model cannot be toggled
  const withWildcard = [wildcard]
  assert.equal(toggleModel(withWildcard, models[2], true), withWildcard)
  assert.equal(toggleModel(withWildcard, models[2], false), withWildcard)
  // wildcard does not prevent toggling a model it does not match
  assert.deepEqual(toggleModel(withWildcard, models[3], false), [wildcard, 'openai-codex/gpt-6.2-sol'])
})

test('toggleProvider hides/shows every listed model of the provider only', () => {
  const orphan = 'openai-codex/removed-model'
  const wildcard = 'openai-codex/gpt-5*'
  const hiddenAll = toggleProvider([orphan], 'openai-codex', models, false)
  assert.deepEqual(hiddenAll, [orphan, 'openai-codex/gpt-5.6-sol', 'openai-codex/gpt-6.2-sol'])
  assert.deepEqual(toggleProvider(hiddenAll, 'openai-codex', models, true), [orphan])
  // wildcard-hidden models are skipped, the others still toggle
  assert.deepEqual(toggleProvider([wildcard], 'openai-codex', models, false), [wildcard, 'openai-codex/gpt-6.2-sol'])
  assert.deepEqual(toggleProvider([wildcard, 'openai-codex/gpt-6.2-sol'], 'openai-codex', models, true), [wildcard])
  // other providers untouched
  assert.deepEqual(toggleProvider(['anthropic/claude-fable-5'], 'locais', models, false), ['anthropic/claude-fable-5', 'locais/Gabqwen X'])
})

test('hidingWildcard and isModelHidden report the pattern', () => {
  assert.equal(hidingWildcard(['*/gpt-5*', 'anthropic/claude-fable-5'], models[2]), '*/gpt-5*')
  assert.equal(hidingWildcard(['anthropic/claude-fable-5'], models[0]), null)
  assert.equal(isModelHidden(['anthropic/claude-fable-5'], models[0]), true)
  assert.equal(isModelHidden([''], models[0]), false)
})
