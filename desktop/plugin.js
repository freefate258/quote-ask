/**
 * quote-ask — ask about a selection, the way Codex does it.
 *
 * Select text anywhere in the Hermes Desktop conversation, click the small pill
 * that appears above it, and the selection lands in the message composer as a
 * markdown quote with the caret on the line below — ready for your question.
 *
 * Surfaces used (SDK only, no app markup is queried, no core module is touched):
 *   window.getSelection()  — read the selection and its rectangle
 *   host.composer          — write the quote into the live draft
 *   ctx.register           — a command-palette entry
 *   ctx.addEventListener   — document listeners, torn down on unload/disable
 *   ctx.os.writeClipboard  — fallback when no composer is mounted
 */
import { host, PALETTE_AREA } from '@hermes/plugin-sdk'

const ID = 'quote-ask'

/** Longer selections are cut at a line break (the model rarely needs more). */
const MAX_CHARS = 4000

/** Marks our own chrome, both for styling and for "is this my element" checks. */
const ATTR = 'data-quote-ask'
/** The pill's action buttons (quote & ask / copy). */
const BTN_ATTR = 'data-quote-ask-action'
const STYLE_ID = 'quote-ask-styles'

const MESSAGES = {
  en: {
    ask: 'Quote & ask',
    hint: 'Put this selection in the prompt, then type your question',
    copy: 'Copy',
    copyHint: 'Copy this selection as a Markdown quote',
    palette: 'Quote selection into the prompt',
    nothing: 'Select some text in the conversation first.',
    noComposer: 'No open composer to put the quote in — copied it to the clipboard instead.',
    copied: 'Quote copied to the clipboard.',
    copiedSelection: 'Selection copied as a Markdown quote.',
    failed: 'Could not put the quote into the composer.',
    copyFailed: 'Could not copy the selection.',
    truncated: '… (rest of the selection left out)'
  },
  zh: {
    ask: '引用提问',
    hint: '把选中的内容放进输入框，然后写下你的问题',
    copy: '复制',
    copyHint: '把选中的内容复制为 Markdown 引用',
    palette: '引用选中内容并提问',
    nothing: '先在对话里选中一段文字。',
    noComposer: '现在没有可写入的输入框，已把引用复制到剪贴板。',
    copied: '引用已复制到剪贴板。',
    copiedSelection: '已把选中内容复制为 Markdown 引用。',
    failed: '没能把引用写进输入框。',
    copyFailed: '复制失败。',
    truncated: '……（后面的内容略去）'
  }
}

// ── selection → markdown ─────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SUMMARY'
])

function tagOf(node) {
  return (node.tagName || '').toUpperCase()
}

