import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { AudioEngine } from '../lib/audioEngine'
import {
  MIN_LOOP_DURATION_SEC,
  clamp,
  normalizeLoop,
  normalizePitchSemitones,
  normalizeTempo,
  makeFingerprint,
  makeProjectKey,
} from '../lib/math'
import { IndexedDbProjectRepository } from '../lib/projectRepository'
import {
  createFolderTrack,
  createTrackIndexId,
  getRelativePathFromInputFile,
  isSupportedMediaFile,
  sortTracksByPath,
} from '../lib/folderLibrary'
import { IndexedDbFolderLibraryRepository } from '../lib/folderLibraryRepository'
import type { DesktopApi, DesktopTrack } from '../types/desktopApi'
import type {
  FolderTrack,
  LibrarySnapshot,
  LoopMode,
  LoopRange,
  LoopSection,
  Marker,
  PracticeProject,
} from '../types/practice'

const SCHEMA_VERSION = 2
const AUTOSAVE_DEBOUNCE_MS = 200
const repository = new IndexedDbProjectRepository()
const libraryRepository = new IndexedDbFolderLibraryRepository()

function nextId() {
  return Math.random().toString(36).slice(2, 10)
}

function createDefaultLoop(durationSec: number): LoopRange {
  return {
    enabled: false,
    startSec: 0,
    endSec: Math.max(durationSec, MIN_LOOP_DURATION_SEC),
    mode: 'forever',
  }
}

function normalizeLoopSection(section: LoopSection, durationSec: number): LoopSection {
  const normalized = normalizeLoop(
    {
      enabled: true,
      startSec: section.startSec,
      endSec: section.endSec,
      mode: 'forever',
    },
    durationSec,
  )

  return {
    ...section,
    startSec: normalized.startSec,
    endSec: normalized.endSec,
  }
}

function makeLoopSection(durationSec: number, startSec: number, endSec: number, name?: string): LoopSection {
  const section = normalizeLoopSection(
    {
      id: nextId(),
      name: name?.trim() || '',
      startSec,
      endSec,
      enabled: true,
    },
    durationSec,
  )
  return {
    ...section,
    name: section.name || `Section`,
  }
}

function normalizeTime(timeSec: number, durationSec: number): number {
  const max = Math.max(durationSec, 0)
  return clamp(timeSec, 0, max)
}

function getDesktopApi(): DesktopApi | null {
  if (typeof window === 'undefined') return null
  return window.desktopApi ?? null
}

function toDesktopFolderTrack(track: DesktopTrack): FolderTrack {
  return {
    id: track.id,
    name: track.name,
    relativePath: track.relativePath,
    fingerprint: track.fingerprint,
    lastModified: track.lastModified,
    size: track.size,
    sourceType: 'desktop-directory',
  }
}

