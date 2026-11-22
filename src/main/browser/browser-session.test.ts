import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDownloadNamer, installOpenHandler, installPermissionHandlers } from './browser-session'
import { BrowserPermissionStore, createBrowserPermissions, type PermissionAnswer } from './browser-permissions'

type RequestHandler = (contents: null, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string; mediaTypes?: string[] }) => void
type CheckHandler = (contents: null, permission: string, requestingOrigin: string) => boolean

function wire(answers: PermissionAnswer[], file: { text: string | null } = { text: null }) {
  const asked: string[] = []
  const store = new BrowserPermissionStore({ read: () => file.text, write: (text) => void (file.text = text) })
  const permissions = createBrowserPermissions(store, async (origin, permission) => {
    asked.push(`${origin} ${permission}`)
    return answers.shift() ?? { allow: false, remember: false }
  })
  let request: RequestHandler | undefined
  let check: CheckHandler | undefined
  installPermissionHandlers(
    {
      setPermissionRequestHandler: (handler) => void (request = handler as unknown as RequestHandler),
      setPermissionCheckHandler: (handler) => void (check = handler as unknown as CheckHandler),
    },
    permissions,
  )
  const ask = (permission: string, url = 'https://site.test/page'): Promise<boolean> =>
    new Promise((resolve) => request?.(null, permission, resolve, { requestingUrl: url }))
  return { ask, check: (permission: string, origin: string) => check?.(null, permission, origin) ?? false, asked, file }
}

test('notifications, fullscreen and the sanitized clipboard write are granted without a prompt; unknown permissions are refused', async () => {
  const { ask, asked } = wire([])
  for (const permission of ['notifications', 'fullscreen', 'clipboard-sanitized-write']) assert.equal(await ask(permission), true, permission)
  for (const permission of ['openExternal', 'usb', 'hid', 'serial', 'midiSysex']) assert.equal(await ask(permission), false, permission)
  assert.deepEqual(asked, [])
})

test('the microphone, location and clipboard read ask once per origin and the answer is kept', async () => {
  const { ask, check, asked } = wire([{ allow: true, remember: false }, { allow: false, remember: false }])
  assert.equal(check('media', 'https://site.test'), false, 'nothing is granted before the person answers')
  assert.equal(await ask('media'), true)
  assert.equal(await ask('media', 'https://site.test/other'), true, 'the same origin is not asked again')
  assert.equal(check('media', 'https://site.test'), true)
  assert.equal(await ask('media', 'https://other.test/'), false, 'another origin is asked on its own')
  assert.equal(check('media', 'https://other.test'), false)
  assert.equal(await ask('geolocation'), false, 'another permission is asked on its own')
  assert.deepEqual(asked, ['https://site.test media', 'https://other.test media', 'https://site.test geolocation'])
})

test('a blocked permission is refused again without a prompt, and a page without an http origin is refused', async () => {
  const { ask, check, asked } = wire([{ allow: false, remember: true }])
  assert.equal(await ask('clipboard-read'), false)
  assert.equal(await ask('clipboard-read'), false)
  assert.equal(check('clipboard-read', 'https://site.test'), false)
  assert.equal(await ask('media', 'file:///tmp/a.html'), false)
  assert.equal(await ask('media', ''), false)
  assert.deepEqual(asked, ['https://site.test clipboard-read'])
})

test('a remembered decision is saved to the file and read back by a new store', async () => {
  const file = { text: null as string | null }
  const first = wire([{ allow: true, remember: true }, { allow: true, remember: false }], file)
  assert.equal(await first.ask('media'), true)
  assert.equal(await first.ask('geolocation'), true)
  assert.deepEqual(JSON.parse(file.text ?? '{}'), { 'https://site.test': { media: 'allow' } }, 'only the remembered one is written')
  const second = wire([], file)
  assert.equal(second.check('media', 'https://site.test'), true)
  assert.equal(await second.ask('media'), true)
  assert.equal(second.check('geolocation', 'https://site.test'), false)
  assert.deepEqual(second.asked, [])
})

test('a damaged permission file asks again instead of throwing', async () => {
  const { ask, asked } = wire([{ allow: true, remember: false }], { text: '{not json' })
  assert.equal(await ask('media'), true)
  assert.equal(asked.length, 1)
})

test('two requests at once from one origin raise one prompt', async () => {
  const { ask, asked } = wire([{ allow: true, remember: false }])
  const [a, b] = await Promise.all([ask('media'), ask('media')])
  assert.deepEqual([a, b], [true, true])
  assert.equal(asked.length, 1)
})

test('two downloads with one name reserve different names until the first is done', () => {
  const namer = createDownloadNamer(() => false)
  const first = namer.reserve('report.pdf')
  const second = namer.reserve('report.pdf')
  const third = namer.reserve('report.pdf')
  assert.deepEqual([first, second, third], ['report.pdf', 'report (1).pdf', 'report (2).pdf'])
  namer.release(first)
  assert.equal(namer.reserve('report.pdf'), 'report.pdf', 'a finished download frees its name')
})

test('a name already on disk is skipped as well as a reserved one', () => {
  const namer = createDownloadNamer((name) => name === 'a.zip')
  assert.equal(namer.reserve('a.zip'), 'a (1).zip')
  assert.equal(namer.reserve('a.zip'), 'a (2).zip')
})

test('a popup opened by the page is allowed for http(s) and denied for other schemes', () => {
  let handler: ((details: { url: string; disposition: string }) => { action: string }) | undefined
  const loaded: string[] = []
  installOpenHandler({
    setWindowOpenHandler: (fn: unknown) => void (handler = fn as typeof handler),
    loadURL: (url: string) => {
      loaded.push(url)
      return Promise.resolve()
    },
  } as never)
  assert.equal(handler?.({ url: 'https://auth.test/login', disposition: 'new-window' }).action, 'allow')
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings']) {
    assert.equal(handler?.({ url, disposition: 'new-window' }).action, 'deny', url)
    assert.equal(handler?.({ url, disposition: 'foreground-tab' }).action, 'deny', url)
  }
  assert.equal(handler?.({ url: 'https://example.test/', disposition: 'foreground-tab' }).action, 'deny')
  assert.deepEqual(loaded, ['https://example.test/'], 'a tab-like open loads in the panel itself')
})
