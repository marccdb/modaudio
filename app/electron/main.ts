import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; code: string; message: string }
type Result<T> = OkResult<T> | ErrResult

type DesktopTrack = {
  id: string
  name: string
  relativePath: string
  fingerprint: string
  size: number
  lastModified: number
}

type PickFolderData = {
  folderId: string
  folderName: string
  tracks: DesktopTrack[]
}

type RefreshFolderInput = { folderId: string }
type ReadTrackInput = { folderId: string; relativePath: string }
type RefreshFolderData = { tracks: DesktopTrack[] }
type ReadTrackData = {
  name: string
  mimeType: string
  arrayBuffer: ArrayBuffer
}

const CHANNELS = {
  pickFolder: 'desktop:pick-folder',
  refreshFolder: 'desktop:refresh-folder',
  readTrack: 'desktop:read-track',
} as const

const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.flac',
  '.m4a',
  '.m4b',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.weba',
  '.webm',
  '.wma',
])

const MIME_BY_EXT: Record<string, string> = {
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.webm': 'video/webm',
  '.wma': 'audio/x-ms-wma',
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DIST_DIR = path.join(__dirname, '../dist')
const ICON_PATH = path.join(__dirname, '../build/icons/icon.ico')
const APP_PROTOCOL = 'modaudio'
const APP_PROTOCOL_HOST = 'app'
const APP_INDEX_URL = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`
const MAX_FOLDER_ID_LENGTH = 128
const MAX_RELATIVE_PATH_LENGTH = 4096
const SCAN_YIELD_INTERVAL = 200
const ALLOWLIST_FILE_NAME = 'folder-allowlist.v1.json'

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

type FolderEntry = {
  absolutePath: string
  track: DesktopTrack
}

type CachedFolder = {
  folderId: string
  rootPath: string
  tracks: DesktopTrack[]
  byRelativePath: Map<string, FolderEntry>
}

const folderIdByRootPath = new Map<string, string>()
const rootPathByFolderId = new Map<string, string>()
const folderCacheById = new Map<string, CachedFolder>()
let folderIdCounter = 1
let allowlistReadyPromise: Promise<void> | null = null

type PersistedAllowlist = {
  version: 1
  folders: Array<{ folderId: string; rootPath: string }>
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function err(code: string, message: string): ErrResult {
  return { ok: false, code, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAbsolutePath(inputPath: string): string {
  return path.resolve(inputPath)
}

function toRelativeSlashPath(fromRoot: string, absolutePath: string): string {
  return path.relative(fromRoot, absolutePath).split(path.sep).join('/')
}

function isPathInside(root: string, targetPath: string): boolean {
  const relative = path.relative(root, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

function readStringField(payload: unknown, fieldName: string, maxLength: number): string | null {
  if (!isPlainObject(payload)) return null
  const value = payload[fieldName]
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > maxLength || value.includes('\0')) return null
  return value
}

function isSafeRelativePath(relativePath: string): boolean {
  if (path.isAbsolute(relativePath) || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    return false
  }
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === `${APP_PROTOCOL}:`) {
      return url.hostname === APP_PROTOCOL_HOST
    }

    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    if (!devServerUrl) return false
    const devUrl = new URL(devServerUrl)
    return url.origin === devUrl.origin
  } catch {
    return false
  }
}

function validateIpcSender(event: IpcMainInvokeEvent): ErrResult | null {
  const frameUrl = event.senderFrame?.url || event.sender.getURL()
  if (isTrustedRendererUrl(frameUrl)) return null
  return err('IPC_SENDER_FORBIDDEN', 'IPC sender is not trusted.')
}

function resolveAppProtocolPath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${APP_PROTOCOL}:` || url.hostname !== APP_PROTOCOL_HOST) {
      return null
    }

    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1)
    const targetPath = normalizeAbsolutePath(path.join(DIST_DIR, relativePath))
    if (!isPathInside(DIST_DIR, targetPath)) return null
    return targetPath
  } catch {
    return null
  }
}

function registerAppProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const targetPath = resolveAppProtocolPath(request.url)
    if (!targetPath) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const stat = await fs.stat(targetPath)
      if (!stat.isFile()) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(targetPath).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function installNavigationGuards(win: BrowserWindow): void {
  const blockUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
    }
  }

  win.webContents.on('will-navigate', blockUntrustedNavigation)
  win.webContents.on('will-redirect', blockUntrustedNavigation)
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

