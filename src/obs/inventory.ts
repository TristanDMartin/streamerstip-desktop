import type { SaveTrigger } from './contract'
import type { LocalEditGrant } from './captureContracts'

export interface StoredClip {
  localPath: string
  fileSizeBytes: number
  trigger: SaveTrigger
  idempotencyKey: string
  triggerTimestamp: number
  uploadAuthorized: boolean
  editGrant?: LocalEditGrant | null
}

export function rememberClip(items: readonly StoredClip[], next: StoredClip): readonly StoredClip[] {
  if (items.some((item) => item.idempotencyKey === next.idempotencyKey)) return items
  return [next, ...items]
}

export function setUploadAuthorization(
  items: readonly StoredClip[],
  idempotencyKey: string,
  authorized: boolean,
): StoredClip[] {
  return items.map((item) => (
    item.idempotencyKey === idempotencyKey ? { ...item, uploadAuthorized: authorized } : item
  ))
}

export function clipsAuthorizedForUpload(items: readonly StoredClip[]): StoredClip[] {
  return items.filter((item) => item.uploadAuthorized)
}
