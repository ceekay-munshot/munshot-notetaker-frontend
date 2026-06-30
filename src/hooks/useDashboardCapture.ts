// src/hooks/useDashboardCapture.ts
//
// Registers the two host→dashboard request handlers required by the Munshot
// dashboard auth standard, against the single SDK client (src/lib/sdk.ts):
//
//   • dashboard.capture.visual  → a PNG Blob of the dashboard's main region.
//   • dashboard.capture.snapshot → the current { context, selection, data }.
//
// Both handlers are bulletproof per the standard: they never throw and only
// return small, structured-cloneable values (a Blob, or plain JSON), so a
// failure becomes a structured error rather than a host timeout. We never call
// sdk.ready() here — the SDK auto-sends dashboard:ready on host:init.
import { useEffect, useRef } from 'react'
import { toBlob } from 'html-to-image'
import { sdk } from '../lib/sdk'

export function useDashboardCapture(getSnapshot: () => unknown): void {
  // A ref to the latest snapshot getter, reassigned every render so the handler
  // always reads live state without stale closures.
  const snapshotRef = useRef(getSnapshot)
  snapshotRef.current = getSnapshot

  useEffect(() => {
    // 1) Visual snapshot — return a PNG Blob of the dashboard's main region.
    const offVisual = sdk.onRequest('dashboard.capture.visual', async () => {
      try {
        const el =
          document.querySelector('#dashboard-main') ||
          document.querySelector("[data-dashboard-capture-root='true']") ||
          document.querySelector('main')
        if (!el) throw new Error('capture root not found')
        const blob = await toBlob(el as HTMLElement, { pixelRatio: 2 })
        if (!blob) throw new Error('empty snapshot blob')
        return { visualSnapshot: blob, capturedAt: new Date().toISOString() }
      } catch (err) {
        // Never throw out of the handler; return a structured, cloneable error.
        return { ok: false, error: (err as Error).message }
      }
    })

    // 2) State snapshot — return the current JSON state of the dashboard.
    const offSnapshot = sdk.onRequest('dashboard.capture.snapshot', () => {
      try {
        return snapshotRef.current()
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })

    // DO NOT call sdk.ready() here. The SDK auto-sends dashboard:ready on
    // host:init; calling it manually races the handshake and breaks it.

    return () => {
      offVisual()
      offSnapshot()
    }
  }, [])
}