function isSupportedMediaPath(absolutePath: string): boolean {
  return SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())
}

function allowlistFilePath(): string {
  return path.join(app.getPath('userData'), ALLOWLIST_FILE_NAME)
}

function syncFolderIdCounter(): void {
  let nextCounter = 1
  for (const folderId of rootPathByFolderId.keys()) {
    const match = /^folder_(\d+)$/.exec(folderId)
    if (!match) continue
    const numeric = Number.parseInt(match[1], 10)
    if (!Number.isFinite(numeric)) continue
    nextCounter = Math.max(nextCounter, numeric + 1)
  }
  folderIdCounter = nextCounter
}

async function loadPersistedAllowlist(): Promise<void> {
  const filePath = allowlistFilePath()
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<PersistedAllowlist>
    if (parsed.version !== 1 || !Array.isArray(parsed.folders)) {
      return
    }

    for (const folder of parsed.folders) {
      if (!folder || typeof folder.folderId !== 'string' || typeof folder.rootPath !== 'string') {
        continue
      }
      const folderId = folder.folderId.trim()
      const rootPath = folder.rootPath.trim()
      if (!folderId || !rootPath) continue
      if (folderId.length > MAX_FOLDER_ID_LENGTH || folderId.includes('\0') || rootPath.includes('\0')) {
        continue
      }

      const normalizedRoot = normalizeAbsolutePath(rootPath)
      folderIdByRootPath.set(normalizedRoot, folderId)
      rootPathByFolderId.set(folderId, normalizedRoot)
    }

    syncFolderIdCounter()
  } catch (cause) {
    const isFileMissing = cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
    if (!isFileMissing) {
      console.warn('Failed to load persisted folder allowlist.', cause)
    }
  }
}

function ensureAllowlistLoaded(): Promise<void> {
  if (!allowlistReadyPromise) {
    allowlistReadyPromise = loadPersistedAllowlist()
  }
  return allowlistReadyPromise
}

async function savePersistedAllowlist(): Promise<void> {
  const filePath = allowlistFilePath()
  const payload: PersistedAllowlist = {
    version: 1,
    folders: Array.from(rootPathByFolderId.entries()).map(([folderId, rootPath]) => ({ folderId, rootPath })),
  }
  payload.folders.sort((a, b) => a.folderId.localeCompare(b.folderId))

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8')
}

function buildFolderId(rootPath: string): string {
  const existing = folderIdByRootPath.get(rootPath)
  if (existing) return existing

  let folderId = `folder_${folderIdCounter}`
  while (rootPathByFolderId.has(folderId)) {
    folderIdCounter += 1
    folderId = `folder_${folderIdCounter}`
  }
  folderIdCounter += 1

  folderIdByRootPath.set(rootPath, folderId)
  rootPathByFolderId.set(folderId, rootPath)
  return folderId
}

