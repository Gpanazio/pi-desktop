import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterHiddenModels, matchesModelPattern } from './model-visibility'

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
