<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import WaveformPane from './components/WaveformPane.vue'
import { usePracticeStore } from './stores/practice'
import { MIN_PITCH, MAX_PITCH, MIN_TEMPO, MAX_TEMPO } from './lib/math'

const store = usePracticeStore()

const fallbackFolderInput = ref<HTMLInputElement | null>(null)

const formattedTime = computed(() => {
  const format = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0')
    return `${mins}:${secs}`
  }

  return `${format(store.currentTimeSec)} / ${format(store.durationSec)}`
})

const hasLoadedTrack = computed(() => Boolean(store.loadedFile))
const controlsDisabled = computed(() => store.isImporting || !hasLoadedTrack.value)
const hasDesktopApi = computed(() => typeof window !== 'undefined' && Boolean(window.desktopApi))
const activeLoopSection = computed(
  () => store.loopSections.find((section) => section.id === store.activeLoopSectionId) ?? null,
)
const allLoopSectionsEnabled = computed(
  () => store.loopSections.length > 0 && store.loopSections.every((section) => section.enabled),
)
const canRefreshFolder = computed(() => store.hasDirectoryHandle && !store.isScanning)
const hasPendingLoopStart = computed(() => store.pendingLoopStartSec !== null)
const canResetLoopDefinition = computed(() => hasPendingLoopStart.value || Boolean(activeLoopSection.value))

const seekPercent = computed({
  get() {
    if (!store.durationSec) return 0
    return (store.currentTimeSec / store.durationSec) * 100
  },
  set(value: number) {
    if (!store.durationSec) return
    store.seek((value / 100) * store.durationSec)
  },
})

const tempoPercent = computed(() => store.tempo * 100)
const tempoDeltaBpm = computed(() => Math.round((store.tempo - 1) * 100))
const pitchHalfToneLabel = computed(() => {
  const semitones = Math.round(store.pitchSemitones)
  if (semitones === 0) return '0 half tones'
  const direction = semitones > 0 ? 'sharp' : 'flat'
  const amount = Math.abs(semitones)
  return `${amount} half tone${amount === 1 ? '' : 's'} ${direction}`
})

function nudgeTempoByBpm(deltaBpm: number) {
  const nextTempo = store.tempo + deltaBpm / 100
  store.setTempo(nextTempo)
}

async function onFileChanged(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  try {
    await store.importFile(file)
  } finally {
    target.value = ''
  }
}

async function onImportFolderClick() {
  if (hasDesktopApi.value) {
    await store.importFolder()
    return
  }
  fallbackFolderInput.value?.click()
}

async function onFallbackFolderChanged(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (!files || files.length === 0) return
  try {
    await store.importFolderFromFiles(files)
  } finally {
    target.value = ''
  }
}

async function onRefreshFolderClick() {
  if (!canRefreshFolder.value) return
  await store.refreshFolderScan()
}

function onLoopSectionStartInput(sectionId: string, value: string) {
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return
  const section = store.loopSections.find((entry) => entry.id === sectionId)
  if (!section) return
  store.updateLoopSectionRange(sectionId, parsed, section.endSec)
}

function onLoopSectionEndInput(sectionId: string, value: string) {
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return
  const section = store.loopSections.find((entry) => entry.id === sectionId)
  if (!section) return
  store.updateLoopSectionRange(sectionId, section.startSec, parsed)
}

function registerShortcuts(event: KeyboardEvent) {
  if (controlsDisabled.value) return
  if ((event.target as HTMLElement)?.closest('input, textarea, select')) return

  if (event.code === 'Space') {
    event.preventDefault()
    void store.playPause()
  } else if (event.key.toLowerCase() === 'a') {
    store.setLoopStartFromPlayhead()
  } else if (event.key.toLowerCase() === 'b') {
    store.setLoopEndFromPlayhead()
  } else if (event.key.toLowerCase() === 'l') {
    store.setLoopEnabled(!store.loop.enabled)
  } else if (event.key === 'ArrowLeft') {
    store.seekBy(-2)
  } else if (event.key === 'ArrowRight') {
    store.seekBy(2)
  } else if (event.key === 'ArrowUp') {
    store.jumpMarker(1)
  } else if (event.key === 'ArrowDown') {
    store.jumpMarker(-1)
  } else if (event.key.toLowerCase() === 'm') {
    store.addMarker()
  } else if (event.key === 'Escape') {
    store.resetLoopDefinition()
  }
}

onMounted(() => {
  window.addEventListener('keydown', registerShortcuts)
  void store.restoreLastFolder()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', registerShortcuts)
  store.teardown()
})
</script>

