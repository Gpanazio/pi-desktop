import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DEFAULT_SETTINGS } from '../../shared/default-settings'
import type { AgentEngineKind, AppSettings, InstalledSkill } from '../../shared/ipc-contracts'
import { NEXT_STEPS_EXTENSION_FILE, NEXT_STEPS_TOOL_NAME } from '../../../resources/next-steps'
import { buildPiArgs } from '../pi-rpc-manager'

let startOptions: typeof import('./pi-start-options')

before(async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  require.cache[electronPath]!.exports = {
    app: { isPackaged: false, getAppPath: () => process.cwd() },
  }
  startOptions = await import('./pi-start-options')
})

const RESUME_ON = { ...DEFAULT_SETTINGS, resumeLastSession: true }

function resolvedContinueSession(rawOptions: unknown): boolean | undefined {
  const { applyResumePreference, validateStartOptions } = startOptions
  return applyResumePreference(validateStartOptions(rawOptions), RESUME_ON).continueSession
}

function launchArgs(rawOptions: unknown): string[] {
  const { applyResumePreference, validateStartOptions } = startOptions
  return buildPiArgs(applyResumePreference(validateStartOptions(rawOptions), RESUME_ON))
}

test('an unset continueSession follows the resume preference', () => {
  assert.equal(resolvedContinueSession({}), true)
  assert.ok(launchArgs({}).includes('--continue'))
})

test('an explicit continueSession false survives validation and the resume preference', () => {
  assert.equal(resolvedContinueSession({ continueSession: false }), false)
})

test('an explicit continueSession false starts a fresh session despite the resume preference', () => {
  assert.equal(launchArgs({ continueSession: false }).includes('--continue'), false)
})

test('continueSession must be a boolean', () => {
  assert.throws(() => startOptions.validateStartOptions({ continueSession: 'no' }), /continueSession/)
})

test('model defaults fill only what the caller left unset', () => {
  const settings = { ...DEFAULT_SETTINGS, defaultProvider: 'saved-provider', defaultModel: 'saved-model', defaultThinkingLevel: 'high' }

  assert.deepEqual(startOptions.applyModelDefaults({ cwd: '/work' }, settings), {
    cwd: '/work',
    provider: 'saved-provider',
    model: 'saved-model',
    defaultThinkingLevel: 'high',
  })
  const named = startOptions.applyModelDefaults({ provider: 'named-provider', model: 'named-model' }, settings)
  assert.equal(named.provider, 'named-provider')
  assert.equal(named.model, 'named-model')
})

function permissionArgs(settings: Partial<AppSettings>, engine: AgentEngineKind = 'pi'): string[] {
  return startOptions.applyPermissionModeToStartOptions({ engine }, { ...DEFAULT_SETTINGS, ...settings }).args ?? []
}

function loadsNextSteps(args: string[]): boolean {
  return args.some((arg, index) => args[index - 1] === '-e' && basename(arg) === NEXT_STEPS_EXTENSION_FILE)
}

function listedTools(args: string[]): string[] {
  const index = args.indexOf('--tools')
  return index === -1 ? [] : args[index + 1].split(',')
}

test('the next-steps extension loads only while the setting is on', () => {
  assert.equal(loadsNextSteps(permissionArgs({ suggestNextSteps: true })), true)
  assert.equal(loadsNextSteps(permissionArgs({ suggestNextSteps: false })), false)
})

test('plan mode lists the next-steps tool on both engines while the setting is on', () => {
  for (const engine of ['pi', 'omp'] as const) {
    const on = permissionArgs({ permissionMode: 'plan-readonly', suggestNextSteps: true }, engine)
    assert.ok(listedTools(on).includes(NEXT_STEPS_TOOL_NAME), engine)
    const off = permissionArgs({ permissionMode: 'plan-readonly', suggestNextSteps: false }, engine)
    assert.equal(listedTools(off).includes(NEXT_STEPS_TOOL_NAME), false, engine)
  }
})

test('modes without a tool list get no --tools flag for next steps', () => {
  assert.deepEqual(listedTools(permissionArgs({ permissionMode: 'ask-edits', suggestNextSteps: true })), [])
})

const installedSkill = (name: string, path: string): InstalledSkill => ({
  name,
  description: `${name} does things`,
  path,
  source: 'global',
  enabled: true,
})

test('an active skill group loads only its skills, normalising quotes and duplicates', () => {
  const installed = [
    installedSkill('alpha', '/s/alpha/SKILL.md'),
    installedSkill('"opendesign"', '/s/opendesign/SKILL.md'),
    installedSkill('note', '/s/note.md'),
    installedSkill('other', '/s/other/SKILL.md'),
  ]
  const group = { id: 'g', name: 'PI', skills: ['alpha', "'\"opendesign\"'", 'opendesign', 'note', 'ghost'], collapsed: false }
  const { args, unresolved } = startOptions.skillGroupArgs({ skillGroups: [group], activeSkillGroupId: 'g' }, installed)
  assert.deepEqual(args, [
    '--no-skills',
    '--skill', '/s/alpha',
    '--skill', '/s/opendesign',
    '--skill', '/s/note.md',
  ])
  assert.deepEqual(unresolved, ['ghost'])
})

test('no active skill group, or an unknown one, leaves the skill args alone', () => {
  const group = { id: 'g', name: 'PI', skills: ['alpha'], collapsed: false }
  assert.deepEqual(startOptions.skillGroupArgs({ skillGroups: [group], activeSkillGroupId: null }, []).args, [])
  assert.deepEqual(startOptions.skillGroupArgs({ skillGroups: [group], activeSkillGroupId: 'missing' }, []).args, [])
})

test('an active skill group adds --no-skills and --skill for Pi only, and logs unresolved names', async () => {
  const { applyPermissionModeToStartOptions } = startOptions
  const { appLog } = await import('../app-log')
  const cwd = await mkdtemp(join(tmpdir(), 'start-options-skills-'))
  const infos: string[] = []
  const originalInfo = appLog.info.bind(appLog)
  appLog.info = (scope: string, message: string): void => { infos.push(`${scope}: ${message}`) }
  try {
    const dir = join(cwd, '.pi', 'skills', 'zz-group-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: zz-group-skill\ndescription: d\n---\n', 'utf-8')
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      skillGroups: [{ id: 'g', name: 'G', skills: ['zz-group-skill', 'zz-ghost'], collapsed: false }],
      activeSkillGroupId: 'g',
    }

    const pi = applyPermissionModeToStartOptions({ cwd, engine: 'pi' }, settings)
    assert.ok(pi.args?.includes('--no-skills'))
    assert.equal(pi.args?.[pi.args.indexOf('--skill') + 1], dir)
    assert.ok(infos.some((line) => line.includes('zz-ghost')))

    const omp = applyPermissionModeToStartOptions({ cwd, engine: 'omp' }, settings)
    assert.ok(!omp.args?.includes('--no-skills'))
    assert.ok(!omp.args?.includes('--skill'))
  } finally {
    appLog.info = originalInfo
    await rm(cwd, { recursive: true, force: true })
  }
})
