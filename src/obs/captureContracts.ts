export const SAMPLE_MANIFEST_SCHEMA = 'tippy.sample-manifest.v1'

export const BENCHMARK_CATEGORIES = [
  'gta',
  'fps',
  'horror',
  'with_facecam',
  'without_facecam',
  'spoken_commentary',
  'loud_reaction',
  'quiet_speech',
  'background_music',
  'multiple_audio_sources',
] as const

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number]

export const CAPTURE_PATHS = {
  A: {
    id: 'tippy.capture.twitch.v1',
    media: 'link_embed_only',
    desktopRuns: false,
  },
  B: {
    id: 'tippy.capture.obs-replay.v1',
    consent: 'creator_authorized_local_replay',
    manifest: SAMPLE_MANIFEST_SCHEMA,
  },
  C: {
    id: 'tippy.capture.vod.v1',
    consent: 'creator_authorized_local_folder',
    manifest: SAMPLE_MANIFEST_SCHEMA,
  },
} as const

export function isBenchmarkCategory(value: string): value is BenchmarkCategory {
  return (BENCHMARK_CATEGORIES as readonly string[]).includes(value)
}
