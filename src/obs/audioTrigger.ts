import {
  AUDIO_COOLDOWN_MS,
  AUDIO_MARGIN_DB,
  AUDIO_MAX_GAP_MS,
  AUDIO_MINIMUM_DB,
  AUDIO_SUSTAIN_SAMPLES,
  CALIBRATION_MIN_SAMPLES,
} from './constants'

export interface MeterInput {
  inputName: string
  inputLevelsMul: number[][]
}

export interface AudioDecision {
  fire: boolean
  reason: 'disabled' | 'uncalibrated' | 'input_missing' | 'cooldown' | 'below_threshold' | 'sustaining' | 'threshold'
  peakDb?: number
  aboveRun?: number
}

export interface CalibrationResult {
  ok: boolean
  thresholdDb: number | null
  noiseFloorDb: number | null
  sampleCount: number
  silenceWarning: boolean
  message: string
}

export function mulToDb(mul: number): number {
  if (!Number.isFinite(mul) || mul <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(mul)
}

export function readMeterInputs(data: { inputs?: unknown } | null | undefined): MeterInput[] {
  if (!data || !Array.isArray(data.inputs)) return []
  const inputs: MeterInput[] = []
  for (const row of data.inputs) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const inputName = typeof record.inputName === 'string' ? record.inputName : ''
    if (!inputName) continue
    const levels = Array.isArray(record.inputLevelsMul) ? record.inputLevelsMul : []
    const inputLevelsMul = levels
      .filter((channel): channel is unknown[] => Array.isArray(channel))
      .map((channel) => channel.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)))
    inputs.push({ inputName, inputLevelsMul })
  }
  return inputs
}

export function peakMul(inputs: readonly MeterInput[], inputName: string | null): number | null {
  const chosen = inputName ? inputs.filter((input) => input.inputName === inputName) : inputs
  if (inputName && chosen.length === 0) return null
  let peak = 0
  let saw = false
  for (const input of chosen) {
    for (const channel of input.inputLevelsMul) {
      if (channel.length === 0) continue
      const value = channel.length >= 2 ? channel[1] : Math.max(...channel)
      if (!Number.isFinite(value)) continue
      saw = true
      if (value > peak) peak = value
    }
  }
  return saw ? peak : null
}

export function thresholdFromSamples(samples: readonly number[], marginDb: number, minimumDb: number): {
  thresholdDb: number
  noiseFloorDb: number
} | null {
  const dbValues = samples.map(mulToDb).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (dbValues.length < CALIBRATION_MIN_SAMPLES) return null
  const index = Math.min(dbValues.length - 1, Math.max(0, Math.ceil(0.95 * dbValues.length) - 1))
  const noiseFloorDb = dbValues[index] ?? minimumDb
  return {
    noiseFloorDb,
    thresholdDb: Math.max(noiseFloorDb + marginDb, minimumDb),
  }
}

export class AudioTrigger {
  enabled = false
  marginDb = AUDIO_MARGIN_DB
  minimumDb = AUDIO_MINIMUM_DB
  cooldownMs = AUDIO_COOLDOWN_MS
  sustainSamples = AUDIO_SUSTAIN_SAMPLES
  maxGapMs = AUDIO_MAX_GAP_MS
  inputName: string | null = null
  thresholdDb: number | null = null
  noiseFloorDb: number | null = null
  private lastFireAt: number | null = null
  private lastSampleAt: number | null = null
  private aboveRun = 0

  calibrate(samples: readonly number[]): CalibrationResult {
    const computed = thresholdFromSamples(samples, this.marginDb, this.minimumDb)
    if (!computed) {
      this.thresholdDb = null
      this.noiseFloorDb = null
      this.aboveRun = 0
      return {
        ok: false,
        thresholdDb: null,
        noiseFloorDb: null,
        sampleCount: samples.length,
        silenceWarning: false,
        message: `Need at least ${CALIBRATION_MIN_SAMPLES} audio samples during normal game volume. Nothing was armed.`,
      }
    }
    this.thresholdDb = computed.thresholdDb
    this.noiseFloorDb = computed.noiseFloorDb
    this.aboveRun = 0
    const silenceWarning = computed.noiseFloorDb < -50
    const rounded = computed.thresholdDb.toFixed(1)
    const message = silenceWarning
      ? `Calibrated, but the input looked silent. The spike threshold fell back to ${rounded} dB. Check the input name.`
      : `Calibrated. A spike must stay at or above ${rounded} dB.`
    return {
      ok: true,
      thresholdDb: computed.thresholdDb,
      noiseFloorDb: computed.noiseFloorDb,
      sampleCount: samples.length,
      silenceWarning,
      message,
    }
  }

  setEnabled(enabled: boolean): { ok: boolean; message: string } {
    if (enabled && this.thresholdDb === null) {
      this.enabled = false
      return { ok: false, message: 'Calibrate the audio spike against normal game volume before turning it on.' }
    }
    this.enabled = enabled
    this.aboveRun = 0
    return { ok: true, message: enabled ? 'Audio spike is on.' : 'Audio spike is off.' }
  }

  observe(peak: number | null, now: number): AudioDecision {
    if (!this.enabled) return { fire: false, reason: 'disabled' }
    if (this.thresholdDb === null) return { fire: false, reason: 'uncalibrated' }
    if (this.lastSampleAt !== null && now - this.lastSampleAt > this.maxGapMs) this.aboveRun = 0
    this.lastSampleAt = now
    if (peak === null) {
      this.aboveRun = 0
      return { fire: false, reason: 'input_missing' }
    }
    if (this.lastFireAt !== null && now - this.lastFireAt < this.cooldownMs) {
      return { fire: false, reason: 'cooldown' }
    }
    const peakDb = mulToDb(peak)
    if (peakDb < this.thresholdDb) {
      this.aboveRun = 0
      return { fire: false, reason: 'below_threshold', peakDb }
    }
    this.aboveRun += 1
    if (this.aboveRun < this.sustainSamples) {
      return { fire: false, reason: 'sustaining', peakDb, aboveRun: this.aboveRun }
    }
    this.aboveRun = 0
    this.lastFireAt = now
    return { fire: true, reason: 'threshold', peakDb }
  }
}
