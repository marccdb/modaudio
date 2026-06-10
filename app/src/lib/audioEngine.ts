import type { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'
import type { LoopRange } from '../types/practice'
import { clamp, normalizeLoop, normalizeTempo, normalizePitchSemitones } from './math'

type EngineEventMap = {
  timeupdate: { currentTime: number; duration: number }
  statechange: { isPlaying: boolean }
  loopchange: LoopRange
  loaded: { duration: number }
  ended: void
  error: { message: string }
}

type Listener<K extends keyof EngineEventMap> = (payload: EngineEventMap[K]) => void

export class AudioEngine {
  private context: AudioContext | null = null
  private gainNode: GainNode | null = null
  private soundTouchNode: SoundTouchNode | null = null
  private audioBuffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private processorRegistered = false
  private sourceGeneration = 0
  private stopReasons = new Map<number, 'pause' | 'seek' | 'load'>()
  private progressTimer: ReturnType<typeof setInterval> | null = null
  private duration = 0
  private isPlaying = false
  private positionSec = 0
  private sourceStartContextTime = 0
  private sourceStartOffsetSec = 0
  private tempo = 1
  private pitchSemitones = 0
  private loop: LoopRange = { enabled: false, startSec: 0, endSec: 1, mode: 'forever' }
  private listeners = new Map<keyof EngineEventMap, Set<Function>>()

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext()
      this.gainNode = this.context.createGain()
      this.gainNode.gain.value = 1
      this.gainNode.connect(this.context.destination)
    }

    return this.context
  }

  private async ensureSoundTouchNode(): Promise<SoundTouchNode> {
    const ctx = this.ensureContext()

    if (!ctx.audioWorklet) {
      throw new Error('AudioWorklet is not available in this browser context')
    }

    const { SoundTouchNode } = await import('@soundtouchjs/audio-worklet')

    if (!this.processorRegistered) {
      await SoundTouchNode.register(ctx, processorUrl)
      this.processorRegistered = true
    }

    if (!this.soundTouchNode) {
      this.soundTouchNode = new SoundTouchNode({
        context: ctx,
        interpolationStrategy: 'lanczos',
      })
      this.soundTouchNode.setStretchParameters({ overlapMs: 12, quickSeek: false })
      this.applyProcessingParams()
      if (this.gainNode) {
        this.soundTouchNode.connect(this.gainNode)
      }
    }

    return this.soundTouchNode
  }

  on<K extends keyof EngineEventMap>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener as Function)
    this.listeners.set(event, set)
    return () => set.delete(listener as Function)
  }

  private emit<K extends keyof EngineEventMap>(event: K, payload: EngineEventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      ;(listener as Listener<K>)(payload)
    }
  }

  private async loadDecodedAudio(arrayBuffer: ArrayBuffer): Promise<number> {
    try {
      this.stopSource('load')
      this.stopProgressTimer()
      this.isPlaying = false
      const ctx = this.ensureContext()
      await this.ensureSoundTouchNode()
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

      const nextDuration = audioBuffer.duration
      const nextLoop = normalizeLoop({ ...this.loop, endSec: nextDuration }, nextDuration)

      this.audioBuffer = audioBuffer
      this.duration = nextDuration
      this.loop = nextLoop
      this.positionSec = 0
      this.emit('loaded', { duration: this.duration })
      this.emit('statechange', { isPlaying: false })
      this.emit('timeupdate', { currentTime: 0, duration: this.duration })
      return this.duration
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load audio'
      this.emit('error', { message })
      throw error
    }
  }

  async loadArrayBuffer(arrayBuffer: ArrayBuffer): Promise<number> {
    return this.loadDecodedAudio(arrayBuffer)
  }

  async loadFile(file: File): Promise<number> {
    return this.loadDecodedAudio(await file.arrayBuffer())
  }

  async play(): Promise<void> {
    if (!this.audioBuffer || !this.gainNode) return
    if (this.context?.state === 'suspended') {
      await this.context.resume()
    }
    if (!this.isPlaying) {
      await this.ensureSoundTouchNode()
      if (this.positionSec >= this.duration) {
        this.positionSec = 0
      }
      this.startSource(this.positionSec)
      this.isPlaying = true
      this.startProgressTimer()
      this.emit('statechange', { isPlaying: true })
    }
  }

  pause(): void {
    if (!this.isPlaying) return
    this.positionSec = this.getCurrentPosition()
    this.stopSource('pause')
    this.stopProgressTimer()
    this.isPlaying = false
    this.emit('statechange', { isPlaying: false })
  }

  seek(seconds: number): void {
    if (!this.audioBuffer || this.duration <= 0) return
    const clamped = clamp(seconds, 0, this.duration)
    this.positionSec = clamped
    if (this.isPlaying) {
      this.startSource(clamped)
    }
    this.emit('timeupdate', { currentTime: clamped, duration: this.duration })
  }

  setTempo(tempo: number): number {
    const normalized = normalizeTempo(tempo)
    if (this.isPlaying) {
      this.positionSec = this.getCurrentPosition()
      this.sourceStartOffsetSec = this.positionSec
      this.sourceStartContextTime = this.context?.currentTime ?? 0
    }
    this.tempo = normalized
    this.applyProcessingParams()
    return normalized
  }

  setPitch(semitones: number): number {
    const normalized = normalizePitchSemitones(semitones)
    this.pitchSemitones = normalized
    this.applyProcessingParams()
    return normalized
  }

  setVolume(value: number): number {
    const normalized = clamp(value, 0, 2)
    if (this.gainNode) {
      this.gainNode.gain.value = normalized
    }
    return normalized
  }

  setLoop(loop: LoopRange): void {
    this.loop = loop
  }

  getDuration(): number {
    return this.duration
  }

  private applyProcessingParams(): void {
    const now = this.context?.currentTime ?? 0
    this.source?.playbackRate.setValueAtTime(this.tempo, now)
    this.soundTouchNode?.playbackRate.setValueAtTime(this.tempo, now)
    this.soundTouchNode?.pitch.setValueAtTime(1, now)
    this.soundTouchNode?.pitchSemitones.setValueAtTime(this.pitchSemitones, now)
  }

  private getCurrentPosition(): number {
    if (!this.isPlaying || !this.context) {
      return clamp(this.positionSec, 0, this.duration)
    }

    const elapsedSec = Math.max(0, this.context.currentTime - this.sourceStartContextTime)
    return clamp(this.sourceStartOffsetSec + elapsedSec * this.tempo, 0, this.duration)
  }

  private startSource(offsetSec: number): void {
    if (!this.context || !this.audioBuffer || !this.soundTouchNode) return

    this.stopSource('seek')

    const clampedOffset = clamp(offsetSec, 0, this.duration)
    if (clampedOffset >= this.duration) {
      this.positionSec = this.duration
      this.stopProgressTimer()
      if (this.isPlaying) {
        this.isPlaying = false
        this.emit('statechange', { isPlaying: false })
      }
      this.emit('timeupdate', { currentTime: this.duration, duration: this.duration })
      this.emit('ended', undefined)
      return
    }

    const source = this.context.createBufferSource()
    const generation = ++this.sourceGeneration

    source.buffer = this.audioBuffer
    source.playbackRate.setValueAtTime(this.tempo, this.context.currentTime)
    source.connect(this.soundTouchNode)
    source.onended = () => {
      try {
        source.disconnect()
      } catch {
        // Source may already be disconnected after explicit stop.
      }

      const stopReason = this.stopReasons.get(generation)
      this.stopReasons.delete(generation)
      if (stopReason) return

      if (this.source === source) {
        this.source = null
      }
      this.positionSec = this.duration
      this.stopProgressTimer()
      if (this.isPlaying) {
        this.isPlaying = false
        this.emit('statechange', { isPlaying: false })
      }
      this.emit('timeupdate', { currentTime: this.duration, duration: this.duration })
      this.emit('ended', undefined)
    }

    this.source = source
    this.sourceStartOffsetSec = clampedOffset
    this.sourceStartContextTime = this.context.currentTime
    this.applyProcessingParams()
    source.start(0, clampedOffset)
  }

  private stopSource(reason: 'pause' | 'seek' | 'load'): void {
    if (!this.source) return

    const source = this.source
    this.stopReasons.set(this.sourceGeneration, reason)
    this.source = null
    try {
      source.stop()
    } catch {
      // Already stopped.
    }
    try {
      source.disconnect()
    } catch {
      // Already disconnected.
    }
  }

  private startProgressTimer(): void {
    if (this.progressTimer) return

    this.progressTimer = setInterval(() => {
      const currentTime = this.getCurrentPosition()
      this.positionSec = currentTime
      this.emit('timeupdate', { currentTime, duration: this.duration })

      if (!this.loop.enabled || currentTime < this.loop.endSec) return

      if (this.loop.mode === 'once') {
        this.loop = { ...this.loop, enabled: false }
        this.emit('loopchange', this.loop)
        return
      }

      this.seek(this.loop.startSec)
    }, 50)
  }

  private stopProgressTimer(): void {
    if (!this.progressTimer) return
    clearInterval(this.progressTimer)
    this.progressTimer = null
  }
}
