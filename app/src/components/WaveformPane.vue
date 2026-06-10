<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type WaveSurfer from 'wavesurfer.js'
import type { Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { usePracticeStore } from '../stores/practice'

type RegionsPluginModule = typeof import('wavesurfer.js/dist/plugins/regions.esm.js').default
type RegionsPluginInstance = ReturnType<RegionsPluginModule['create']>

const store = usePracticeStore()

const host = ref<HTMLElement | null>(null)
const scrollHost = ref<HTMLElement | null>(null)
const contextMenuEl = ref<HTMLElement | null>(null)
const fitPxPerSec = ref(1)
const zoomFactor = ref(1)
const MIN_ZOOM_FACTOR = 1
const MAX_ZOOM_FACTOR = 8
const ZOOM_STEP = 0.25
const WHEEL_ZOOM_STEP = 0.1
const A_MARKER_LINE_COLOR = '#e35353'
const B_MARKER_LINE_COLOR = '#6ecce6'
const REGULAR_MARKER_LINE_COLOR = '#e35353'

let waveSurfer: WaveSurfer | null = null
let regionsPlugin: RegionsPluginInstance | null = null
const loopRegions = new Map<string, Region>()
let updatingLoopSectionFromRegion = false
let waveSurferReady: Promise<void> | null = null
const waveSurferCleanups: Array<() => void> = []
const isPanning = ref(false)
let panStartX = 0
let panStartScroll = 0
let panDistance = 0
let suppressClickFromPan = false
const waveContentWidth = ref(0)
const waveScrollLeft = ref(0)
const onWindowResize = () => refreshFitZoom(0.5)

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  timeSec: 0,
})

const hasAudio = computed(() => Boolean(store.fileObjectUrl))
const canZoomOut = computed(() => zoomFactor.value > MIN_ZOOM_FACTOR)
const canZoomIn = computed(() => zoomFactor.value < MAX_ZOOM_FACTOR)
const explicitMarkerA = computed(() => store.markers.find((marker) => marker.label.trim().toUpperCase() === 'A') ?? null)
const explicitMarkerB = computed(() => store.markers.find((marker) => marker.label.trim().toUpperCase() === 'B') ?? null)
const markerATimeSec = computed(() => store.pendingLoopStartSec ?? explicitMarkerA.value?.timeSec ?? null)
const markerBTimeSec = computed(() => explicitMarkerB.value?.timeSec ?? null)
const regularMarkers = computed(() =>
  store.markers.filter((marker) => {
    const normalized = marker.label.trim().toUpperCase()
    return normalized !== 'A' && normalized !== 'B'
  }),
)

function getWaveColors() {
  return {
    waveColor: '#c7d0d8',
    progressColor: '#d99a2b',
    cursorColor: '#f0f2ea',
  }
}

function applyWaveTheme() {
  if (!waveSurfer) return
  const colors = getWaveColors()
  waveSurfer.setOptions({
    waveColor: colors.waveColor,
    progressColor: colors.progressColor,
    cursorColor: colors.cursorColor,
  })
}

function getFitPxPerSec() {
  if (!scrollHost.value || !store.durationSec) return 1
  return Math.max(scrollHost.value.clientWidth / store.durationSec, 0.01)
}

function getWaveWrapper(): HTMLElement | null {
  if (!waveSurfer) return null
  return waveSurfer.getWrapper()
}

function getWaveScrollLeft(): number {
  if (!waveSurfer) return 0
  return Math.max(0, waveSurfer.getScroll())
}

function setWaveScrollLeft(next: number) {
  if (!waveSurfer) return
  waveSurfer.setScroll(Math.max(0, next))
}

