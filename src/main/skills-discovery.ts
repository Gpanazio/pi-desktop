import { readFile, readdir, realpath, stat } from 'fs/promises'
import { extname, join } from 'path'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'fs'
import { RPC_SKILL_PATH_PREFIX, isRpcSkillPath, type InstalledSkill } from '../shared/ipc-contracts'
import { skillDisplayName } from '../shared/pi-command'

/**
 * Per-engine skill discovery for the Skills panel.
 *
 * Each engine only lists skills it actually loads, so a skill visible under
 * OMP (e.g. from `~/.claude/skills`) is not offered while Pi runs, and
 * Pi-only skills stay hidden under OMP:
 *
 *  - Pi reads `~/.pi/agent/skills`, `~/.agents/skills` and the project's
 *    `.pi/skills` / `.agents/skills`, recursively, including bare root
 *    `<name>.md` files. A directory holding `SKILL.md` is a skill root and is
 *    not scanned further; subfolders contribute only `SKILL.md`.
 *  - OMP reads its native `.omp` roots plus Claude Code and `.agents` roots,
 *    one directory level deep (`<root>/<skill>/SKILL.md` only — OMP does not
 *    discover nested skill groups or bare root markdown files).
 */

/**
 * The `.agents/skills` root under a project or home folder. Both engines read
 * it, which makes it the one place a skill can go to reach Pi and OMP alike.
 */
export function agentsSkillsDir(root: string): string {
  return join(root, '.agents', 'skills')
}

interface SkillScanPlan {
  dirs: { dir: string; source: 'global' | 'project' }[]
  recursive: boolean
  rootMdFiles: boolean
}

function skillScanPlan(cwd: string, homeDir: string, engine: 'pi' | 'omp'): SkillScanPlan {
  if (engine === 'omp') {
    return {
      dirs: [
        { dir: join(cwd, '.omp', 'skills'), source: 'project' },
        { dir: join(homeDir, '.omp', 'agent', 'skills'), source: 'global' },
        { dir: join(cwd, '.claude', 'skills'), source: 'project' },
        { dir: join(homeDir, '.claude', 'skills'), source: 'global' },
        { dir: agentsSkillsDir(cwd), source: 'project' },
        { dir: agentsSkillsDir(homeDir), source: 'global' },
      ],
      recursive: false,
      rootMdFiles: false,
    }
  }
  return {
    dirs: [
      { dir: join(cwd, '.pi', 'skills'), source: 'project' },
      { dir: join(homeDir, '.pi', 'agent', 'skills'), source: 'global' },
      { dir: agentsSkillsDir(cwd), source: 'project' },
      { dir: agentsSkillsDir(homeDir), source: 'global' },
    ],
    recursive: true,
    rootMdFiles: true,
  }
}

export async function listSkills(
  cwd: string,
  engine: 'pi' | 'omp',
  homeDir: string = process.env.HOME ?? process.env.USERPROFILE ?? ''
): Promise<InstalledSkill[]> {
  const { dirs, recursive, rootMdFiles } = skillScanPlan(cwd, homeDir, engine)

  const skills: InstalledSkill[] = []
  for (const { dir, source } of dirs) {
    await collectSkills(dir, skills, source, { recursive, rootMdFiles, visited: new Set() })
  }
  return dedupeByName(skills)
}

/**
 * Same scan as `listSkills`, blocking. For building the agent's start args,
 * which are assembled synchronously; the Skills panel uses the async one.
 */
export function listSkillsSync(
  cwd: string,
  engine: 'pi' | 'omp',
  homeDir: string = process.env.HOME ?? process.env.USERPROFILE ?? ''
): InstalledSkill[] {
  const { dirs, recursive, rootMdFiles } = skillScanPlan(cwd, homeDir, engine)

  const skills: InstalledSkill[] = []
  for (const { dir, source } of dirs) {
    collectSkillsSync(dir, skills, source, { recursive, rootMdFiles, visited: new Set() })
  }
  return dedupeByName(skills)
}

// Both engines resolve name collisions across roots first-wins, in the same
// precedence order the scan uses.
function dedupeByName(skills: InstalledSkill[]): InstalledSkill[] {
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false
    seen.add(skill.name)
    return true
  })
}

const SKILL_FILE_EXTENSION = '.md'

/**
 * Read a skill's markdown for the Skills panel. Global skills live outside the
 * workspace, where the general file read refuses to go, so this read is
 * allowed only for the exact path of a skill file in the current skill list.
 */
export async function readListedSkillFile(skills: readonly InstalledSkill[], filePath: string): Promise<string> {
  const listed = skills.some((skill) => skill.path === filePath && !isRpcSkillPath(skill.path))
  if (!listed || extname(filePath).toLowerCase() !== SKILL_FILE_EXTENSION) {
    throw new Error('Not a listed skill file')
  }
  return readFile(filePath, 'utf-8')
}

interface CollectOptions {
  recursive: boolean
  rootMdFiles: boolean
  /** Real paths already scanned, so a symlink loop ends instead of recursing. */
  visited: Set<string>
}

type EntryAction = 'skip' | 'root-md' | 'descend' | 'check-skill-dir'

/**
 * What a directory entry means to the scan. Shared by the async and sync
 * collectors so the two cannot drift. Pi skips dotfiles and `node_modules`;
 * OMP's one-level scan keeps its original behavior.
 */
function entryAction(
  name: string,
  isFile: boolean,
  isDirectory: boolean,
  options: CollectOptions,
  isRoot: boolean
): EntryAction {
  if (options.recursive && (name.startsWith('.') || (isDirectory && name === 'node_modules'))) return 'skip'
  if (isFile && name.endsWith('.md') && name !== 'SKILL.md') {
    // Bare .md skills count only directly under the skills root
    return options.rootMdFiles && isRoot ? 'root-md' : 'skip'
  }
  if (isDirectory) return options.recursive ? 'descend' : 'check-skill-dir'
  return 'skip'
}

