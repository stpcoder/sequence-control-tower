import type { SequenceIntelligenceApi } from '../shared/contracts'

declare global {
  interface Window {
    /** Sandboxed, typed API. No raw ipcRenderer or persisted secret is exposed. */
    sequenceIntelligence: SequenceIntelligenceApi
  }
}

export {}