function applyZoom(zoomLevel: number, anchorRatio = 0.5) {
  const clamped = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, zoomLevel))
  zoomFactor.value = clamped

  if (!waveSurfer || !scrollHost.value) return

  const hostEl = scrollHost.value
  const wrapper = getWaveWrapper()
  if (!wrapper) return
  const previousWidth = Math.max(wrapper.scrollWidth, hostEl.clientWidth, 1)
  const previousScrollLeft = getWaveScrollLeft()
  const clampedAnchorRatio = clamp01(anchorRatio)
  const anchorOffsetInViewport = clampedAnchorRatio * hostEl.clientWidth
  const anchorPx = previousScrollLeft + anchorOffsetInViewport
  const anchorPercent = anchorPx / previousWidth

  const targetPxPerSec = fitPxPerSec.value * clamped
  if (typeof waveSurfer.zoom === 'function') {
    waveSurfer.zoom(targetPxPerSec)
  } else {
    waveSurfer.setOptions({ minPxPerSec: targetPxPerSec })
  }

  requestAnimationFrame(() => {
    if (!waveSurfer || !scrollHost.value) return
    const nextWrapper = getWaveWrapper()
    if (!nextWrapper) return
    const nextWidth = Math.max(nextWrapper.scrollWidth, scrollHost.value.clientWidth, 1)
    const nextAnchorPx = anchorPercent * nextWidth
    const nextScrollLeft = nextAnchorPx - anchorOffsetInViewport
    const maxScrollLeft = Math.max(0, nextWidth - scrollHost.value.clientWidth)
    setWaveScrollLeft(Math.min(maxScrollLeft, Math.max(0, nextScrollLeft)))
    syncWaveMetrics()
  })
}

function refreshFitZoom(anchorRatio = 0.5) {
  fitPxPerSec.value = getFitPxPerSec()
  applyZoom(zoomFactor.value, anchorRatio)
}

function anchorRatioFromClientX(clientX: number): number {
  if (!scrollHost.value) return 0.5
  const rect = scrollHost.value.getBoundingClientRect()
  if (rect.width <= 0) return 0.5
  return clamp01((clientX - rect.left) / rect.width)
}

function onWaveWheel(event: WheelEvent) {
  if (!hasAudio.value) return
  event.preventDefault()
  const direction = event.deltaY < 0 ? 1 : -1
  const nextZoom = zoomFactor.value + direction * WHEEL_ZOOM_STEP
  applyZoom(nextZoom, anchorRatioFromClientX(event.clientX))
}

function zoomIn() {
  applyZoom(zoomFactor.value + ZOOM_STEP)
}

function zoomOut() {
  applyZoom(zoomFactor.value - ZOOM_STEP)
}

function resetZoom() {
  applyZoom(MIN_ZOOM_FACTOR)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function syncWaveMetrics() {
  if (!scrollHost.value) {
    waveContentWidth.value = 0
    waveScrollLeft.value = 0
    return
  }

  const wrapper = getWaveWrapper()
  if (!waveSurfer || !wrapper) {
    waveContentWidth.value = scrollHost.value.clientWidth
    waveScrollLeft.value = 0
    return
  }

  const viewportWidth = scrollHost.value.clientWidth
  const contentWidth = Math.max(wrapper.scrollWidth, viewportWidth)
  waveContentWidth.value = contentWidth
  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth)
  const clampedScrollLeft = Math.min(maxScrollLeft, getWaveScrollLeft())
  setWaveScrollLeft(clampedScrollLeft)
  waveScrollLeft.value = clampedScrollLeft
}

function syncWaveMetricsFromScroll(scrollLeft: number) {
  if (!scrollHost.value) {
    waveContentWidth.value = 0
    waveScrollLeft.value = 0
    return
  }

  const wrapper = getWaveWrapper()
  if (!waveSurfer || !wrapper) {
    waveContentWidth.value = scrollHost.value.clientWidth
    waveScrollLeft.value = 0
    return
  }

  const viewportWidth = scrollHost.value.clientWidth
  const contentWidth = Math.max(wrapper.scrollWidth, viewportWidth)
  waveContentWidth.value = contentWidth
  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth)
  waveScrollLeft.value = Math.min(maxScrollLeft, Math.max(0, scrollLeft))
}

function getMaxScrollLeft(): number {
  if (!scrollHost.value) return 0
  const wrapper = getWaveWrapper()
  if (!wrapper) return 0
  return Math.max(0, wrapper.scrollWidth - scrollHost.value.clientWidth)
}

function clampScrollLeft(next: number): number {
  return Math.min(getMaxScrollLeft(), Math.max(0, next))
}

