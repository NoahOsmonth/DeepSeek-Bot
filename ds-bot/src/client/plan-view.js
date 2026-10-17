// The plan tab type: takes over DSH's builtin plan viewer in Bot mode and adds a Copy
// control that writes the displayed plan's source text verbatim to the clipboard.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { t } from './i18n.js'

export const PLAN_ID = 'ds-bot/plan'
export const PLAN_KIND = 'plan'

// The same addresses DSH's builtin plan type claims (dsh-client-ui-plan/lib/client.js:
// 630-637); the extension band is in force over the builtin and gives it back on dispose.
const PATTERNS = ['dsh-resource://plan/**', 'dsh-resource://plan-review/**']
const REVIEW_ADDRESS = /^dsh-resource:\/\/plan-review\/[^/?#]+\/[^/?#]+$/

const COPIED_MS = 1200
const FAILED_MS = 2000

export const isReviewPreview = address => typeof address === 'string' && REVIEW_ADDRESS.test(address)

// What the tab shows, as plain data: a review preview reads its document from the
// navigation params it was opened with, a logged plan from the resource's value.
export function planView(tab, resource) {
  const navigation = tab?.navigation
  if (isReviewPreview(navigation?.address)) {
    const review = navigation.params?.planReview
    if (review === undefined || review === null) return { state: 'expired' }
    return { state: 'review', document: review }
  }
  switch (resource?.status) {
    case 'live': return { state: 'live', document: resource.value }
    case 'failed': return { state: 'failed', failure: resource.failure }
    case 'none': return { state: 'unavailable' }
    default: return { state: 'loading' }
  }
}

const stateLine = view => (view.state === 'loading'
  ? t('Loading the plan…')
  : view.state === 'unavailable'
    ? t('This plan is not available.')
    : view.state === 'expired'
      ? t('This plan preview has expired.')
      : t('The plan could not be loaded.'))

// The plan text is written as it is; a denied write or a missing clipboard is a
// failure, never a success (feedback.js:24-26 maps the same rejection to false).
const writeClipboard = (text) => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) return Promise.resolve(false)
  return clipboard.writeText(text).then(() => true, () => false)
}

const markdownLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

export function PlanBody({ useTabInfo, useResource }) {
  const info = useTabInfo()
  const tab = info.tab
  const resource = useResource(tab.navigation.address)
  const view = planView(tab, resource)
  const [status, setStatus] = useState(null)
  const timer = useRef(null)
  const stop = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => stop, [])
  const announce = (next, delay) => {
    stop()
    setStatus(next)
    timer.current = setTimeout(() => {
      timer.current = null
      setStatus(null)
    }, delay)
  }
  const copy = () => {
    const markdown = view.document?.markdown
    if (typeof markdown !== 'string' || markdown === '') {
      announce('failed', FAILED_MS)
      return undefined
    }
    return writeClipboard(markdown).then((written) => {
      announce(written ? 'copied' : 'failed', written ? COPIED_MS : FAILED_MS)
    })
  }
  return h('section', { className: 'bt-plan' },
    h('div', { className: 'bt-plan-bar' },
      h('button', {
        type: 'button',
        className: 'bt-plan-copy',
        title: t('Copy plan as Markdown'),
        onClick: copy,
      }, h('span', { 'aria-live': 'polite' }, status === 'copied' ? t('Copied') : t('Copy')))),
    status === 'failed' ? h('p', { className: 'bt-plan-note', role: 'status' }, t('Could not copy the plan.')) : null,
    view.document === undefined
      ? h('div', { className: 'bt-plan-state', role: 'status' },
        stateLine(view),
        view.state === 'failed' ? h('p', null, view.failure?.message) : null)
      : h('div', { className: 'bt-plan-doc' }, h(MarkdownText, { text: view.document.markdown, labels: markdownLabels() })))
}

export function PlanTabTitle({ useTabInfo, useResource }) {
  const info = useTabInfo()
  const tab = info.tab
  const resource = useResource(tab.navigation.address)
  const view = planView(tab, resource)
  return view.document?.title ?? tab.title ?? t('Plan')
}

// One step in installShell's list: it registers the tab type and the two keyed seats
// and returns the disposer that hands the plan kind back to DSH's builtin viewer.
// Without the sidebarRightTabs service nothing registers and nothing throws.
export function installPlanView(ctx) {
  const fiber = ctx.inject(['slots', 'sidebarRightTabs'], (scope) => {
    const offType = scope.sidebarRightTabs.register({
      id: PLAN_ID,
      kind: PLAN_KIND,
      priority: 'extension',
      patterns: PATTERNS,
      title: () => t('Plan'),
    })
    const offBody = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: PLAN_ID,
    }, PlanBody))
    const offTitle = scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: PLAN_ID,
    }, PlanTabTitle))
    return () => {
      offTitle?.()
      offBody?.()
      offType?.()
    }
  })
  return () => fiber?.dispose?.()
}

export const PLAN_CSS = `
.bt-plan{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bt-card)}
.bt-plan-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:6px 12px;border-bottom:1px solid var(--bt-line)}
.bt-plan-copy{font:inherit;color:var(--bt-ink-2);background:transparent;border:1px solid var(--bt-line);border-radius:8px;padding:3px 10px;cursor:pointer}
.bt-plan-copy:hover{color:var(--bt-ink-2);background:var(--bt-hover)}
.bt-plan-copy:focus-visible{outline:2px solid var(--bt-line);outline-offset:1px}
.bt-plan-note{margin:0;padding:6px 12px;color:var(--bt-ink-2);border-bottom:1px solid var(--bt-line)}
.bt-plan-doc{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.bt-plan-state{display:flex;flex-direction:column;gap:6px;padding:16px;color:var(--bt-ink-2)}
.bt-plan-state p{margin:0}
`
