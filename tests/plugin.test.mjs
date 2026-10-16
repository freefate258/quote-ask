/**
 * Harness for the quote-ask desktop plugin: real DOM (jsdom), stubbed SDK.
 * The plugin file is copied in beside this test by the run command, so what
 * runs here is exactly what sits in the plugin directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calls, composerState } from './stub-sdk.mjs'
import plugin from './plugin.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

const TRANSCRIPT = `<div data-role="assistant">
  <p>前面一句 <strong>重点</strong> 后面一句</p>
  <pre><code class="language-js">const a = 1;
  const b = 2;</code></pre>
  <ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>
</div>`

let live = []

function start() {
  const registrations = []
  const disposers = []
  const ctx = {
    // The app resolves real strings; echoing the key keeps the assertions
    // reading as message keys instead of copies of the bundle.
    i18n: { register: () => () => {}, t: key => key },
    register: contribution => {
      registrations.push(contribution)

      return () => {}
    },
    addEventListener: (target, type, listener, options) => {
      target.addEventListener(type, listener, options)

      return () => target.removeEventListener(type, listener, options)
    },
    onDispose: fn => {
      disposers.push(fn)
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms)

      return () => clearTimeout(id)
    },
    os: {
      writeClipboard: async text => {
        calls.clipboard.push(text)

        return true
      }
    }
  }

  plugin.register(ctx)

  const handle = {
    registrations,
    stop: () => disposers.splice(0).forEach(fn => fn())
  }

  live.push(handle)

  return handle
}

function select(node) {
  const range = document.createRange()

  range.selectNodeContents(node)
  const sel = window.getSelection()

  sel.removeAllRanges()
  sel.addRange(range)
}

function pill() {
  return document.querySelector('[data-quote-ask="pill"]')
}

function action(name) {
  return document.querySelector(`[data-quote-ask-action="${name}"]`)
}

async function selectByMouse(node) {
  select(node)
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await tick()
}

beforeEach(() => {
  for (const key of Object.keys(calls)) {
    calls[key].length = 0
  }

  composerState.draft = ''
  composerState.broken = false
  document.body.innerHTML = ''
})

afterEach(() => {
  for (const handle of live) {
    handle.stop()
  }

  live = []
  document.body.innerHTML = ''
  document.getElementById('quote-ask-styles')?.remove()
})

describe('quote-ask', () => {
  it('registers a palette command and both locale bundles', () => {
    const handle = start()
    const command = handle.registrations.find(c => c.area === 'palette')

    expect(plugin.id).toBe('quote-ask')
    expect(command?.data.id).toBe('quote-ask.ask')
    expect(typeof command?.data.run).toBe('function')
  })

  it('offers ask and copy for a selection in a message', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT

    await selectByMouse(document.querySelector('[data-role="assistant"]'))

    expect(pill()).toBeTruthy()
    expect(pill().style.display).toBe('flex')
    expect(action('ask').textContent).toBe('ask')
    expect(action('copy').textContent).toBe('copy')
    expect(calls.setDraft).toHaveLength(0)
  })

  it('writes the selection into an empty composer as a quote, caret line last', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT

    await selectByMouse(document.querySelector('[data-role="assistant"]'))
    action('ask').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(calls.setDraft).toHaveLength(1)

    const [sid, text] = calls.setDraft[0]

    expect(sid).toBe('sess-1')
    expect(text.startsWith('> 前面一句 **重点** 后面一句')).toBe(true)
    expect(text).toContain('> ```js')
    expect(text).toContain('> const a = 1;')
    // Code indentation survives verbatim, prose whitespace is collapsed.
    expect(text).toContain('\n>   const b = 2;')
    expect(text).toContain('>   - 甲一')
    // A trailing newline is what seats the caret under the quote.
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(calls.focus).toEqual(['sess-1'])
  })

  it('keeps an existing draft and separates the quote from it', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT
    composerState.draft = '已经写了一半'

    await selectByMouse(document.querySelector('[data-role="assistant"]'))
    action('ask').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const [, text] = calls.setDraft[0]

    expect(text.startsWith('已经写了一半\n\n> ')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('copies the selection as a Markdown quote without touching the composer', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT

    await selectByMouse(document.querySelector('[data-role="assistant"]'))
    action('copy').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(calls.setDraft).toHaveLength(0)
    expect(calls.insertText).toHaveLength(0)
    expect(calls.clipboard).toHaveLength(1)
    expect(calls.clipboard[0].startsWith('> 前面一句 **重点** 后面一句')).toBe(true)
    expect(calls.clipboard[0].includes('> ```js')).toBe(true)
    expect(calls.clipboard[0].endsWith('\n')).toBe(true)
    expect(calls.notify.at(-1)).toEqual({ kind: 'info', message: 'copiedSelection' })
  })

  it('ignores a selection made inside the composer', async () => {
    start()
    document.body.innerHTML = '<div contenteditable="true"><p>草稿文字</p></div>'

    await selectByMouse(document.querySelector('[contenteditable]'))

    expect(pill()).toBeNull()
  })

  it('hides the pill when the selection collapses', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT

    await selectByMouse(document.querySelector('[data-role="assistant"]'))
    expect(pill().style.display).toBe('flex')

    window.getSelection().removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await tick()

    expect(pill().style.display).toBe('none')
  })

  it('falls back to the clipboard when no composer accepts the draft', async () => {
    start()
    document.body.innerHTML = TRANSCRIPT
    composerState.broken = true

    await selectByMouse(document.querySelector('[data-role="assistant"]'))
    action('ask').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    expect(calls.setDraft).toHaveLength(1)
    expect(calls.insertText).toHaveLength(1)
    expect(calls.clipboard).toHaveLength(1)
    expect(calls.notify.at(-1)).toEqual({ kind: 'info', message: 'noComposer' })
  })

  it('tells the user to select something when the palette command runs empty', async () => {
    const handle = start()
    const command = handle.registrations.find(c => c.area === 'palette')

    await command.data.run()
    await tick()

    expect(calls.setDraft).toHaveLength(0)
    expect(calls.notify.at(-1)).toEqual({ kind: 'info', message: 'nothing' })
  })

  it('quotes the live selection from the palette command', async () => {
    const handle = start()
    document.body.innerHTML = TRANSCRIPT
    select(document.querySelector('[data-role="assistant"]'))

    await handle.registrations.find(c => c.area === 'palette').data.run()
    await tick()

    expect(calls.setDraft).toHaveLength(1)
    expect(calls.setDraft[0][1].startsWith('> 前面一句')).toBe(true)
  })
})