/** Flattened text of a subtree — for inline elements and link labels. */
function textOf(node) {
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

function fenceLanguage(pre) {
  const code = Array.from(pre.querySelectorAll('code'))[0]
  const cls = code ? code.className || '' : pre.className || ''
  const match = String(cls).match(/language-([\w+#.-]+)/)
  return match ? match[1] : ''
}

function listToMarkdown(list, depth, ordered) {
  const pad = '  '.repeat(depth)
  const items = Array.from(list.children).filter(child => tagOf(child) === 'LI')

  return items
    .map((item, index) => {
      const nested = Array.from(item.children).filter(child => {
        const tag = tagOf(child)
        return tag === 'UL' || tag === 'OL'
      })
      const lead = Array.from(item.childNodes)
        .filter(child => nested.indexOf(child) === -1)
        .map(child => walk(child, depth))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      const head = pad + (ordered ? `${index + 1}. ` : '- ') + lead

      if (!nested.length) {
        return head
      }

      const sub = nested
        .map(child => listToMarkdown(child, depth + 1, tagOf(child) === 'OL'))
        .join('\n')

      return `${head}\n${sub}`
    })
    .join('\n')
}

/** Serialize one node of a cloned selection fragment. Code keeps its newlines,
 *  prose is collapsed, blocks are separated by blank lines. */
function walk(node, depth) {
  if (node.nodeType === 3) {
    return (node.nodeValue || '').replace(/\s+/g, ' ')
  }

  if (node.nodeType !== 1) {
    return ''
  }

  const tag = tagOf(node)
  const kids = () => Array.from(node.childNodes).map(child => walk(child, depth)).join('')

  switch (tag) {
    case 'BR':
      return '\n'
    case 'HR':
      return '\n\n---\n\n'
    case 'PRE': {
      const code = (node.textContent || '').replace(/\n+$/, '')

      return code.trim() ? `\n\n\`\`\`${fenceLanguage(node)}\n${code}\n\`\`\`\n\n` : ''
    }
    case 'CODE':
      return `\`${textOf(node)}\``
    case 'STRONG':
    case 'B':
      return `**${kids()}**`
    case 'EM':
    case 'I':
      return `*${kids()}*`
    case 'DEL':
    case 'S':
      return `~~${kids()}~~`
    case 'IMG': {
      const alt = node.getAttribute('alt') || ''
      const src = node.getAttribute('src') || ''

      return src ? `![${alt}](${src})` : ''
    }
    case 'A': {
      const href = node.getAttribute('href') || ''
      const label = kids()

      return /^https?:\/\//i.test(href) ? `[${label || href}](${href})` : label
    }
    case 'UL':
    case 'OL':
      return `\n${listToMarkdown(node, depth, tag === 'OL')}\n`
    case 'LI':
    case 'TD':
    case 'TH':
      return kids()
    case 'TR': {
      const cells = Array.from(node.children).map(cell => walk(cell, depth).trim())

      return `| ${cells.join(' | ')} |\n`
    }
    case 'TABLE':
      return `\n${kids()}\n`
    default:
      return BLOCK_TAGS.has(tag) ? `\n${kids()}\n` : kids()
  }
}

function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toMarkdown(fragment) {
  return tidy(Array.from(fragment.childNodes).map(node => walk(node, 0)).join(''))
}

function cut(text, note) {
  if (text.length <= MAX_CHARS) {
    return text
  }

  const head = text.slice(0, MAX_CHARS)
  const brk = head.lastIndexOf('\n')
  const body = brk > MAX_CHARS * 0.5 ? head.slice(0, brk) : head

  return `${body}\n\n${note}`
}

function toQuoteBlock(markdown) {
  return markdown
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

// ── widget state ─────────────────────────────────────────────────────────────

let ctx = null
let pill = null
let askButton = null
let copyButton = null
/** The selection the pill is currently offering: { markdown, x, top, bottom }. */
let pending = null

function t(key, ...args) {
  return ctx && ctx.i18n ? ctx.i18n.t(key, ...args) : key
}

function elementOf(node) {
  if (!node) {
    return null
  }

  return node.nodeType === 3 ? node.parentElement : node
}

function matches(element, selector) {
  return !!(element && element.closest && element.closest(selector))
}

/** Our own chrome — the pill's own clicks must not re-read or clear anything. */
function isOwn(element) {
  return matches(element, `[${ATTR}]`)
}

/** The draft editor: quoting the text you are already typing makes no sense. */
function isEditable(element) {
  return matches(element, '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],textarea,input')
}

/** The live selection as markdown + the rectangle the pill hangs off, or null. */
function readSelection() {
  if (typeof window === 'undefined' || !window.getSelection) {
    return null
  }

  const sel = window.getSelection()

  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null
  }

  const anchor = elementOf(sel.anchorNode)
  const focus = elementOf(sel.focusNode)

  if (isOwn(anchor) || isOwn(focus) || isEditable(anchor) || isEditable(focus)) {
    return null
  }

  const range = sel.getRangeAt(0)
  const markdown = cut(toMarkdown(range.cloneContents()), t('truncated'))

  if (!markdown) {
    return null
  }

  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  const width = rect ? rect.width : 0
  const top = rect && (rect.top || rect.height) ? rect.top : 0
  const bottom = rect && (rect.bottom || rect.height) ? rect.bottom : top
  const x = width ? rect.left + width / 2 : rect ? rect.left + 60 : 120

  return { markdown, x, top, bottom }
}

// ── the pill ─────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return
  }

  const style = document.createElement('style')

  style.id = STYLE_ID
  // Theme tokens only — never a hardcoded colour, so every skin keeps working.
  style.textContent = `
[${ATTR}="pill"]{position:fixed;left:0;top:0;display:none;align-items:center;padding:2px;
  background:var(--ui-bg-elevated);color:var(--ui-text-primary);
  border:1px solid var(--ui-stroke-secondary);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-nous);z-index:var(--z-modal-popover);
  transform:translate(-50%,-100%);animation:quote-ask-in .12s ease-out;font-family:inherit}
[${BTN_ATTR}]{appearance:none;margin:0;border:0;background:transparent;color:inherit;font:inherit;
  font-size:.6875rem;line-height:1rem;padding:.125rem .375rem;border-radius:calc(var(--radius-lg) - 2px);
  cursor:pointer;white-space:nowrap}
[${BTN_ATTR}]:hover{background:var(--chrome-action-hover)}
[${BTN_ATTR}]:focus-visible{outline:1px solid var(--ui-accent);outline-offset:1px}
[${BTN_ATTR}="separator"]{width:1px;align-self:stretch;margin:3px 2px;background:var(--ui-stroke-secondary)}
@keyframes quote-ask-in{from{opacity:0;translate:0 5px;scale:.96}to{opacity:1;translate:0 0;scale:1}}
@media (prefers-reduced-motion:reduce){[${ATTR}="pill"]{animation:none}}
`

  document.head.append(style)
  ctx.onDispose(() => style.remove())
}

/** One pill action: a plain button whose listener dies with the plugin. */
function actionButton(action, onClick) {
  const button = document.createElement('button')

  button.setAttribute(BTN_ATTR, action)
  button.type = 'button'
  ctx.addEventListener(button, 'click', onClick)

  return button
}

function ensurePill() {
  if (pill && pill.isConnected) {
    return pill
  }

  injectStyles()

  const wrap = document.createElement('div')
  const button = actionButton('ask', () => ask(pending ? pending.markdown : null))
  const copy = actionButton('copy', () => copyQuote(pending ? pending.markdown : null))
  const separator = document.createElement('span')

  wrap.setAttribute(ATTR, 'pill')
  wrap.setAttribute('role', 'toolbar')
  separator.setAttribute(BTN_ATTR, 'separator')
  wrap.append(button, separator, copy)

  // A click on the pill must not collapse the browser selection before the
  // click handler runs — the quote is captured at selection time anyway, but
  // keeping the highlight steady is what makes the two read as one gesture.
  ctx.addEventListener(wrap, 'mousedown', event => event.preventDefault())
  ctx.addEventListener(wrap, 'mouseup', event => event.stopPropagation())

  document.body.append(wrap)
  ctx.onDispose(() => wrap.remove())

  pill = wrap
  askButton = button
  copyButton = copy

  return pill
}

function positionPill(info) {
  const margin = 8
  const width = pill.offsetWidth || 96
  const height = pill.offsetHeight || 26
  const half = width / 2
  const limit = Math.max(half + margin, window.innerWidth - half - margin)
  const x = Math.min(Math.max(info.x, half + margin), limit)
  const above = info.top - 12 - height >= margin

  pill.style.left = `${Math.round(x)}px`
  pill.style.top = `${Math.round(above ? info.top - 12 : info.bottom + 12)}px`
  pill.style.transform = above ? 'translate(-50%,-100%)' : 'translate(-50%,0)'
}

function showPill(info) {
  ensurePill()
  askButton.textContent = t('ask')
  askButton.title = t('hint')
  copyButton.textContent = t('copy')
  copyButton.title = t('copyHint')
  pending = info
  pill.style.display = 'flex'
  positionPill(info)
}

function hidePill() {
  pending = null

  if (pill && pill.isConnected) {
    pill.style.display = 'none'
  }
}

// ── writing the quote ────────────────────────────────────────────────────────

function focusedSessionId() {
  const state = host && host.state
  const atom = state && state.focusedSessionId

  return atom && typeof atom.get === 'function' ? atom.get() : null
}

/**
 * Put `markdown` in the composer as a quote and seat the caret below it.
 *
 * The draft path is preferred because it is the only one that keeps a trailing
 * newline: `insertText` trims, which would leave the caret glued to the last
 * quoted line and the user's question inside the quote. Draft → insert → the
 * clipboard, in that order.
 */
async function putQuote(markdown) {
  const composer = host && host.composer

  if (!composer) {
    return false
  }

  const sid = focusedSessionId() || null
  const block = toQuoteBlock(markdown)

  if (typeof composer.getDraft === 'function' && typeof composer.setDraft === 'function') {
    try {
      const current = await composer.getDraft(sid)
      const base = typeof current === 'string' ? current.replace(/\s+$/, '') : ''
      const next = base ? `${base}\n\n${block}\n` : `${block}\n`

      if (await composer.setDraft(sid, next)) {
        if (typeof composer.focus === 'function') {
          composer.focus(sid)
        }

        return true
      }
    } catch (error) {
      console.warn('[quote-ask] draft write failed', error)
    }
  }

  if (typeof composer.insertText === 'function') {
    try {
      if (await composer.insertText(sid, block, { mode: 'block' })) {
        if (typeof composer.focus === 'function') {
          composer.focus(sid)
        }

        return true
      }
    } catch (error) {
      console.warn('[quote-ask] composer insert failed', error)
    }
  }

  return false
}

function clearHighlight() {
  try {
    const sel = window.getSelection()

    if (sel && !sel.isCollapsed) {
      sel.removeAllRanges()
    }
  } catch {
    // A detached selection is not worth a failed gesture.
  }
}

/** The markdown to quote: the text the pill captured, or the live selection. */
function resolveQuote(markdown) {
  if (markdown != null) {
    return tidy(markdown)
  }

  const info = readSelection()

  return tidy(info ? info.markdown : '')
}

/** Quote the given markdown (or the current selection) into the prompt. */
async function ask(markdown) {
  const body = resolveQuote(markdown)

  hidePill()

  if (!body) {
    host.notify({ kind: 'info', message: t('nothing') })

    return
  }

  clearHighlight()

  const quoted = cut(body, t('truncated'))

  if (await putQuote(quoted)) {
    return
  }

  // Nothing took the draft (no composer mounted, or a pane that cannot write):
  // the selection still belongs somewhere the user asked for it.
  const copied = await writeClipboard(`${toQuoteBlock(quoted)}\n`)

  host.notify({ kind: copied ? 'info' : 'error', message: t(copied ? 'noComposer' : 'failed') })
}

/** Copy the given markdown (or the current selection) as a Markdown quote. */
async function copyQuote(markdown) {
  const body = resolveQuote(markdown)

  hidePill()

  if (!body) {
    host.notify({ kind: 'info', message: t('nothing') })

    return
  }

  clearHighlight()

  const quoted = cut(body, t('truncated'))
  const copied = await writeClipboard(`${toQuoteBlock(quoted)}\n`)

  host.notify({ kind: copied ? 'info' : 'error', message: t(copied ? 'copiedSelection' : 'copyFailed') })
}

/** Clipboard through the OS door; resolves false when it is unavailable. */
async function writeClipboard(text) {
  if (!ctx.os || typeof ctx.os.writeClipboard !== 'function') {
    return false
  }

  try {
    return await ctx.os.writeClipboard(text)
  } catch (error) {
    console.warn('[quote-ask] clipboard write failed', error)

    return false
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

function onMouseUp(event) {
  if (isOwn(event.target)) {
    return
  }

  ctx.setTimeout(() => {
    const info = readSelection()

    if (info) {
      showPill(info)
    }
  }, 0)
}

function onSelectionChange() {
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null

  if (!sel || sel.isCollapsed) {
    hidePill()
  }
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    hidePill()
  }
}

function onPointerDown(event) {
  if (!isOwn(event.target)) {
    hidePill()
  }
}

export default {
  id: ID,
  name: 'Quote & Ask',

  register(pluginCtx) {
    ctx = pluginCtx
    ctx.i18n.register(MESSAGES)

    // Document-level, because the selection can start anywhere — a message, a
    // diff, a log line. All four come back off on disable/reload.
    ctx.addEventListener(document, 'mouseup', onMouseUp)
    ctx.addEventListener(document, 'selectionchange', onSelectionChange)
    ctx.addEventListener(document, 'keydown', onKeyDown)
    ctx.addEventListener(document, 'mousedown', onPointerDown)
    ctx.addEventListener(document, 'scroll', hidePill, true)
    ctx.addEventListener(window, 'blur', hidePill)
    ctx.onDispose(() => {
      pending = null
      pill = null
      askButton = null
      copyButton = null
      ctx = null
    })

    ctx.register({
      id: 'quote-selection',
      area: PALETTE_AREA,
      data: {
        id: 'quote-ask.ask',
        label: ctx.i18n.t('palette'),
        keywords: ['quote', 'ask', 'selection', 'prompt', '引用', '提问', '选中'],
        run: () => {
          ask(null)
        }
      }
    })

    console.info('[quote-ask] ready — select text in a conversation to quote it into the prompt')
  }
}
