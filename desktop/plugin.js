/**
 * quote-ask — ask about a selection, the way Codex does it.
 *
 * Select text anywhere in the Hermes Desktop conversation, click the small pill
 * that appears above it, and the selection lands in the message composer as a
 * markdown quote with the caret on the line below — ready for your question.
 * Or click "Quote to new chat" to spin up a fresh session pre-populated with
 * a @session reference to the origin conversation, any selected images, and
 * the markdown quote.
 *
 * Surfaces used (SDK only, no app markup is queried, no core module is touched):
 *   window.getSelection()  — read the selection and its rectangle
 *   host.composer          — write the quote into the live draft
 *   host.newChat           — open a fresh session draft
 *   ctx.runAction          — built-in 'session.new' action
 *   ctx.register           — command-palette entries
 *   ctx.addEventListener   — document listeners, torn down on unload/disable
 *   ctx.os.writeClipboard  — fallback when no composer is mounted
 */
import { host, PALETTE_AREA } from '@hermes/plugin-sdk'

const ID = 'quote-ask'

/** Longer selections are cut at a line break (the model rarely needs more). */
const MAX_CHARS = 4000

/** Marks our own chrome, both for styling and for "is this my element" checks. */
const ATTR = 'data-quote-ask'
/** The pill's action buttons (quote & ask / quote to new chat / copy). */
const BTN_ATTR = 'data-quote-ask-action'
const STYLE_ID = 'quote-ask-styles'

const MESSAGES = {
  en: {
    ask: 'Quote & ask',
    hint: 'Put this selection in the prompt, then type your question',
    newChat: 'Quote to new chat',
    newChatHint: 'Start a new session quoting this selection (with origin session & images)',
    copy: 'Copy',
    copyHint: 'Copy this selection as a Markdown quote',
    palette: 'Quote selection into the prompt',
    paletteNewChat: 'Quote selection into a new chat',
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
    newChat: '引至新会话',
    newChatHint: '开启新会话并自动填入引用内容（附带原会话链接与选中图片）',
    copy: '复制',
    copyHint: '把选中的内容复制为 Markdown 引用',
    palette: '引用选中内容并提问',
    paletteNewChat: '引用选中内容开启新会话',
    nothing: '先在对话里选中一段文字。',
    noComposer: '现在没有可写入的输入框，已把引用复制到剪贴板。',
    copied: '引用已复制到剪贴板。',
    copiedSelection: '已把选中内容复制为 Markdown 引用。',
    failed: '没能把引用写进输入框。',
    copyFailed: '复制失败。',
    truncated: '……（后面的内容略去）'
  }
}

// ── selection → markdown & images ────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SUMMARY'
])

/** Hermes reference tokens (`@file:...`, `@session:...`, etc.) that the
 *  composer's `REF_RE` (`reference-kinds.ts`) parses into non-editable chips.
 *  When such a token appears inside quoted prose (`> ...`) or an inline `<code>`
 *  span (e.g. `` `@session:<profile>/<id>` ``), its unescaped `@kind:` prefix
 *  or closing backtick/quote causes `REF_RE` to mis-tokenize the draft and
 *  swallow surrounding text into the chip's hidden `title`/`data-ref-id`
 *  attribute. Inserting a zero-width space (`\u200B`) after `@` inside quoted
 *  content keeps the visual text identical while preventing `REF_RE` from
 *  hijacking quoted mentions as live composer directives. */
const QUOTED_DIRECTIVE_RE = /@(file|folder|url|image|tool|line|terminal|session|git|diff|staged)\b/gi

function neutralizeQuotedDirectives(text) {
  return String(text || '').replace(QUOTED_DIRECTIVE_RE, '@\u200B$1')
}

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

function isDataImage(src) {
  return /^data:image\//i.test(String(src || '').trim())
}

/** Serialize one node of a cloned selection fragment. Code keeps its newlines,
 *  prose is collapsed, blocks are separated by blank lines. Huge data:image
 *  URLs are attached as real composer image chips rather than dumped as raw
 *  base64 text into the markdown quote. */
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
      const alt = node.getAttribute('alt') || 'image'
      const src = (node.getAttribute('src') || '').trim()

      if (!src) {
        return ''
      }

      return isDataImage(src) ? `[图片: ${alt}]` : `![${alt}](${src})`
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

