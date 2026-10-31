/**
 * Stand-in for `@hermes/plugin-sdk` for the harness test: only the door the
 * plugin actually uses, with call recording so the test can assert on it.
 */
export const PALETTE_AREA = 'palette'

export const calls = {
  setDraft: [],
  getDraft: [],
  insertText: [],
  focus: [],
  notify: [],
  clipboard: [],
  newChat: [],
  runAction: []
}

export const composerState = {
  /** Draft the fake composer currently holds. */
  draft: '',
  /** Make every write verb fail, to exercise the fallback path. */
  broken: false,
  sessionId: 'sess-1',
  storedSessionId: '20261031_abc123',
  profile: 'default'
}

export const host = {
  state: {
    focusedSessionId: { get: () => composerState.sessionId ?? 'sess-1' },
    focusedStoredSessionId: { get: () => composerState.storedSessionId ?? '20261031_abc123' },
    focusedSessionProfile: { get: () => composerState.profile ?? 'default' },
    profile: { get: () => composerState.profile ?? 'default' }
  },
  newChat: profile => {
    calls.newChat.push(profile)
  },
  notify: payload => {
    calls.notify.push(payload)
  },
  composer: {
    getDraft: async sid => {
      calls.getDraft.push(sid)

      return composerState.draft || null
    },
    setDraft: async (sid, text) => {
      calls.setDraft.push([sid, text])

      if (composerState.broken) {
        return false
      }

      composerState.draft = text

      return true
    },
    insertText: async (sid, text, opts) => {
      calls.insertText.push([sid, text, opts])

      return !composerState.broken
    },
    focus: sid => {
      calls.focus.push(sid)
    }
  }
}