async function scanFolder(rootPath: string): Promise<CachedFolder> {
  const tracks: DesktopTrack[] = []
  const byRelativePath = new Map<string, FolderEntry>()
  const normalizedRoot = normalizeAbsolutePath(rootPath)
  const folderId = buildFolderId(normalizedRoot)
  let scannedEntries = 0

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      scannedEntries += 1
      if (scannedEntries % SCAN_YIELD_INTERVAL === 0) {
        await yieldToEventLoop()
      }

      const absolutePath = path.join(currentDir, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile() || !isSupportedMediaPath(absolutePath)) {
        continue
      }

      const stat = await fs.stat(absolutePath)
      const relativePath = toRelativeSlashPath(normalizedRoot, absolutePath)
      const fingerprint = `${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
      const track: DesktopTrack = {
        id: fingerprint,
        name: entry.name,
        relativePath,
        fingerprint,
        size: stat.size,
        lastModified: Math.trunc(stat.mtimeMs),
      }
      tracks.push(track)
      byRelativePath.set(relativePath, { absolutePath, track })
    }
  }

  await walk(normalizedRoot)
  tracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' }))
  return {
    folderId,
    rootPath: normalizedRoot,
    tracks,
    byRelativePath,
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1680,
    height: 920,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  installNavigationGuards(win)
  win.once('ready-to-show', () => {
    win.show()
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
  } else {
    await win.loadURL(APP_INDEX_URL)
  }

  return win
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.pickFolder, async (event): Promise<Result<PickFolderData>> => {
    const senderError = validateIpcSender(event)
    if (senderError) return senderError

    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      title: 'Select music folder',
      properties: ['openDirectory', 'dontAddToRecent'],
    }
    const response = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options)

    if (response.canceled || response.filePaths.length === 0) {
      return err('PICKER_CANCELLED', 'Folder selection cancelled.')
    }

    const folderPath = normalizeAbsolutePath(response.filePaths[0])
    try {
      const scanned = await scanFolder(folderPath)
      folderCacheById.set(scanned.folderId, scanned)
      try {
        await savePersistedAllowlist()
      } catch (persistCause) {
        console.warn('Failed to persist folder allowlist.', persistCause)
      }
      return ok({
        folderId: scanned.folderId,
        folderName: path.basename(scanned.rootPath),
        tracks: scanned.tracks,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Failed to scan folder.'
      return err('SCAN_FAILED', message)
    }
  })

  ipcMain.handle(
    CHANNELS.refreshFolder,
    async (event, payload: RefreshFolderInput): Promise<Result<RefreshFolderData>> => {
      await ensureAllowlistLoaded()
      const senderError = validateIpcSender(event)
      if (senderError) return senderError

      const folderId = readStringField(payload, 'folderId', MAX_FOLDER_ID_LENGTH) ?? ''
      if (!folderId) {
        return err('FOLDER_FORBIDDEN', 'Folder id is not in allowlist.')
      }

      let existing = folderCacheById.get(folderId)
      if (!existing) {
        const rootPath = rootPathByFolderId.get(folderId)
        if (!rootPath) {
          return err('FOLDER_FORBIDDEN', 'Folder id is not in allowlist.')
        }
        try {
          const hydrated = await scanFolder(rootPath)
          existing = { ...hydrated, folderId }
          folderCacheById.set(folderId, existing)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Failed to refresh folder.'
          return err('SCAN_FAILED', message)
        }
      }

      try {
        const scanned = await scanFolder(existing.rootPath)
        const refreshed: CachedFolder = {
          ...scanned,
          folderId: existing.folderId,
        }
        folderCacheById.set(folderId, refreshed)
        return ok({
          tracks: refreshed.tracks,
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Failed to refresh folder.'
        return err('SCAN_FAILED', message)
      }
    },
  )

  ipcMain.handle(CHANNELS.readTrack, async (event, payload: ReadTrackInput): Promise<Result<ReadTrackData>> => {
    await ensureAllowlistLoaded()
    const senderError = validateIpcSender(event)
    if (senderError) return senderError

    const folderId = readStringField(payload, 'folderId', MAX_FOLDER_ID_LENGTH) ?? ''
    const relativePath = readStringField(payload, 'relativePath', MAX_RELATIVE_PATH_LENGTH) ?? ''
    let existing = folderCacheById.get(folderId)
    if (!existing && folderId) {
      const rootPath = rootPathByFolderId.get(folderId)
      if (rootPath) {
        try {
          const hydrated = await scanFolder(rootPath)
          existing = { ...hydrated, folderId }
          folderCacheById.set(folderId, existing)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Failed to refresh folder.'
          return err('SCAN_FAILED', message)
        }
      }
    }

    if (!existing) {
      return err('TRACK_FORBIDDEN', 'Folder id is not in allowlist.')
    }

    if (!isSafeRelativePath(relativePath)) {
      return err('TRACK_FORBIDDEN', 'Track path is not valid.')
    }

    const entry = existing.byRelativePath.get(relativePath)
    if (!entry || !isPathInside(existing.rootPath, entry.absolutePath)) {
      return err('TRACK_FORBIDDEN', 'Track path is not in allowlist.')
    }

    try {
      const [stat, buffer] = await Promise.all([fs.stat(entry.absolutePath), fs.readFile(entry.absolutePath)])
      if (!stat.isFile()) {
        return err('TRACK_NOT_FILE', 'Track path is not a file.')
      }
      const extension = path.extname(entry.absolutePath).toLowerCase()
      return ok({
        name: path.basename(entry.absolutePath),
        mimeType: MIME_BY_EXT[extension] ?? 'application/octet-stream',
        arrayBuffer: bufferToArrayBuffer(buffer),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Failed to read track.'
      return err('READ_FAILED', message)
    }
  })
}

app.whenReady().then(async () => {
  registerAppProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  Menu.setApplicationMenu(null)
  registerIpcHandlers()
  await createMainWindow()
  void ensureAllowlistLoaded()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
