# quote-ask

Ask about a selection, the way Codex does it — for Hermes Desktop.

Select text anywhere in a conversation (a message, a code block, a diff, a log
pane) and a small pill appears above the selection:

- **引用提问 / Quote & ask** — the selection lands in the message composer as a
  Markdown quote, with the caret on the line below, ready for your question.
- **复制 / Copy** — the same Markdown quote goes to the clipboard instead.

There is also a command-palette entry, **Quote selection into the prompt**, for
when the pill is out of reach.

## Install

Clone and drop the file into the app-level desktop plugin root:

```bash
git clone https://github.com/freefate258/quote-ask /tmp/quote-ask
mkdir -p "$HERMES_HOME/desktop-plugins/quote-ask"      # ~/.hermes/desktop-plugins/quote-ask
cp /tmp/quote-ask/desktop/plugin.js "$HERMES_HOME/desktop-plugins/quote-ask/plugin.js"
```

The app watches that directory and hot-loads the plugin within a few seconds —
no restart, no build step. `⌘K → Reload desktop plugins` forces a re-scan.

The plugin is Desktop-only: it declares no tools, no hooks, no Python code, so
nothing is installed into the agent's Python environment.

## What it does with your text

- Reads `window.getSelection()` when you finish a selection — the rectangle for
  placement, the text for the quote.
- Turns the selection into Markdown: headings stay blocks, `<pre>` becomes a
  fenced code block with its language, lists keep their nesting, `strong`/`em`
  become `**`/`*`, links keep their href. Selections longer than 4000 characters
  are cut at a line break.
- Writes the quote into the live composer through `host.composer`
  (`getDraft`/`setDraft`, falling back to `insertText`). An existing draft is
  kept and separated by a blank line. When no composer can take it, the quote
  goes to the clipboard and a notice says so.
- No network calls, no files written, no telemetry. Nothing is stored.

## Verification

`tests/` holds a DOM harness (vitest + jsdom) covering the whole path:
selection → Markdown → draft, the existing-draft case, the copy action, the
composer-interior guard, collapse-to-hide, and the clipboard fallback. It runs
against a stubbed `@hermes/plugin-sdk`, so no app build is needed. Run it from a
checkout that has `vitest` and `jsdom` (the Hermes source checkout does):

```bash
cd <hermes-agent-checkout>
rm -rf .quote-ask-test && mkdir .quote-ask-test
cp tests/* .quote-ask-test/
cp desktop/plugin.js .quote-ask-test/
cd .quote-ask-test && ../node_modules/.bin/vitest run
```

10 tests, all passing against the content of this repo.

## Layout

```
plugin.yaml          manifest (Desktop entry: desktop/plugin.js)
desktop/plugin.js    the whole plugin — plain ESM, SDK imports only
tests/               jsdom harness + SDK stub
```

`desktop/plugin.js` is also the file that gets installed as
`$HERMES_HOME/desktop-plugins/quote-ask/plugin.js`; keep the two copies in sync
(or symlink the directory) when editing.