// Pi treats a directory holding SKILL.md as a skill root and never looks
// inside it, so `references/*.md` and the like are not skills.
const isSkillRoot = (names: readonly string[], options: CollectOptions): boolean =>
  options.recursive && names.includes('SKILL.md')

// Only Pi follows symlinks; OMP's entries keep the plain Dirent kind.
const followsSymlinks = (item: Dirent, options: CollectOptions): boolean =>
  options.recursive && item.isSymbolicLink()

async function collectSkills(
  dir: string,
  skills: InstalledSkill[],
  source: 'global' | 'project',
  options: CollectOptions,
  isRoot = true
): Promise<void> {
  try {
    if (!existsSync(dir)) return

    const real = await realpath(dir)
    if (options.visited.has(real)) return
    options.visited.add(real)

    const items = await readdir(dir, { withFileTypes: true })

    if (isSkillRoot(items.map((item) => item.name), options)) {
      await pushSkillFile(join(dir, 'SKILL.md'), skills, source)
      return
    }

    for (const item of items) {
      const fullPath = join(dir, item.name)
      let isFile = item.isFile()
      let isDirectory = item.isDirectory()
      if (followsSymlinks(item, options)) {
        try {
          const stats = await stat(fullPath)
          isFile = stats.isFile()
          isDirectory = stats.isDirectory()
        } catch {
          continue
        }
      }

      switch (entryAction(item.name, isFile, isDirectory, options, isRoot)) {
        case 'root-md':
          await pushSkillFile(fullPath, skills, source)
          break
        case 'descend':
          await collectSkills(fullPath, skills, source, options, false)
          break
        case 'check-skill-dir': {
          const skillFile = join(fullPath, 'SKILL.md')
          if (existsSync(skillFile)) await pushSkillFile(skillFile, skills, source)
          break
        }
        case 'skip':
          break
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

function collectSkillsSync(
  dir: string,
  skills: InstalledSkill[],
  source: 'global' | 'project',
  options: CollectOptions,
  isRoot = true
): void {
  try {
    if (!existsSync(dir)) return

    const real = realpathSync(dir)
    if (options.visited.has(real)) return
    options.visited.add(real)

    const items = readdirSync(dir, { withFileTypes: true })

    if (isSkillRoot(items.map((item) => item.name), options)) {
      pushSkillFileSync(join(dir, 'SKILL.md'), skills, source)
      return
    }

    for (const item of items) {
      const fullPath = join(dir, item.name)
      let isFile = item.isFile()
      let isDirectory = item.isDirectory()
      if (followsSymlinks(item, options)) {
        try {
          const stats = statSync(fullPath)
          isFile = stats.isFile()
          isDirectory = stats.isDirectory()
        } catch {
          continue
        }
      }

      switch (entryAction(item.name, isFile, isDirectory, options, isRoot)) {
        case 'root-md':
          pushSkillFileSync(fullPath, skills, source)
          break
        case 'descend':
          collectSkillsSync(fullPath, skills, source, options, false)
          break
        case 'check-skill-dir': {
          const skillFile = join(fullPath, 'SKILL.md')
          if (existsSync(skillFile)) pushSkillFileSync(skillFile, skills, source)
          break
        }
        case 'skip':
          break
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

function skillFromContent(
  filePath: string,
  content: string,
  source: 'global' | 'project'
): InstalledSkill | null {
  const parsed = parseSkillFrontmatter(content)
  if (!parsed) return null
  return { name: parsed.name, description: parsed.description, path: filePath, source, enabled: true }
}

async function pushSkillFile(
  filePath: string,
  skills: InstalledSkill[],
  source: 'global' | 'project'
): Promise<void> {
  try {
    const skill = skillFromContent(filePath, await readFile(filePath, 'utf-8'), source)
    if (skill) skills.push(skill)
  } catch {
    // Skip unreadable files
  }
}

function pushSkillFileSync(
  filePath: string,
  skills: InstalledSkill[],
  source: 'global' | 'project'
): void {
  try {
    const skill = skillFromContent(filePath, readFileSync(filePath, 'utf-8'), source)
    if (skill) skills.push(skill)
  } catch {
    // Skip unreadable files
  }
}

export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  // Windows-authored files carry CRLF endings and sometimes a UTF-8 BOM; both
  // engines still load them, so the panel must too.
  const frontmatterMatch = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

  if (!nameMatch || !descMatch) return null

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  }
}

/**
 * Merge catalog skills the disk scan missed (plugin and marketplace skills).
 * Entries carrying a real SKILL.md path stay readable; the rest get an
 * `rpc:`-prefixed pseudo-path the panel renders from the description.
 */
export function mergeRpcSkills(skills: InstalledSkill[], commands: unknown[]): void {
  const seen = new Set(skills.map((skill) => skill.name))
  for (const entry of commands) {
    if (typeof entry !== 'object' || entry === null) continue
    const cmd = entry as { name?: unknown; description?: unknown; source?: unknown; path?: unknown }
    if (cmd.source !== 'skill' || typeof cmd.name !== 'string') continue
    const name = skillDisplayName(cmd.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    skills.push({
      name,
      description: typeof cmd.description === 'string' ? cmd.description : '',
      path: typeof cmd.path === 'string' && cmd.path.length > 0 ? cmd.path : `${RPC_SKILL_PATH_PREFIX}${name}`,
      source: 'package',
      enabled: true,
    })
  }
}
