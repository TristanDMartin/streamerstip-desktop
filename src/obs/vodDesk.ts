import { planAuthorize, planEdit, planScan, type PlanResult, type SidecarPaths, type SidecarRun } from './sidecarPlan'
import type { GpuObservation, ObsObservation, ProcessingMode } from './scheduler'

export interface SidecarResult {
  code: number
  stdout: string
}

export type SidecarRunner = (
  run: SidecarRun,
  signal: AbortSignal,
  onLine: (line: string) => void,
) => Promise<SidecarResult>

export class VodDesk {
  private controller: AbortController | null = null

  constructor(
    private readonly runner: SidecarRunner,
    private readonly paths: SidecarPaths,
    private readonly enabled: boolean,
  ) {}

  cancel(): void {
    this.controller?.abort()
  }

  authorize(ownerId: string, rootPath: string): Promise<PlanResult & { result?: SidecarResult }> {
    return this.execute(planAuthorize({ enabled: this.enabled, paths: this.paths, ownerId, rootPath }))
  }

  scan(input: {
    grantPath: string
    filePath: string
    authorized: boolean
    mode: ProcessingMode
    activity: ObsObservation
    gpu?: GpuObservation
    onLine?: (line: string) => void
  }): Promise<PlanResult & { result?: SidecarResult }> {
    return this.execute(planScan({ ...input, enabled: this.enabled, paths: this.paths }), input.onLine)
  }

  edit(input: {
    manifestPath: string
    ownerId: string
    sampleId: string
    selected: boolean
    mode: ProcessingMode
    activity: ObsObservation
    gpu?: GpuObservation
    onLine?: (line: string) => void
  }): Promise<PlanResult & { result?: SidecarResult }> {
    return this.execute(planEdit({ ...input, enabled: this.enabled, paths: this.paths }), input.onLine)
  }

  private async execute(
    plan: PlanResult,
    onLine: (line: string) => void = () => undefined,
  ): Promise<PlanResult & { result?: SidecarResult }> {
    if (!plan.ok) return plan
    this.cancel()
    const controller = new AbortController()
    this.controller = controller
    try {
      const result = await this.runner(plan.run, controller.signal, onLine)
      return { ok: true, run: plan.run, result }
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}
