export type ProcessingMode = 'live' | 'balanced' | 'performance'

export interface OutputActivity {
  streaming: boolean
  recording: boolean
}

export interface ProcessingDecision {
  selected: ProcessingMode
  effective: ProcessingMode
  downgraded: boolean
  asr: 'off' | 'local'
  allowEdit: boolean
  maxSamples: number | null
  network: 'none'
}

const MODES: readonly ProcessingMode[] = ['live', 'balanced', 'performance']

export function isProcessingMode(value: string): value is ProcessingMode {
  return (MODES as readonly string[]).includes(value)
}

export function resolveProcessingMode(selected: ProcessingMode, activity: OutputActivity): ProcessingDecision {
  const busy = activity.streaming || activity.recording
  const effective: ProcessingMode = busy ? 'live' : selected
  if (effective === 'live') {
    return {
      selected,
      effective,
      downgraded: busy && selected !== 'live',
      asr: 'off',
      allowEdit: false,
      maxSamples: 0,
      network: 'none',
    }
  }
  if (effective === 'balanced') {
    return {
      selected,
      effective,
      downgraded: false,
      asr: 'off',
      allowEdit: true,
      maxSamples: 1,
      network: 'none',
    }
  }
  return {
    selected,
    effective,
    downgraded: false,
    asr: 'local',
    allowEdit: true,
    maxSamples: null,
    network: 'none',
  }
}