export const usePracticeStore = defineStore('practice', () => {
  const engine = new AudioEngine()
  const autosaveSuspended = ref(false)
  const isImporting = ref(false)
  const tracks = ref<FolderTrack[]>([])
  const activeTrackId = ref<string | null>(null)
  const loadingTrackId = ref<string | null>(null)
  const folderName = ref('')
  const isScanning = ref(false)
  const scanError = ref('')
  const folderConnected = ref(false)
  const folderId = ref<string | null>(null)
  const librarySourceType = ref<LibrarySnapshot['sourceType'] | null>(null)
  const hasDirectoryHandle = computed(
    () => librarySourceType.value === 'desktop-directory' && Boolean(folderId.value),
  )

  const projectId = ref('')
  const trackName = ref('')
  const fingerprint = ref('')
  const fileObjectUrl = ref('')

  const tempo = ref(1)
  const pitchSemitones = ref(0)
  const pitchCents = ref(0)
  const volume = ref(1)
  const durationSec = ref(0)
  const currentTimeSec = ref(0)
  const isPlaying = ref(false)
  const loop = ref<LoopRange>(createDefaultLoop(1))
  const loopSections = ref<LoopSection[]>([])
  const activeLoopSectionId = ref<string | null>(null)
  const pendingLoopStartSec = ref<number | null>(null)
  const pendingLoopTargetSectionId = ref<string | null>(null)
  const loopInteractionHint = ref('')
  const markers = ref<Marker[]>([])
  const activeMarkerId = ref<string | null>(null)
  const error = ref('')
  const loadedFile = ref<File | null>(null)
  const transientFiles = new Map<string, File>()
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null

  const currentProject = computed<PracticeProject | null>(() => {
    if (!projectId.value) return null
    const projectLoop = loop.value
    const projectMarkers = markers.value
    return {
      id: projectId.value,
      schemaVersion: SCHEMA_VERSION,
      trackName: trackName.value,
      fingerprint: fingerprint.value,
      durationSec: durationSec.value,
      tempo: tempo.value,
      pitchSemitones: pitchSemitones.value,
      pitchCents: pitchCents.value,
      volume: volume.value,
      loop: {
        enabled: projectLoop.enabled,
        startSec: projectLoop.startSec,
        endSec: projectLoop.endSec,
        mode: projectLoop.mode,
      },
      loopSections: loopSections.value.map((section) => ({
        id: section.id,
        name: section.name,
        startSec: section.startSec,
        endSec: section.endSec,
        enabled: section.enabled,
      })),
      activeLoopSectionId: activeLoopSectionId.value,
      markers: projectMarkers.map((marker) => ({
        id: marker.id,
        label: marker.label,
        timeSec: marker.timeSec,
      })),
      effects: {
        gain: volume.value,
        pan: 0,
      },
      updatedAt: new Date().toISOString(),
    }
  })

  const unsubscribeTime = engine.on('timeupdate', ({ currentTime, duration }) => {
    currentTimeSec.value = currentTime
    durationSec.value = duration
  })

  const unsubscribeState = engine.on('statechange', ({ isPlaying: playing }) => {
    isPlaying.value = playing
  })

  const unsubscribeLoop = engine.on('loopchange', (nextLoop) => {
    loop.value = normalizeLoop({ ...nextLoop, mode: 'forever' }, durationSec.value || MIN_LOOP_DURATION_SEC)
    if (!activeLoopSectionId.value) return
    loopSections.value = loopSections.value.map((section) =>
      section.id === activeLoopSectionId.value ? { ...section, enabled: loop.value.enabled } : section,
    )
  })

  const unsubscribeError = engine.on('error', ({ message }) => {
    error.value = message
  })

  const unsubscribeLoaded = engine.on('loaded', ({ duration }) => {
    durationSec.value = duration
    loop.value = normalizeLoop({ ...loop.value, mode: 'forever' }, duration)
  })

  function teardown() {
    unsubscribeTime()
    unsubscribeState()
    unsubscribeLoop()
    unsubscribeError()
    unsubscribeLoaded()
    if (autosaveTimer) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
  }

  async function importFile(
    file: File,
    trackContext?: { relativePath?: string | null },
    preloadedBuffer?: ArrayBuffer,
  ): Promise<void> {
    autosaveSuspended.value = true
    isImporting.value = true

    try {
      error.value = ''
      const nextFingerprint = makeFingerprint(file)
      const nextProjectId = makeProjectKey(file, trackContext?.relativePath)

      await engine.loadArrayBuffer(preloadedBuffer ?? (await file.arrayBuffer()))
      const nextFileObjectUrl = URL.createObjectURL(file)
      const previousFileObjectUrl = fileObjectUrl.value

      loadedFile.value = file
      trackName.value = file.name
      fingerprint.value = nextFingerprint
      projectId.value = nextProjectId
      fileObjectUrl.value = nextFileObjectUrl
      if (previousFileObjectUrl) {
        URL.revokeObjectURL(previousFileObjectUrl)
      }

      tempo.value = engine.setTempo(1)
      pitchSemitones.value = engine.setPitch(0)
      pitchCents.value = 0
      volume.value = engine.setVolume(1)
      currentTimeSec.value = 0
      loop.value = createDefaultLoop(durationSec.value)
      loopSections.value = []
      activeLoopSectionId.value = null
      pendingLoopStartSec.value = null
      pendingLoopTargetSectionId.value = null
      loopInteractionHint.value = ''
      markers.value = []
      activeMarkerId.value = null
      engine.setLoop(loop.value)

      let existing = await repository.get(nextProjectId)
      if (!existing && nextProjectId !== nextFingerprint) {
        existing = await repository.get(nextFingerprint)
      }
      if (existing) {
        applyProject(existing)
      }

      if (!trackContext?.relativePath) {
        activeTrackId.value = null
        try {
          await saveLibrarySnapshot()
        } catch (saveIssue) {
          console.warn('Failed to persist cleared library selection.', saveIssue)
        }
      }
    } finally {
      isImporting.value = false
      autosaveSuspended.value = false
    }
  }

  function makeLibrarySnapshot(sourceType: LibrarySnapshot['sourceType']): LibrarySnapshot {
    return {
      folderName: folderName.value,
      tracks: tracks.value,
      activeTrackId: activeTrackId.value,
      sourceType,
      folderId: sourceType === 'desktop-directory' ? folderId.value : null,
      updatedAt: new Date().toISOString(),
    }
  }

  function clearTransientFiles() {
    transientFiles.clear()
  }

  async function saveLibrarySnapshot(sourceType = librarySourceType.value ?? 'webkitdirectory') {
    await libraryRepository.saveSnapshot(makeLibrarySnapshot(sourceType))
  }

  function buildTracksFromInputFiles(files: Iterable<File>): FolderTrack[] {
    const discoveredTracks: FolderTrack[] = []
    const seenTrackIds = new Set<string>()
    clearTransientFiles()
    for (const file of files) {
      if (!isSupportedMediaFile(file)) continue
      const relativePath = getRelativePathFromInputFile(file)
      const baseTrack = createFolderTrack(file, relativePath, 'webkitdirectory')
      const trackId = seenTrackIds.has(baseTrack.id)
        ? createTrackIndexId(relativePath, file.lastModified, file.size)
        : baseTrack.id
      const track = { ...baseTrack, id: trackId }
      seenTrackIds.add(track.id)
      discoveredTracks.push(track)
      transientFiles.set(track.id, file)
    }
    return sortTracksByPath(discoveredTracks)
  }

  async function loadTrackFile(track: FolderTrack): Promise<{ file: File; arrayBuffer?: ArrayBuffer }> {
    const directFile = transientFiles.get(track.id)
    if (directFile) return { file: directFile }

    if (track.sourceType === 'desktop-directory' && folderId.value) {
      const desktopApi = getDesktopApi()
      if (!desktopApi) {
        throw new Error('Desktop API unavailable. Restart app and retry folder import.')
      }

      const response = await desktopApi.readTrack(folderId.value, track.relativePath)
      if (!response.ok) {
        throw new Error(response.message || 'Failed to read selected track.')
      }

      const file = new File([response.data.arrayBuffer], response.data.name, {
        type: response.data.mimeType || 'application/octet-stream',
        lastModified: track.lastModified,
      })
      transientFiles.set(track.id, file)
      return { file, arrayBuffer: response.data.arrayBuffer }
    }

    throw new Error('Track file unavailable. Re-import folder to reconnect files.')
  }

  async function selectTrack(trackId: string): Promise<void> {
    const track = tracks.value.find((item) => item.id === trackId)
    if (!track) return

    error.value = ''
    scanError.value = ''
    loadingTrackId.value = trackId
    try {
      const loadedTrack = await loadTrackFile(track)
      await importFile(loadedTrack.file, { relativePath: track.relativePath }, loadedTrack.arrayBuffer)
      activeTrackId.value = trackId
      folderConnected.value = true
      await saveLibrarySnapshot()
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load selected track.'
      scanError.value = message
      folderConnected.value = false
    } finally {
      loadingTrackId.value = null
    }
  }

  async function importFolder(): Promise<void> {
    const desktopApi = getDesktopApi()
    if (!desktopApi) {
      scanError.value = 'Desktop folder import unavailable. Use fallback folder input.'
      return
    }

    isScanning.value = true
    scanError.value = ''
    try {
      const response = await desktopApi.pickFolder()
      if (!response.ok) {
        if (response.code === 'PICKER_CANCELLED') {
          return
        }
        scanError.value = response.message || 'Unable to import folder.'
        folderConnected.value = false
        return
      }

      folderId.value = response.data.folderId
      folderName.value = response.data.folderName
      tracks.value = response.data.tracks.map(toDesktopFolderTrack)
      librarySourceType.value = 'desktop-directory'
      activeTrackId.value = null
      folderConnected.value = true
      clearTransientFiles()

      if (tracks.value.length === 0) {
        scanError.value = 'No songs found.'
      }

      await saveLibrarySnapshot('desktop-directory')
    } catch (scanIssue) {
      const message = scanIssue instanceof Error ? scanIssue.message : 'Unable to import folder.'
      scanError.value = message
      folderConnected.value = false
    } finally {
      isScanning.value = false
    }
  }

  async function importFolderFromFiles(fileList: FileList | File[]): Promise<void> {
    isScanning.value = true
    scanError.value = ''
    try {
      const files = Array.from(fileList)
      tracks.value = buildTracksFromInputFiles(files)
      activeTrackId.value = null
      folderId.value = null
      librarySourceType.value = 'webkitdirectory'
      folderConnected.value = true

      const firstRelativePath = tracks.value[0]?.relativePath || (files[0] ? getRelativePathFromInputFile(files[0]) : '')
      const rootDir = firstRelativePath.split('/')[0]
      folderName.value = rootDir || 'Imported Folder'

      if (tracks.value.length === 0) {
        scanError.value = files.length > 0 ? 'Unsupported file type.' : 'No songs found.'
      }

      await saveLibrarySnapshot('webkitdirectory')
    } finally {
      isScanning.value = false
    }
  }

  async function refreshFolderScan(): Promise<void> {
    if (isScanning.value) return
    scanError.value = ''
    if (librarySourceType.value !== 'desktop-directory' || !folderId.value) {
      scanError.value = 'Folder refresh unavailable. Re-import folder.'
      return
    }

    isScanning.value = true
    try {
      const desktopApi = getDesktopApi()
      if (!desktopApi) {
        scanError.value = 'Desktop API unavailable. Restart app and retry.'
        folderConnected.value = false
        return
      }

      const response = await desktopApi.refreshFolder(folderId.value)
      if (!response.ok) {
        scanError.value = response.message || 'Failed to refresh folder.'
        folderConnected.value = false
        return
      }

      tracks.value = response.data.tracks.map(toDesktopFolderTrack)
      folderConnected.value = true
      if (tracks.value.length === 0) {
        scanError.value = 'No songs found.'
      }

      if (activeTrackId.value && !tracks.value.some((track) => track.id === activeTrackId.value)) {
        activeTrackId.value = null
      }

      clearTransientFiles()
      await saveLibrarySnapshot('desktop-directory')
    } catch (refreshIssue) {
      const message = refreshIssue instanceof Error ? refreshIssue.message : 'Failed to refresh folder.'
      scanError.value = message
      folderConnected.value = false
    } finally {
      isScanning.value = false
    }
  }

  async function restoreLastFolder(): Promise<void> {
    const snapshot = await libraryRepository.getSnapshot()
    if (!snapshot) return

    folderName.value = snapshot.folderName
    tracks.value = sortTracksByPath(snapshot.tracks)
    activeTrackId.value = snapshot.activeTrackId
    folderId.value = snapshot.folderId
    librarySourceType.value = snapshot.sourceType
    scanError.value = ''
    clearTransientFiles()

    if (snapshot.sourceType === 'desktop-directory' && snapshot.folderId) {
      if (!getDesktopApi()) {
        folderConnected.value = false
        scanError.value = 'Desktop API unavailable. Re-import folder.'
        return
      }
      folderConnected.value = true
      await refreshFolderScan()
      if (!folderConnected.value) {
        return
      }

      if (activeTrackId.value) {
        await selectTrack(activeTrackId.value)
      }
      return
    }

    folderId.value = null
    folderConnected.value = false
    if (tracks.value.length > 0) {
      scanError.value = 'Folder needs re-import after reload in this browser.'
    }
  }

  function applyProject(project: PracticeProject) {
    tempo.value = normalizeTempo(project.tempo)
    pitchSemitones.value = normalizePitchSemitones(project.pitchSemitones)
    pitchCents.value = project.pitchCents
    volume.value = engine.setVolume(project.volume)
    const sourceDuration = durationSec.value || project.durationSec || MIN_LOOP_DURATION_SEC
    const migratedSections = (project.loopSections ?? [])
      .map((section, index) =>
        normalizeLoopSection(
          {
            id: section.id || nextId(),
            name: section.name?.trim() || `Section ${index + 1}`,
            startSec: section.startSec,
            endSec: section.endSec,
            enabled: (section as LoopSection & { enabled?: boolean }).enabled ?? project.loop.enabled ?? true,
          },
          sourceDuration,
        ),
      )
      .sort((a, b) => a.startSec - b.startSec)

    if (migratedSections.length === 0 && project.loop?.enabled) {
      const legacySection = normalizeLoopSection(
        {
          id: nextId(),
          name: 'Section 1',
          startSec: project.loop.startSec,
          endSec: project.loop.endSec,
          enabled: true,
        },
        sourceDuration,
      )
      migratedSections.push(legacySection)
    }

    loopSections.value = migratedSections.map((section, index) => ({
      ...section,
      name: section.name?.trim() || `Section ${index + 1}`,
    }))

    const requestedActiveId = project.activeLoopSectionId ?? null
    const activeSection =
      loopSections.value.find((section) => section.id === requestedActiveId) ?? loopSections.value[0] ?? null

    activeLoopSectionId.value = activeSection?.id ?? null
    pendingLoopStartSec.value = null
    pendingLoopTargetSectionId.value = null
    loopInteractionHint.value = ''
    loop.value = activeSection
      ? {
          enabled: activeSection.enabled,
          startSec: activeSection.startSec,
          endSec: activeSection.endSec,
          mode: 'forever',
        }
      : createDefaultLoop(sourceDuration)

    markers.value = project.markers.slice().sort((a, b) => a.timeSec - b.timeSec)
    activeMarkerId.value = markers.value[0]?.id ?? null

    tempo.value = engine.setTempo(tempo.value)
    pitchSemitones.value = engine.setPitch(pitchSemitones.value)
    engine.setLoop(loop.value)
  }

  async function saveProject() {
    const project = currentProject.value
    if (!project) return
    await repository.save(project)
  }

  function setTempo(value: number) {
    tempo.value = engine.setTempo(value)
  }

  function setPitchSemitones(value: number) {
    pitchSemitones.value = engine.setPitch(value)
  }

  function setVolume(value: number) {
    volume.value = engine.setVolume(value)
  }

  function setLoopMode(_mode: LoopMode) {
    loop.value = { ...loop.value, mode: 'forever' }
    engine.setLoop(loop.value)
  }

  function setLoopEnabled(enabled: boolean) {
    if (!activeLoopSectionId.value) return
    setLoopSectionEnabled(activeLoopSectionId.value, enabled)
  }

  function updateLoop(nextLoop: LoopRange) {
    loop.value = normalizeLoop({ ...nextLoop, mode: 'forever' }, durationSec.value || MIN_LOOP_DURATION_SEC)
    if (activeLoopSectionId.value) {
      loopSections.value = loopSections.value.map((section) =>
        section.id === activeLoopSectionId.value
          ? {
              ...section,
              startSec: loop.value.startSec,
              endSec: loop.value.endSec,
            }
          : section,
      )
    }
    engine.setLoop(loop.value)
  }

  function syncActiveLoopSectionToEngine() {
    const activeSection = loopSections.value.find((section) => section.id === activeLoopSectionId.value) ?? null
    if (!activeSection) {
      loop.value = { ...loop.value, enabled: false }
      engine.setLoop(loop.value)
      return
    }

    loop.value = normalizeLoop(
      {
        ...loop.value,
        enabled: activeSection.enabled,
        startSec: activeSection.startSec,
        endSec: activeSection.endSec,
        mode: 'forever',
      },
      durationSec.value || MIN_LOOP_DURATION_SEC,
    )
    engine.setLoop(loop.value)
  }

  function setLoopStartFromPlayhead() {
    setPendingLoopStartAtTime(currentTimeSec.value, activeLoopSectionId.value)
  }

  function setLoopEndFromPlayhead() {
    finalizeLoopEndAtTime(currentTimeSec.value)
  }

  function clearPendingLoopStart() {
    pendingLoopStartSec.value = null
    pendingLoopTargetSectionId.value = null
  }

  function setPendingLoopStartAtTime(timeSec: number, targetSectionId: string | null) {
    const duration = durationSec.value || MIN_LOOP_DURATION_SEC
    const clampedTime = normalizeTime(timeSec, duration)
    pendingLoopStartSec.value = clampedTime
    pendingLoopTargetSectionId.value = targetSectionId
    loopInteractionHint.value = targetSectionId
      ? 'Loop start (A) set. Press B to update active section.'
      : 'Loop start (A) set. Press B to create section.'
  }

  function finalizeLoopEndAtTime(timeSec: number) {
    const duration = durationSec.value || MIN_LOOP_DURATION_SEC
    const clampedTime = normalizeTime(timeSec, duration)

    if (pendingLoopStartSec.value == null) {
      loopInteractionHint.value = 'Set A first, then press B.'
      return
    }

    let startSec = pendingLoopStartSec.value
    let endSec = clampedTime
    const wasSwapped = endSec < startSec
    if (wasSwapped) {
      ;[startSec, endSec] = [endSec, startSec]
    }

    let targetSectionId = pendingLoopTargetSectionId.value
    clearPendingLoopStart()
    if (targetSectionId && !loopSections.value.some((section) => section.id === targetSectionId)) {
      targetSectionId = null
    }

    if (targetSectionId) {
      loopSections.value = loopSections.value
        .map((section) =>
          section.id === targetSectionId
            ? normalizeLoopSection(
                {
                  ...section,
                  startSec,
                  endSec,
                },
                duration,
              )
            : section,
        )
        .sort((a, b) => a.startSec - b.startSec)
      activeLoopSectionId.value = targetSectionId
      loopInteractionHint.value = wasSwapped
        ? 'Loop updated. End before start; boundaries swapped.'
        : 'Loop updated from A to B.'
    } else {
      const section = makeLoopSection(duration, startSec, endSec, `Section ${loopSections.value.length + 1}`)
      loopSections.value = [...loopSections.value, section].sort((a, b) => a.startSec - b.startSec)
      activeLoopSectionId.value = section.id
      loopInteractionHint.value = wasSwapped
        ? 'New loop section created. End before start; boundaries swapped.'
        : 'New loop section created from A to B.'
    }

    syncActiveLoopSectionToEngine()
  }

  function setLoopStartAtTime(timeSec: number) {
    setPendingLoopStartAtTime(timeSec, activeLoopSectionId.value)
  }

  function setLoopEndAtTime(timeSec: number) {
    finalizeLoopEndAtTime(timeSec)
  }

  function resetLoop() {
    clearPendingLoopStart()
    loopInteractionHint.value = ''
    loop.value = createDefaultLoop(durationSec.value || 1)
    engine.setLoop(loop.value)
  }

  function resetLoopDefinition() {
    clearPendingLoopStart()
    activeLoopSectionId.value = null
    loop.value = createDefaultLoop(durationSec.value || 1)
    loopInteractionHint.value = 'A/B definition cleared.'
    engine.setLoop(loop.value)
  }

  function addLoopSection() {
    setPendingLoopStartAtTime(currentTimeSec.value, null)
  }

  function selectLoopSection(sectionId: string, jumpToStart = true) {
    const section = loopSections.value.find((value) => value.id === sectionId)
    if (!section) return
    activeLoopSectionId.value = section.id
    loop.value = {
      ...loop.value,
      enabled: section.enabled,
      startSec: section.startSec,
      endSec: section.endSec,
      mode: 'forever',
    }
    engine.setLoop(loop.value)
    if (jumpToStart) {
      seek(section.startSec)
    }
  }

  function clearActiveLoopSection() {
    activeLoopSectionId.value = null
    clearPendingLoopStart()
    loop.value = { ...loop.value, enabled: false }
    engine.setLoop(loop.value)
  }

  function setLoopSectionEnabled(sectionId: string, enabled: boolean) {
    loopSections.value = loopSections.value.map((section) => (section.id === sectionId ? { ...section, enabled } : section))
    if (activeLoopSectionId.value === sectionId) {
      syncActiveLoopSectionToEngine()
    }
  }

  function setAllLoopSectionsEnabled(enabled: boolean) {
    if (loopSections.value.length === 0) return
    loopSections.value = loopSections.value.map((section) => ({ ...section, enabled }))
    syncActiveLoopSectionToEngine()
  }

  function clearAllLoopSections() {
    if (loopSections.value.length === 0) return
    loopSections.value = []
    clearActiveLoopSection()
    loopInteractionHint.value = 'All loop sections cleared.'
  }

  function removeLoopSection(sectionId: string) {
    loopSections.value = loopSections.value.filter((section) => section.id !== sectionId)
    if (pendingLoopTargetSectionId.value === sectionId) {
      pendingLoopTargetSectionId.value = null
    }
    if (activeLoopSectionId.value !== sectionId) return

    const nextSection = loopSections.value[0] ?? null
    if (!nextSection) {
      clearActiveLoopSection()
      return
    }

    selectLoopSection(nextSection.id, false)
  }

  function renameLoopSection(sectionId: string, name: string) {
    const trimmed = name.trim()
    loopSections.value = loopSections.value.map((section) =>
      section.id === sectionId
        ? {
            ...section,
            name: trimmed || section.name,
          }
        : section,
    )
  }

  function updateLoopSectionRange(sectionId: string, startSec: number, endSec: number) {
    const duration = durationSec.value || MIN_LOOP_DURATION_SEC
    loopSections.value = loopSections.value
      .map((section) =>
        section.id === sectionId
          ? normalizeLoopSection(
              {
                ...section,
                startSec,
                endSec,
              },
              duration,
            )
          : section,
      )
      .sort((a, b) => a.startSec - b.startSec)

    if (activeLoopSectionId.value === sectionId) {
      syncActiveLoopSectionToEngine()
    }
  }

  function addMarker(label = '') {
    addMarkerAtTime(currentTimeSec.value, label)
  }

  function addMarkerAtTime(timeSec: number, label = '') {
    const markerTime = normalizeTime(timeSec, durationSec.value || MIN_LOOP_DURATION_SEC)
    const marker: Marker = {
      id: nextId(),
      label: label || `M${markers.value.length + 1}`,
      timeSec: markerTime,
    }
    markers.value = [...markers.value, marker].sort((a, b) => a.timeSec - b.timeSec)
    activeMarkerId.value = marker.id
  }

  function removeMarker(markerId: string) {
    markers.value = markers.value.filter((marker) => marker.id !== markerId)
    if (activeMarkerId.value === markerId) {
      activeMarkerId.value = markers.value[0]?.id ?? null
    }
  }

  function renameMarker(markerId: string, label: string) {
    markers.value = markers.value.map((marker) =>
      marker.id === markerId ? { ...marker, label: label.trim() || marker.label } : marker,
    )
  }

  function seek(seconds: number) {
    const clamped = Math.max(0, Math.min(durationSec.value || 0, seconds))
    engine.seek(clamped)
    currentTimeSec.value = clamped
  }

  function jumpToMarker(markerId: string) {
    const marker = markers.value.find((value) => value.id === markerId)
    if (!marker) return
    activeMarkerId.value = marker.id
    seek(marker.timeSec)
  }

  function jumpMarker(step: 1 | -1) {
    if (markers.value.length === 0) return
    const sorted = [...markers.value].sort((a, b) => a.timeSec - b.timeSec)
    const currentIdx = activeMarkerId.value
      ? sorted.findIndex((marker) => marker.id === activeMarkerId.value)
      : -1
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + step + sorted.length) % sorted.length
    jumpToMarker(sorted[nextIdx].id)
  }

  async function playPause() {
    if (isPlaying.value) {
      engine.pause()
    } else {
      await engine.play()
    }
  }

  async function playFrom(seconds: number) {
    seek(seconds)
    if (!isPlaying.value) {
      await engine.play()
    }
  }

  function seekBy(deltaSec: number) {
    seek(Math.max(0, Math.min(durationSec.value, currentTimeSec.value + deltaSec)))
  }

  watch(
    () => [
      tempo.value,
      pitchSemitones.value,
      pitchCents.value,
      volume.value,
      loop.value,
      loopSections.value,
      activeLoopSectionId.value,
      markers.value,
    ],
    () => {
      if (autosaveSuspended.value) return
      if (autosaveTimer) {
        clearTimeout(autosaveTimer)
      }
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null
        void saveProject()
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    { deep: true },
  )

  return {
    tracks,
    activeTrackId,
    loadingTrackId,
    folderName,
    isScanning,
    scanError,
    folderConnected,
    hasDirectoryHandle,
    projectId,
    trackName,
    fingerprint,
    fileObjectUrl,
    tempo,
    pitchSemitones,
    pitchCents,
    volume,
    durationSec,
    currentTimeSec,
    isPlaying,
    loop,
    loopSections,
    activeLoopSectionId,
    pendingLoopStartSec,
    loopInteractionHint,
    markers,
    activeMarkerId,
    error,
    loadedFile,
    isImporting,
    importFolder,
    importFolderFromFiles,
    restoreLastFolder,
    selectTrack,
    refreshFolderScan,
    importFile,
    setTempo,
    setPitchSemitones,
    setVolume,
    setLoopMode,
    setLoopEnabled,
    updateLoop,
    setLoopStartFromPlayhead,
    setLoopEndFromPlayhead,
    resetLoop,
    resetLoopDefinition,
    addLoopSection,
    selectLoopSection,
    clearActiveLoopSection,
    removeLoopSection,
    renameLoopSection,
    updateLoopSectionRange,
    setLoopStartAtTime,
    setLoopEndAtTime,
    setLoopSectionEnabled,
    setAllLoopSectionsEnabled,
    clearAllLoopSections,
    addMarker,
    addMarkerAtTime,
    removeMarker,
    renameMarker,
    jumpToMarker,
    jumpMarker,
    seek,
    seekBy,
    playPause,
    playFrom,
    saveProject,
    teardown,
  }
})