function markerLeftPx(timeSec: number): number {
  if (!store.durationSec || waveContentWidth.value <= 0) return 0
  return clamp01(timeSec / store.durationSec) * waveContentWidth.value
}

function markerViewportLeftPx(timeSec: number): number {
  return markerLeftPx(timeSec) - waveScrollLeft.value
}

const markerAPositionPx = computed(() => (markerATimeSec.value != null ? markerViewportLeftPx(markerATimeSec.value) : null))
const markerBPositionPx = computed(() => (markerBTimeSec.value != null ? markerViewportLeftPx(markerBTimeSec.value) : null))

function closeContextMenu() {
  contextMenu.value.visible = false
}

function clampMenuToWaveBounds() {
  if (!scrollHost.value || !contextMenuEl.value) return
  const margin = 6
  const maxX = Math.max(margin, scrollHost.value.clientWidth - contextMenuEl.value.offsetWidth - margin)
  const maxY = Math.max(margin, scrollHost.value.clientHeight - contextMenuEl.value.offsetHeight - margin)
  contextMenu.value.x = Math.min(Math.max(contextMenu.value.x, margin), maxX)
  contextMenu.value.y = Math.min(Math.max(contextMenu.value.y, margin), maxY)
}

function isScrollbarInteraction(event: MouseEvent | PointerEvent): boolean {
  const path = event.composedPath()
  const directTarget = path[0]
  if (directTarget instanceof HTMLElement) {
    const part = (directTarget.getAttribute('part') || '').toLowerCase()
    if (part.includes('scroll')) {
      return true
    }
  }

  if (!scrollHost.value || getMaxScrollLeft() <= 0) return false
  const rect = scrollHost.value.getBoundingClientRect()
  const yInHost = event.clientY - rect.top
  const scrollbarGrabZonePx = 18
  return yInHost >= rect.height - scrollbarGrabZonePx
}

function timeFromClientX(clientX: number): number | null {
  if (!waveSurfer || !store.durationSec || !scrollHost.value) return null
  const wrapper = getWaveWrapper()
  if (!wrapper) return null
  const rect = scrollHost.value.getBoundingClientRect()
  const xInViewport = clamp01((clientX - rect.left) / Math.max(rect.width, 1)) * rect.width
  const absoluteX = getWaveScrollLeft() + xInViewport
  const relativeX = clamp01(absoluteX / Math.max(wrapper.scrollWidth, 1))
  return relativeX * store.durationSec
}

function addMarkerAtContextTime() {
  store.addMarkerAtTime(contextMenu.value.timeSec)
  closeContextMenu()
}

function setLoopStartMarkerAtContextTime() {
  store.setLoopStartAtTime(contextMenu.value.timeSec)
  closeContextMenu()
}

function setLoopEndMarkerAtContextTime() {
  store.setLoopEndAtTime(contextMenu.value.timeSec)
  closeContextMenu()
}

function onWaveContextMenu(event: MouseEvent) {
  if (!hasAudio.value || !scrollHost.value) return
  event.preventDefault()
  event.stopPropagation()
  const time = timeFromClientX(event.clientX)
  if (time == null) return
  const rect = scrollHost.value.getBoundingClientRect()
  contextMenu.value = {
    visible: true,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    timeSec: time,
  }
  requestAnimationFrame(clampMenuToWaveBounds)
}

function onPointerDown(event: PointerEvent) {
  if (!scrollHost.value || !hasAudio.value) return
  if (event.button !== 0) return
  if (isScrollbarInteraction(event)) return
  const path = event.composedPath()
  const isRegionHandle = path.some((node) => {
    if (!(node instanceof HTMLElement)) return false
    const part = node.getAttribute('part') || ''
    return part.includes('region')
  })
  if (isRegionHandle) return
  if (getMaxScrollLeft() <= 0) return

  const wrapper = getWaveWrapper()
  if (!wrapper) return
  isPanning.value = true
  panStartX = event.clientX
  panStartScroll = getWaveScrollLeft()
  panDistance = 0
  scrollHost.value.setPointerCapture(event.pointerId)
  closeContextMenu()
}