function extractImagesFromFragment(fragment) {
  if (!fragment || typeof fragment.querySelectorAll !== 'function') {
    return []
  }

  const seen = new Set()
  const urls = []

  for (const img of Array.from(fragment.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') || '').trim()
    if (src && !seen.has(src)) {
      seen.add(src)
      urls.push(src)
    }
  }

  return urls
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

function toQuoteBlock(markdown, opts = {}) {
  const safe = opts.forComposer ? neutralizeQuotedDirectives(markdown) : markdown
  return safe
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

function formatRefValue(value) {
  if (!/[\s()[\]{}<>"'`]/.test(value)) {
    return value
  }
  if (!value.includes('`')) {
    return `\`${value}\``
  }
  if (!value.includes('"')) {
    return `"${value}"`
  }
  if (!value.includes("'")) {
    return `'${value}'`
  }
  return value
}

function originSessionRef() {
  const state = host && host.state
  if (!state) {
    return ''
  }

  const storedAtom = state.focusedStoredSessionId
  const focusedAtom = state.focusedSessionId
  const activeAtom = state.activeSessionId
  const profileAtom = state.focusedSessionProfile || state.profile

  const sid =
    (storedAtom && typeof storedAtom.get === 'function' && storedAtom.get()) ||
    (focusedAtom && typeof focusedAtom.get === 'function' && focusedAtom.get()) ||
    (activeAtom && typeof activeAtom.get === 'function' && activeAtom.get()) ||
    ''

  const cleanId = String(sid || '').trim()
  if (!cleanId || cleanId === 'new' || cleanId.startsWith('__new__')) {
    return ''
  }

  const profile =
    (profileAtom && typeof profileAtom.get === 'function' ? String(profileAtom.get() || '').trim() : '') || 'default'

  const target = cleanId.includes('/') ? cleanId : `${profile}/${cleanId}`
  return `@session:${formatRefValue(target)}`
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([\w./+-]+);base64,(.*)$/i.exec(String(dataUrl || '').trim())
  if (!match || typeof atob !== 'function' || typeof Blob === 'undefined') {
    return null
  }
  try {
    const bytes = atob(match[2])
    const buffer = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i += 1) {
      buffer[i] = bytes.charCodeAt(i)
    }
    return new Blob([buffer], { type: match[1] })
  } catch {
    return null
  }
}

async function resolveImageBlobs(urls) {
  if (!Array.isArray(urls) || !urls.length) {
    return []
  }

  const blobs = []
  for (const url of urls) {
    if (isDataImage(url)) {
      const b = dataUrlToBlob(url)
      if (b && b.size > 0) {
        blobs.push(b)
      }
      continue
    }

    if (typeof fetch === 'function' && /^(?:https?|blob|file):/i.test(url)) {
      try {
        const res = await fetch(url)
        const b = await res.blob()
        if (b && b.size > 0 && (!b.type || b.type.startsWith('image/'))) {
          blobs.push(b)
        }
      } catch {
        // Ignore fetch errors for inaccessible remote URLs; markdown link still survives in text.
      }
    }
  }

  return blobs
}

function attachImagesToComposer(blobs, target = 'active') {
  if (!blobs.length || typeof window === 'undefined' || typeof CustomEvent === 'undefined') {
    return
  }

  window.dispatchEvent(
    new CustomEvent('hermes:composer-attach-images', {
      detail: { blobs, target }
    })
  )
}

// ── widget state ─────────────────────────────────────────────────────────────

let ctx = null
let pill = null
let askButton = null
let newChatButton = null
let copyButton = null
/** The selection the pill is currently offering: { markdown, images, sessionRef, x, top, bottom }. */
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

/** The live selection as markdown + images + rectangle, or null. */
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
  const fragment = range.cloneContents()
  const images = extractImagesFromFragment(fragment)
  const markdown = cut(toMarkdown(fragment), t('truncated'))

  if (!markdown && !images.length) {
    return null
  }

  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  const width = rect ? rect.width : 0
  const top = rect && (rect.top || rect.height) ? rect.top : 0
  const bottom = rect && (rect.bottom || rect.height) ? rect.bottom : top
  const x = width ? rect.left + width / 2 : rect ? rect.left + 60 : 120

  return {
    markdown,
    images,
    sessionRef: originSessionRef(),
    x,
    top,
    bottom
  }
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
  const button = actionButton('ask', () => ask(pending))
  const newChat = actionButton('new-chat', () => askInNewChat(pending))
  const copy = actionButton('copy', () => copyQuote(pending ? pending.markdown : null))
  const sep1 = document.createElement('span')
  const sep2 = document.createElement('span')

  wrap.setAttribute(ATTR, 'pill')
  wrap.setAttribute('role', 'toolbar')
  sep1.setAttribute(BTN_ATTR, 'separator')
  sep2.setAttribute(BTN_ATTR, 'separator')
  wrap.append(button, sep1, newChat, sep2, copy)

  // A click on the pill must not collapse the browser selection before the
  // click handler runs — the quote is captured at selection time anyway, but
  // keeping the highlight steady is what makes the two read as one gesture.
  ctx.addEventListener(wrap, 'mousedown', event => event.preventDefault())
  ctx.addEventListener(wrap, 'mouseup', event => event.stopPropagation())

  document.body.append(wrap)
  ctx.onDispose(() => wrap.remove())

  pill = wrap
  askButton = button
  newChatButton = newChat
  copyButton = copy

  return pill
}

function positionPill(info) {
  const margin = 8
  const width = pill.offsetWidth || 168
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
  newChatButton.textContent = t('newChat')
  newChatButton.title = t('newChatHint')
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
async function putQuote(markdown, opts = {}) {
  const composer = host && host.composer

  if (!composer) {
    return false
  }

  const sid = opts.targetSessionId !== undefined ? opts.targetSessionId : focusedSessionId() || null
  const prefix = opts.prefix ? `${opts.prefix}\n\n` : ''
  const block = markdown ? toQuoteBlock(markdown, { forComposer: true }) : ''
  const payload = `${prefix}${block}`.trim()

  if (!payload) {
    return false
  }

  if (typeof composer.getDraft === 'function' && typeof composer.setDraft === 'function') {
    try {
      const current = opts.fresh ? '' : await composer.getDraft(sid)
      const base = typeof current === 'string' ? current.replace(/\s+$/, '') : ''
      const next = base ? `${base}\n\n${payload}\n` : `${payload}\n`

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
      if (await composer.insertText(sid, payload, { mode: 'block' })) {
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

/** Resolve selection snapshot from a pill click or command-palette invocation. */
function resolvePayload(input) {
  if (input && typeof input === 'object' && ('markdown' in input || 'images' in input)) {
    return {
      markdown: tidy(input.markdown || ''),
      images: Array.isArray(input.images) ? input.images : [],
      sessionRef: input.sessionRef || originSessionRef()
    }
  }

  if (typeof input === 'string') {
    return {
      markdown: tidy(input),
      images: [],
      sessionRef: originSessionRef()
    }
  }

  const info = readSelection()

  return {
    markdown: tidy(info ? info.markdown : ''),
    images: info && Array.isArray(info.images) ? info.images : [],
    sessionRef: info ? info.sessionRef : originSessionRef()
  }
}

/** Quote the given selection into the active prompt. */
async function ask(input) {
  const { markdown, images } = resolvePayload(input)

  hidePill()

  if (!markdown && !images.length) {
    host.notify({ kind: 'info', message: t('nothing') })

    return
  }

  clearHighlight()

  const quoted = markdown ? cut(markdown, t('truncated')) : ''
  const blobs = await resolveImageBlobs(images)

  if (blobs.length) {
    attachImagesToComposer(blobs, 'active')
  }

  if (!quoted) {
    if (host.composer && typeof host.composer.focus === 'function') {
      host.composer.focus(focusedSessionId() || null)
    }
    return
  }

  if (await putQuote(quoted)) {
    return
  }

  // Nothing took the draft (no composer mounted, or a pane that cannot write):
  // the selection still belongs somewhere the user asked for it.
  const copied = await writeClipboard(`${toQuoteBlock(quoted)}\n`)

  host.notify({ kind: copied ? 'info' : 'error', message: t(copied ? 'noComposer' : 'failed') })
}

function waitTick(ms = 24) {
  return new Promise(resolve => {
    if (ctx && typeof ctx.setTimeout === 'function') {
      ctx.setTimeout(resolve, ms)
    } else {
      setTimeout(resolve, ms)
    }
  })
}

function openFreshChat() {
  if (ctx && typeof ctx.runAction === 'function') {
    try {
      const res = ctx.runAction('session.new')
      if (res && res.ok) {
        return true
      }
    } catch {
      // Fall through to host.newChat
    }
  }

  if (host && typeof host.newChat === 'function') {
    try {
      host.newChat()
      return true
    } catch {
      return false
    }
  }

  return false
}

/** Open a brand-new session and populate its composer with @session ref + images + quote. */
async function askInNewChat(input) {
  const { markdown, images, sessionRef } = resolvePayload(input)

  hidePill()

  if (!markdown && !images.length) {
    host.notify({ kind: 'info', message: t('nothing') })

    return
  }

  clearHighlight()

  const quoted = markdown ? cut(markdown, t('truncated')) : ''
  const blobs = await resolveImageBlobs(images)

  openFreshChat()
  await waitTick(24)

  if (blobs.length) {
    attachImagesToComposer(blobs, 'main')
  }

  // Try addressing the fresh draft ('new') first, then fall back to the active composer (null).
  const landed =
    (await putQuote(quoted, { targetSessionId: 'new', prefix: sessionRef, fresh: true })) ||
    (await putQuote(quoted, { targetSessionId: null, prefix: sessionRef, fresh: true }))

  if (landed) {
    return
  }

  if (!quoted && blobs.length) {
    if (host.composer && typeof host.composer.focus === 'function') {
      host.composer.focus(null)
    }
    return
  }

  const fallbackText = [sessionRef, quoted ? toQuoteBlock(quoted) : ''].filter(Boolean).join('\n\n')
  const copied = await writeClipboard(`${fallbackText}\n`)

  host.notify({ kind: copied ? 'info' : 'error', message: t(copied ? 'noComposer' : 'failed') })
}

/** Copy the given markdown (or the current selection) as a Markdown quote. */
async function copyQuote(markdown) {
  const { markdown: body } = resolvePayload(markdown)

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
      newChatButton = null
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

    ctx.register({
      id: 'quote-selection-new-chat',
      area: PALETTE_AREA,
      data: {
        id: 'quote-ask.new-chat',
        label: ctx.i18n.t('paletteNewChat'),
        keywords: ['quote', 'new', 'chat', 'session', 'selection', '引用', '新会话', '新建', '对话'],
        run: () => {
          askInNewChat(null)
        }
      }
    })

    console.info('[quote-ask] ready — select text in a conversation to quote it into the prompt or a new chat')
  }
}