<template>
  <main class="app-shell">
    <div class="studio-console">
      <aside class="console-panel library-sidebar">
        <header class="panel-header library-header">
          <div class="brand-lockup">
            <span class="brand-disc" aria-hidden="true">
              <i class="bi bi-soundwave"></i>
            </span>
            <div>
              <h1 class="brand-title">ModAudio</h1>
              <p class="panel-kicker">Desktop practice console</p>
            </div>
          </div>

          <div class="import-actions">
            <button type="button" class="btn btn-primary console-btn" :disabled="store.isScanning" @click="onImportFolderClick">
              <i class="bi bi-folder2-open" aria-hidden="true"></i>
              <span>Import Folder</span>
            </button>
            <label class="btn btn-outline-light console-btn mb-0">
              <i class="bi bi-music-note-beamed" aria-hidden="true"></i>
              <span>Import Audio</span>
              <input class="d-none" type="file" accept="audio/*,video/*" @change="onFileChanged" />
            </label>
          </div>

          <div class="panel-title-row">
            <div class="min-w-0">
              <h2 class="section-title">Library</h2>
              <small class="panel-meta" :title="store.folderName || 'No folder connected'">
                {{ store.folderName || 'No folder connected' }}
              </small>
            </div>
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              :disabled="!canRefreshFolder"
              @click="onRefreshFolderClick"
            >
              <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <div class="library-track-list">
          <div class="panel-empty" v-if="store.isScanning">Scanning folder...</div>
          <div class="panel-empty" v-else-if="store.tracks.length === 0">No songs found.</div>
          <div class="panel-error" v-if="store.scanError">{{ store.scanError }}</div>

          <button
            v-for="track in store.tracks"
            :key="track.id"
            type="button"
            class="library-track-item"
            :class="{
              active: track.id === store.activeTrackId,
              loading: track.id === store.loadingTrackId,
            }"
            :title="track.relativePath"
            :disabled="store.isScanning"
            @click="store.selectTrack(track.id)"
          >
            <span class="track-index"><i class="bi bi-file-earmark-music" aria-hidden="true"></i></span>
            <span class="track-copy">
              <span class="track-name">{{ track.name }}</span>
              <span class="track-meta">{{ track.relativePath }}</span>
              <span class="track-loading" v-if="track.id === store.loadingTrackId">Loading...</span>
            </span>
          </button>
        </div>

        <div class="sidebar-footer" v-if="!store.folderConnected && store.tracks.length > 0">
          Reconnect folder to load tracks.
        </div>
      </aside>

      <section class="workspace-main">
        <header class="session-strip">
          <div class="session-copy">
            <span class="panel-kicker">Now loaded</span>
            <h2 :title="store.trackName || 'No song selected'">{{ store.trackName || 'No song selected' }}</h2>
          </div>
          <div class="session-status">
            <span class="status-pill" v-if="store.isImporting">
              <i class="bi bi-hourglass-split" aria-hidden="true"></i>
              Loading waveform...
            </span>
            <span class="status-pill muted" v-else-if="hasLoadedTrack">
              <i class="bi bi-check2-circle" aria-hidden="true"></i>
              Ready
            </span>
            <span class="status-pill muted" v-else>
              <i class="bi bi-disc" aria-hidden="true"></i>
              Standby
            </span>
          </div>
        </header>

        <div class="console-alert" v-if="store.error">{{ store.error }}</div>

        <section class="console-panel timeline-stage">
          <div class="stage-header">
            <div>
              <h2 class="section-title">Practice Timeline</h2>
              <p class="stage-subtitle">{{ activeLoopSection ? activeLoopSection.name : 'Full track' }}</p>
            </div>
            <strong class="stage-time">{{ formattedTime }}</strong>
          </div>

          <WaveformPane />

          <input
            v-model.number="seekPercent"
            class="form-range timeline-scrubber"
            type="range"
            min="0"
            max="100"
            step="0.1"
            :disabled="controlsDisabled"
          />

          <div class="transport-dock">
            <div class="loop-punch-group" role="group" aria-label="Loop controls">
              <button
                type="button"
                class="btn punch-btn punch-a"
                :class="{ armed: hasPendingLoopStart }"
                :disabled="controlsDisabled"
                :title="hasPendingLoopStart ? 'Reset A and set loop start (A) from playhead' : 'Set loop start (A) from playhead'"
                :aria-label="hasPendingLoopStart ? 'Reset A and set loop start (A) from playhead' : 'Set loop start (A) from playhead'"
                @click="store.addLoopSection"
              >
                <span class="punch-key">A</span>
                <span>{{ hasPendingLoopStart ? 'Reset A' : 'Set A' }}</span>
              </button>
              <button
                type="button"
                class="btn punch-btn punch-b"
                :disabled="controlsDisabled || !hasPendingLoopStart"
                title="Set loop end (B) and finalize section from playhead"
                aria-label="Set loop end (B) and finalize section from playhead"
                @click="store.setLoopEndFromPlayhead"
              >
                <span class="punch-key">B</span>
                <span>Set B</span>
              </button>
              <button
                type="button"
                class="btn icon-btn"
                :disabled="controlsDisabled || !canResetLoopDefinition"
                title="Reset A and B loop points"
                aria-label="Reset A and B loop points"
                @click="store.resetLoopDefinition"
              >
                <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
              </button>
            </div>

            <button
              type="button"
              class="playback-toggle-btn"
              :disabled="controlsDisabled"
              @click="store.playPause"
              :aria-label="store.isPlaying ? 'Pause' : 'Play'"
            >
              <i class="bi" :class="store.isPlaying ? 'bi-pause-fill' : 'bi-play-fill'" aria-hidden="true"></i>
            </button>

            <div class="transport-tools">
              <button
                type="button"
                class="btn btn-ghost"
                :disabled="controlsDisabled || store.loopSections.length === 0"
                :title="allLoopSectionsEnabled ? 'Disable all loop sections' : 'Enable all loop sections'"
                :aria-label="allLoopSectionsEnabled ? 'Disable all loop sections' : 'Enable all loop sections'"
                @click="store.setAllLoopSectionsEnabled(!allLoopSectionsEnabled)"
              >
                <i class="bi" :class="allLoopSectionsEnabled ? 'bi-toggle-on' : 'bi-toggle-off'" aria-hidden="true"></i>
                <span>{{ allLoopSectionsEnabled ? 'Disable All' : 'Enable All' }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="console-panel loop-timeline">
          <div class="panel-title-row">
            <div>
              <h2 class="section-title">Loops</h2>
              <p class="panel-meta" v-if="activeLoopSection">
                Active: <strong>{{ activeLoopSection.name }}</strong>
                ({{ activeLoopSection.startSec.toFixed(2) }}s - {{ activeLoopSection.endSec.toFixed(2) }}s)
              </p>
              <p class="panel-meta" v-else>No active section selected.</p>
            </div>
            <button
              type="button"
              class="btn btn-sm btn-danger-soft"
              :disabled="controlsDisabled || store.loopSections.length === 0"
              @click="store.clearAllLoopSections"
            >
              <i class="bi bi-trash3" aria-hidden="true"></i>
              <span>Clear All</span>
            </button>
          </div>

          <p v-if="hasPendingLoopStart" class="timeline-hint">
            Pending start A at {{ (store.pendingLoopStartSec ?? 0).toFixed(2) }}s. Set B to finalize this section.
          </p>
          <p
            v-if="store.loopInteractionHint"
            class="timeline-hint"
            :class="store.loopInteractionHint.startsWith('Set A first') ? 'warn' : 'info'"
            aria-live="polite"
          >
            {{ store.loopInteractionHint }}
          </p>

          <div class="timeline-empty" v-if="store.loopSections.length === 0">
            No loop sections yet. Set A then B to define a loop region.
          </div>

          <div class="loop-section-list" v-else>
            <article
              v-for="(section, index) in store.loopSections"
              :key="section.id"
              class="loop-section-row"
              :class="{ active: section.id === store.activeLoopSectionId, muted: !section.enabled }"
            >
              <div class="loop-row-index">{{ index + 1 }}</div>
              <label class="loop-switch" :title="section.enabled ? 'Disable loop section' : 'Enable loop section'">
                <input
                  type="checkbox"
                  :checked="section.enabled"
                  :disabled="controlsDisabled"
                  @change="store.setLoopSectionEnabled(section.id, ($event.target as HTMLInputElement).checked)"
                />
                <span aria-hidden="true"></span>
              </label>
              <input
                :value="section.name"
                class="form-control form-control-sm loop-name-input"
                type="text"
                :disabled="controlsDisabled"
                @change="store.renameLoopSection(section.id, ($event.target as HTMLInputElement).value)"
              />
              <label class="time-field">
                <span>Start</span>
                <input
                  :value="section.startSec.toFixed(2)"
                  class="form-control form-control-sm"
                  type="number"
                  min="0"
                  step="0.01"
                  :disabled="controlsDisabled"
                  @change="onLoopSectionStartInput(section.id, ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="time-field">
                <span>End</span>
                <input
                  :value="section.endSec.toFixed(2)"
                  class="form-control form-control-sm"
                  type="number"
                  min="0"
                  step="0.01"
                  :disabled="controlsDisabled"
                  @change="onLoopSectionEndInput(section.id, ($event.target as HTMLInputElement).value)"
                />
              </label>
              <div class="loop-row-actions">
                <button
                  type="button"
                  class="btn icon-btn"
                  :disabled="controlsDisabled"
                  title="Jump to loop section"
                  aria-label="Jump to loop section"
                  @click="store.selectLoopSection(section.id)"
                >
                  <i class="bi bi-skip-forward" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="btn icon-btn danger"
                  :disabled="controlsDisabled"
                  title="Delete loop section"
                  aria-label="Delete loop section"
                  @click="store.removeLoopSection(section.id)"
                >
                  <i class="bi bi-x-lg" aria-hidden="true"></i>
                </button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <aside class="right-rail">
        <section class="console-panel performance-rack">
          <header class="panel-header compact">
            <h2 class="section-title">Performance</h2>
          </header>

          <div class="control-strip">
            <label class="rack-control">
              <span class="control-label">
                Tempo
                <strong>
                  {{ tempoPercent.toFixed(0) }}%
                  ({{ tempoDeltaBpm >= 0 ? '+' : '' }}{{ tempoDeltaBpm }} BPM)
                </strong>
              </span>
              <input
                :value="store.tempo"
                class="form-range"
                type="range"
                :min="MIN_TEMPO"
                :max="MAX_TEMPO"
                step="0.01"
                :disabled="controlsDisabled"
                @input="store.setTempo(Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <div class="tempo-nudges">
              <button type="button" class="btn btn-sm btn-ghost" :disabled="controlsDisabled" @click="nudgeTempoByBpm(-1)">
                -1 BPM
              </button>
              <button type="button" class="btn btn-sm btn-ghost" :disabled="controlsDisabled" @click="nudgeTempoByBpm(1)">
                +1 BPM
              </button>
              <button type="button" class="btn btn-sm btn-ghost" :disabled="controlsDisabled" @click="store.setTempo(1)">
                Reset 100%
              </button>
            </div>

            <label class="rack-control">
              <span class="control-label">
                Pitch
                <strong>{{ pitchHalfToneLabel }}</strong>
              </span>
              <input
                :value="store.pitchSemitones"
                class="form-range"
                type="range"
                :min="MIN_PITCH"
                :max="MAX_PITCH"
                step="1"
                :disabled="controlsDisabled"
                @input="store.setPitchSemitones(Number(($event.target as HTMLInputElement).value))"
              />
            </label>

            <label class="rack-control">
              <span class="control-label">
                Volume
                <strong>{{ store.volume.toFixed(2) }}</strong>
              </span>
              <input
                :value="store.volume"
                class="form-range"
                type="range"
                min="0"
                max="2"
                step="0.01"
                :disabled="controlsDisabled"
                @input="store.setVolume(Number(($event.target as HTMLInputElement).value))"
              />
            </label>
          </div>
        </section>

        <section class="console-panel markers-sidebar">
          <header class="panel-header compact">
            <h2 class="section-title">Markers</h2>
          </header>
          <div class="markers-list-wrap">
            <ul class="marker-list">
              <li
                v-for="marker in store.markers"
                :key="marker.id"
                class="marker-list-item"
                :class="{ active: marker.id === store.activeMarkerId }"
              >
                <button
                  type="button"
                  class="btn marker-time"
                  :disabled="controlsDisabled"
                  @click="store.jumpToMarker(marker.id)"
                >
                  {{ marker.timeSec.toFixed(2) }}s
                </button>
                <input
                  :value="marker.label"
                  class="form-control form-control-sm"
                  type="text"
                  :disabled="controlsDisabled"
                  @change="store.renameMarker(marker.id, ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="btn icon-btn danger"
                  :disabled="controlsDisabled"
                  title="Delete marker"
                  aria-label="Delete marker"
                  @click="store.removeMarker(marker.id)"
                >
                  <i class="bi bi-x-lg" aria-hidden="true"></i>
                </button>
              </li>
            </ul>
            <div class="panel-empty" v-if="store.markers.length === 0">
              No markers yet. Add markers from the waveform.
            </div>
          </div>
        </section>
      </aside>
    </div>

    <input
      ref="fallbackFolderInput"
      class="d-none"
      type="file"
      accept="audio/*,video/*"
      webkitdirectory
      directory
      multiple
      @change="onFallbackFolderChanged"
    />
  </main>
</template>