function onPointerMove(event: PointerEvent) {
  if (!isPanning.value || !scrollHost.value) return
  const wrapper = getWaveWrapper()
  if (!wrapper) return
  const deltaX = event.clientX - panStartX
  panDistance = Math.max(panDistance, Math.abs(deltaX))
  const nextScrollLeft = clampScrollLeft(panStartScroll - deltaX)
  setWaveScrollLeft(nextScrollLeft)
  waveScrollLeft.value = nextScrollLeft
  event.preventDefault()
}

function onPointerUp(event: PointerEvent) {
  if (!scrollHost.value) return
  if (isPanning.value) {
    isPanning.value = false
    scrollHost.value.releasePointerCapture(event.pointerId)
    suppressClickFromPan = panDistance > 4
  }
}

function onWaveLeftClick(event: MouseEvent) {
  if (!hasAudio.value) return
  if (isScrollbarInteraction(event)) return
  if (suppressClickFromPan) {
    suppressClickFromPan = false
    return
  }
  const time = timeFromClientX(event.clientX)
  if (time == null) return
  store.seek(time)
}

function refreshMarkers() {
  // Regular markers rendered by dedicated overlay for precise line/label styling.
}

function refreshLoopSections() {
  if (!regionsPlugin || !store.durationSec) return
  const plugin = regionsPlugin
  for (const region of loopRegions.values()) {
    region.remove()
  }
  loopRegions.clear()

  store.loopSections.forEach((section, index) => {
    const isActive = section.id === store.activeLoopSectionId
    const region = plugin.addRegion({
      id: section.id,
      start: section.startSec,
      end: section.endSec,
      drag: true,
      resize: true,
      color: section.enabled
        ? isActive
          ? 'rgba(11, 173, 107, 0.34)'
          : 'rgba(11, 173, 107, 0.18)'
        : isActive
          ? 'rgba(108, 117, 125, 0.34)'
          : 'rgba(108, 117, 125, 0.16)',
      minLength: 0.05,
      content: `${index + 1}. ${section.name}${section.enabled ? '' : ' (off)'}`,
    })

    region.on('click', (event) => {
      event.preventDefault()
      store.selectLoopSection(section.id)
    })

    region.on('update-end', () => {
      updatingLoopSectionFromRegion = true
      store.updateLoopSectionRange(section.id, region.start, region.end)
      updatingLoopSectionFromRegion = false
    })

    loopRegions.set(section.id, region)
  })
}

async function loadWaveform(url: string) {
  await ensureWaveSurfer()
  if (!waveSurfer) return
  await waveSurfer.load(url)
  refreshFitZoom(0)
  syncWaveMetrics()
}

async function ensureWaveSurfer(): Promise<void> {
  if (waveSurfer || waveSurferReady) {
    await waveSurferReady
    return
  }
  if (!host.value) return

  waveSurferReady = createWaveSurfer()
  await waveSurferReady
}

async function createWaveSurfer(): Promise<void> {
  if (!host.value) return

  const [{ default: WaveSurfer }, { default: RegionsPlugin }] = await Promise.all([
    import('wavesurfer.js'),
    import('wavesurfer.js/dist/plugins/regions.esm.js'),
  ])
  if (!host.value) return

  regionsPlugin = RegionsPlugin.create()
  const colors = getWaveColors()
  waveSurfer = WaveSurfer.create({
    container: host.value,
    waveColor: colors.waveColor,
    progressColor: colors.progressColor,
    height: 324,
    cursorColor: colors.cursorColor,
    cursorWidth: 1,
    autoScroll: false,
    autoCenter: false,
    minPxPerSec: 1,
    normalize: true,
    plugins: [regionsPlugin],
  })

  const unsubscribeScroll = waveSurfer.on('scroll', (_, __, scrollLeft) => {
    syncWaveMetricsFromScroll(scrollLeft)
  })
  const unsubscribeRedraw = waveSurfer.on('redraw', syncWaveMetrics)
  const unsubscribeZoom = waveSurfer.on('zoom', syncWaveMetrics)
  waveSurferCleanups.push(unsubscribeScroll, unsubscribeRedraw, unsubscribeZoom)

  fitPxPerSec.value = getFitPxPerSec()
  syncWaveMetrics()
}

