// The browser panel presents itself as a stable Chrome, not as Electron: sites
// sniff the "Electron/x" and app-name tokens and refuse to sign in. Pure, so it
// runs under plain Node in tests.

/** The user agent of a stable Chrome of the given version on this platform (reduced form: Chrome/<major>.0.0.0). */
export function buildChromeUserAgent(chromeVersion: string, platform: NodeJS.Platform): string {
  const major = chromeVersion.split('.')[0] || '0'
  const system =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

// ─── Emulated devices ────────────────────────────────────────────────────────

export type EmulatedDevice = 'desktop' | 'iphone' | 'ipad' | 'android'

/** What `Emulation.setUserAgentOverride` takes. */
export interface UserAgentOverride {
  userAgent: string
  platform?: string
  userAgentMetadata?: {
    brands: Array<{ brand: string; version: string }>
    fullVersionList: Array<{ brand: string; version: string }>
    platform: string
    platformVersion: string
    architecture: string
    model: string
    mobile: boolean
  }
}

// Preset sizes whose device is not an iPhone: Pixel = Chrome on Android, iPad = Safari on iPadOS.
const ANDROID_SIZES = [{ width: 412, height: 915 }]
const IPAD_SIZES = [{ width: 820, height: 1180 }]
const TABLET_MIN_SIDE = 600

function matchesSize(viewport: { width: number; height: number }, sizes: ReadonlyArray<{ width: number; height: number }>): boolean {
  return sizes.some((size) => size.width === viewport.width && size.height === viewport.height)
}

/**
 * The device a viewport stands for, which decides the user agent. Non-mobile
 * viewports (and none) keep the desktop agent. Mobile presets map to their
 * device; any other mobile size is a tablet from 600 px on its short side and
 * an iPhone below that.
 */
export function deviceForViewport(viewport: { width: number; height: number; mobile: boolean } | null): EmulatedDevice {
  if (!viewport || !viewport.mobile) return 'desktop'
  if (matchesSize(viewport, ANDROID_SIZES)) return 'android'
  if (matchesSize(viewport, IPAD_SIZES)) return 'ipad'
  return Math.min(viewport.width, viewport.height) >= TABLET_MIN_SIDE ? 'ipad' : 'iphone'
}

/** The user agent override for a device; desktop is the same Chrome agent the panel presents without emulation. */
export function buildUserAgentOverride(device: EmulatedDevice, chromeVersion: string, platform: NodeJS.Platform): UserAgentOverride {
  const major = chromeVersion.split('.')[0] || '0'
  if (device === 'iphone') {
    return {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    }
  }
  if (device === 'ipad') {
    return {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPad',
    }
  }
  if (device === 'android') {
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not.A/Brand', version: '99' },
    ]
    return {
      userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv81',
      userAgentMetadata: {
        brands,
        fullVersionList: brands.map((entry) => ({ brand: entry.brand, version: entry.version === '99' ? '99.0.0.0' : `${entry.version}.0.0.0` })),
        platform: 'Android',
        platformVersion: '14.0.0',
        architecture: '',
        model: 'Pixel 8',
        mobile: true,
      },
    }
  }
  return { userAgent: buildChromeUserAgent(chromeVersion, platform) }
}