onMounted(() => {
  const stopFileObjectUrlWatch = watch(
    () => store.fileObjectUrl,
    (url) => {
      if (!url) return
      void loadWaveform(url).then(() => {
        refreshLoopSections()
        refreshMarkers()
      })
    },
    { immediate: true },
  )

  const stopDurationWatch = watch(
    () => store.durationSec,
    (durationSec) => {
      if (!durationSec) return
      refreshFitZoom(0.5)
    },
  )

  const stopLoopSectionsWatch = watch(
    () => [store.loopSections, store.activeLoopSectionId],
    () => {
      if (updatingLoopSectionFromRegion) return
      refreshLoopSections()
    },
    { deep: true },
  )

  const stopMarkersWatch = watch(
    () => store.markers,
    () => refreshMarkers(),
    { deep: true },
  )

  const stopCurrentTimeWatch = watch(
    () => store.currentTimeSec,
    (timeSec) => {
      if (!waveSurfer || !store.durationSec) return
      waveSurfer.setTime(timeSec)
    },
  )

  const observer = new MutationObserver(() => applyWaveTheme())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] })
  document.addEventListener('pointerdown', closeContextMenu)
  window.addEventListener('resize', onWindowResize)
  fitPxPerSec.value = getFitPxPerSec()
  syncWaveMetrics()

  onBeforeUnmount(() => {
    observer.disconnect()
    document.removeEventListener('pointerdown', closeContextMenu)
    window.removeEventListener('resize', onWindowResize)
    stopFileObjectUrlWatch()
    stopDurationWatch()
    stopLoopSectionsWatch()
    stopMarkersWatch()
    stopCurrentTimeWatch()
  })
})

onBeforeUnmount(() => {
  for (const region of loopRegions.values()) {
    region.remove()
  }
  loopRegions.clear()
  for (const cleanup of waveSurferCleanups) {
    cleanup()
  }
  waveSurferCleanups.length = 0
  waveSurfer?.destroy()
})
</script>

<template>
  <section class="waveform-shell">
    <div
      ref="scrollHost"
      class="wave-scroll"
      :class="{ 'is-empty': !hasAudio, 'is-panning': isPanning }"
      @click.left="onWaveLeftClick"
      @contextmenu.prevent.stop="onWaveContextMenu"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWaveWheel"
    >
      <div class="zoom-controls" @pointerdown.stop @click.stop @wheel.stop>
        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!hasAudio || !canZoomOut" @click="zoomOut">
          -
        </button>
        <input
          :value="zoomFactor"
          class="form-range zoom-slider"
          type="range"
          :min="MIN_ZOOM_FACTOR"
          :max="MAX_ZOOM_FACTOR"
          :step="ZOOM_STEP"
          :disabled="!hasAudio"
          @input="applyZoom(Number(($event.target as HTMLInputElement).value))"
        />
        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!hasAudio || !canZoomIn" @click="zoomIn">
          +
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!hasAudio || !canZoomOut" @click="resetZoom">
          1:1
        </button>
      </div>
      <div ref="host" class="waveform-host" />
      <div class="ab-markers-overlay">
        <div
          v-for="marker in regularMarkers"
          :key="marker.id"
          class="regular-marker"
          :style="{ left: `${markerViewportLeftPx(marker.timeSec)}px`, '--marker-line-color': REGULAR_MARKER_LINE_COLOR }"
        >
          <span class="regular-marker-label">{{ marker.label }}</span>
        </div>
        <div
          v-if="markerAPositionPx !== null"
          class="ab-marker ab-marker-a"
          :style="{ left: `${markerAPositionPx}px`, '--ab-marker-color': A_MARKER_LINE_COLOR }"
        >
          <span class="ab-marker-label">A</span>
        </div>
        <div
          v-if="markerBPositionPx !== null"
          class="ab-marker ab-marker-b"
          :style="{ left: `${markerBPositionPx}px`, '--ab-marker-color': B_MARKER_LINE_COLOR }"
        >
          <span class="ab-marker-label">B</span>
        </div>
      </div>
      <div
        v-if="contextMenu.visible"
        ref="contextMenuEl"
        class="wave-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @pointerdown.stop
        @click.stop
      >
        <button type="button" class="btn btn-sm btn-light" @click="addMarkerAtContextTime">Add Marker Here</button>
        <button type="button" class="btn btn-sm btn-light" @click="setLoopStartMarkerAtContextTime">Set Loop Start (A)</button>
        <button type="button" class="btn btn-sm btn-light" @click="setLoopEndMarkerAtContextTime">Set Loop End (B)</button>
        <div class="context-time">{{ contextMenu.timeSec.toFixed(2) }}s</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.waveform-shell {
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
  position: relative;
}

.zoom-controls {
  position: absolute;
  top: 0.45rem;
  right: 0.45rem;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0.2rem 0.45rem;
  border: 1px solid rgba(240, 242, 234, 0.14);
  border-radius: 7px;
  background: rgba(16, 18, 20, 0.68);
  opacity: 0.48;
  transition:
    opacity 150ms ease,
    background-color 150ms ease,
    border-color 150ms ease;
}

.zoom-controls:hover,
.zoom-controls:focus-within {
  opacity: 1;
  border-color: rgba(88, 196, 216, 0.36);
  background: rgba(16, 18, 20, 0.86);
}

.zoom-slider {
  width: 180px;
  height: 1.25rem;
  margin: 0;
  accent-color: var(--bs-primary);
}

.wave-scroll {
  position: relative;
  width: 100%;
  overflow-x: hidden;
  overflow-y: hidden;
  margin-top: 0;
  cursor: default;
  border: 1px solid rgba(240, 242, 234, 0.1);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(39, 44, 51, 0.98) 0%, rgba(24, 27, 31, 0.99) 58%, rgba(13, 15, 17, 1) 100%);
}

.wave-scroll.is-panning {
  cursor: grabbing;
}

.waveform-host::part(scroll),
.waveform-host::part(wrapper) {
  cursor: default;
}

.wave-scroll.is-panning .waveform-host::part(scroll),
.wave-scroll.is-panning .waveform-host::part(wrapper) {
  cursor: grabbing;
}

.wave-scroll.is-empty::before {
  content: '';
  position: absolute;
  inset: 0.5rem 0;
  pointer-events: none;
  opacity: 0.35;
  background:
    linear-gradient(
      180deg,
      transparent 47%,
      color-mix(in srgb, var(--bs-secondary-color) 45%, transparent) 47%,
      color-mix(in srgb, var(--bs-secondary-color) 45%, transparent) 53%,
      transparent 53%
    ),
    repeating-linear-gradient(
      90deg,
      transparent 0 10px,
      color-mix(in srgb, var(--bs-secondary-color) 35%, transparent) 10px 12px,
      transparent 12px 20px
    );
}

.waveform-host {
  position: relative;
  z-index: 1;
  min-height: 360px;
  width: 100%;
}

.ab-markers-overlay {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  z-index: 30;
  pointer-events: none;
}

.regular-marker {
  --marker-line-color: #e35353;
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--marker-line-color);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.3),
    0 0 8px rgba(227, 83, 83, 0.2);
}

.regular-marker-label {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 28px;
  padding: 0.1rem 0.45rem;
  border-radius: 5px;
  border: 1px solid rgba(16, 18, 20, 0.86);
  background: #f0f2ea;
  color: #101214;
  font-size: 0.88rem;
  font-weight: 700;
  line-height: 1.1;
  white-space: nowrap;
  text-align: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
}

.ab-marker {
  --ab-marker-color: #ffffff;
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--ab-marker-color);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}

.ab-marker-label {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 22px;
  padding: 0.08rem 0.35rem;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  color: #101214;
  font-size: 0.72rem;
  font-weight: 700;
  text-align: center;
  line-height: 1.15;
  background: color-mix(in srgb, var(--ab-marker-color) 86%, #ffffff 14%);
}

.wave-context-menu {
  position: absolute;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.35rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bs-body-bg) 88%, var(--bs-secondary-bg));
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
}

.wave-context-menu .btn {
  padding: 0.2rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.1;
  white-space: nowrap;
}

.context-time {
  font-size: 0.72rem;
  color: var(--bs-secondary-color);
  text-align: right;
}
</style>
