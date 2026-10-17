import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

// The plan view is bundled with esbuild and run in a vm, as the other client-module
// tests do: a fake React, a MarkdownText stub, and stubs for the clipboard, the
// selection and the timers. Nothing is imported at the top, so before the build every
// test fails as an assertion rather than as a crash.
const PLUGIN = fileURLToPath(new URL('../..', import.meta.url))
const MISSING = 'src/client/plan-view.js is missing or cannot be built: the plan view module under test does not exist yet'

let built
const planCode = async () => {
  if (built !== undefined) return built
  const esbuild = await import('esbuild').catch(() => null)
  if (!esbuild) return (built = null)
  try {
    const { outputFiles } = await esbuild.build({
      stdin: {
        contents: [
          "export * from './src/client/plan-view.js'",
          "export { groupsFor, surfaceGroups } from './src/client/surface.js'",
        ].join('\n'),
        resolveDir: PLUGIN,
      },
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
      external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    })
    built = outputFiles[0].text
  } catch { built = null }
  return built
}

let dictionaryCode
const dictionaryOf = async () => {
  if (dictionaryCode !== undefined) return dictionaryCode
  const esbuild = await import('esbuild').catch(() => null)
  if (!esbuild) return (dictionaryCode = null)
  try {
    const { outputFiles } = await esbuild.build({
      stdin: { contents: "export { DICTIONARY } from './src/client/i18n.js'", resolveDir: PLUGIN },
      bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    })
    const module = { exports: {} }
    runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
    dictionaryCode = module.exports.DICTIONARY
  } catch { dictionaryCode = null }
  return dictionaryCode
}

const primitives = new Proxy(
  { MarkdownText: ({ text }) => text, FileTypeIcon: () => null },
  { get: (target, name) => name === '__esModule' ? false : (name in target ? target[name] : () => null) },
)

// A minimal React: a component runs as a plain function, hook state lives per slot and
// a setState re-renders, and effects run after the render and clean up on unmount.
const makeRuntime = () => {
  const stores = new Map()
  const queue = []
  let path = []
  let cursor = 0
  let root = null
  let redraw = () => {}
  const store = () => {
    const key = `${path.join('/')}#${cursor++}`
    if (!stores.has(key)) stores.set(key, {})
    return stores.get(key)
  }
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const react = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const slot = store()
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [slot.value, next => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        redraw()
      }]
    },
    useRef(current) {
      const slot = store()
      if (!('ref' in slot)) slot.ref = { current }
      return slot.ref
    },
    useMemo(make) { store(); return make() },
    useCallback(fn) { store(); return fn },
    useEffect(effect, deps) {
      const slot = store()
      const changed = !slot.deps || deps === undefined || deps.length !== slot.deps.length || deps.some((dep, at) => dep !== slot.deps[at])
      slot.effect = effect
      if (changed) { slot.deps = deps; queue.push(slot) }
    },
    useLayoutEffect(effect, deps) { react.useEffect(effect, deps) },
    useId: () => 'plan-view',
  }
  const expand = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      path.push('c')
      const saved = cursor
      cursor = 0
      const out = node.type(node.props)
      cursor = saved
      path.pop()
      return expand(out)
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const flush = () => {
    for (const slot of queue.splice(0)) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const out = slot.effect()
      slot.cleanup = typeof out === 'function' ? out : undefined
    }
  }
  const draw = () => {
    path = []
    cursor = 0
    const tree = expand(root)
    flush()
    return tree
  }
  let last = null
  redraw = () => { if (root) last = draw() }
  return {
    react,
    mount(Component, props) {
      root = h(Component, props)
      last = draw()
      return last
    },
    tree: () => last,
    reset() {
      for (const slot of stores.values()) if (typeof slot.cleanup === 'function') slot.cleanup()
      stores.clear()
      queue.length = 0
      root = null
      last = null
    },
    unmount() { this.reset() },
  }
}

const text = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object') return String(node)
  return text(node.props?.children)
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props?.children, match)
}

const load = async ({ clipboard = 'ok' } = {}) => {
  const code = await planCode()
  if (code === null) return null
  const runtime = makeRuntime()
  const writes = []
  const timers = {
    pending: [],
    setTimeout(fn, delay) {
      const timer = { fn, delay }
      timers.pending.push(timer)
      return timer
    },
    clearTimeout(timer) { timers.pending = timers.pending.filter(item => item !== timer) },
  }
  const selection = { toString: () => 'the selected sentence' }
  const navigator = clipboard === 'missing' ? {} : {
    clipboard: {
      writeText: clipboard === 'denied'
        ? () => Promise.reject(new Error('the browser denied the write'))
        : async value => { writes.push(value) },
    },
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => {
      if (name === 'react') return runtime.react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`Unexpected platform module ${name}`)
    },
    navigator,
    document: { hidden: false },
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    getSelection: () => selection,
    window: { getSelection: () => selection },
  })
  return { exports: module.exports, runtime, timers, writes }
}

// The shell's own services, faked: the tab registry, the two seats, and cordis-style
// inject/effect so a missing service is simply absent instead of throwing.
const fakeCtx = ({ withTabs = true } = {}) => {
  const tabs = []
  const seats = []
  const ctx = {
    slots: {
      inject: (name, make) => make(),
      register(options, component) {
        const entry = { options, component }
        seats.push(entry)
        return () => {
          const at = seats.indexOf(entry)
          if (at >= 0) seats.splice(at, 1)
        }
      },
    },
    effect(make) {
      const off = make()
      return () => off?.()
    },
    inject(deps, make) {
      if (!deps.every(dep => ctx[dep] !== undefined)) return { dispose() {} }
      const off = make(ctx)
      return { dispose() { off?.() } }
    },
  }
  if (withTabs) {
    ctx.sidebarRightTabs = {
      register(definition) {
        const entry = { definition }
        tabs.push(entry)
        return () => {
          const at = tabs.indexOf(entry)
          if (at >= 0) tabs.splice(at, 1)
        }
      },
    }
  }
  return { ctx, tabs, seats }
}

const disposeOf = (value) => {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  assert.fail('installPlanView must return one disposer that unregisters the tab type, body and title')
}

const seatOf = (seats, name) => seats.find(seat => seat.options?.name === name && seat.options?.key === 'ds-bot/plan')

const bodyOf = (view) => {
  const { ctx, seats } = fakeCtx()
  view.exports.installPlanView(ctx)
  const seat = seatOf(seats, 'sidebar.right.pane.tab')
  assert.ok(seat, 'no plan body is registered at the sidebar.right.pane.tab seat under ds-bot/plan')
  return seat.component
}

const show = (view, tab, resource) => {
  view.runtime.mount(bodyOf(view), {
    useTabInfo: () => ({ tab }),
    useResource: () => resource,
    t: key => key,
  })
  return view
}
const shown = async (tab, resource, options) => {
  const view = await load(options)
  assert.ok(view, MISSING)
  return show(view, tab, resource)
}

const MARKDOWN = '  # Plan\n\nShip it on Friday.  \n'
const reviewTab = (params = { planReview: { markdown: MARKDOWN, title: 'Draft plan' } }) => ({
  navigation: { address: 'dsh-resource://plan-review/session-1/req-1', params },
  title: 'chip title',
})
const liveTab = () => ({ navigation: { address: 'dsh-resource://plan/session-1/call-1' }, title: 'chip title' })
const live = () => ({ status: 'live', value: { callId: 'call-1', markdown: MARKDOWN, title: 'Draft plan' } })
const none = () => ({ status: 'none' })
const loading = () => ({ status: 'loading' })
const failed = () => ({ status: 'failed', value: undefined, failure: { code: 'plan/read-failed', message: 'the plan history is gone' } })

const copyControl = tree => find(tree, node => typeof node.props?.onClick === 'function' && text(node).trim() === 'Copy')
const click = async (view) => {
  const control = copyControl(view.runtime.tree())
  assert.ok(control, 'the plan view draws no Copy control')
  await control.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
}

// the plan tab type, body and title register under ds-bot/plan and its disposer unregisters all three
test('R1 registers and disposes the plan tab type, body and title', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const { installPlanView } = view.exports
  assert.equal(typeof installPlanView, 'function', 'plan-view.js does not export installPlanView')
  const { ctx, tabs, seats } = fakeCtx()
  const dispose = disposeOf(installPlanView(ctx))
  assert.equal(tabs.length, 1, 'installPlanView registers no tab type')
  const definition = tabs[0].definition
  assert.equal(definition.id, 'ds-bot/plan', 'the tab type id is not ds-bot/plan')
  assert.equal(definition.kind, 'plan', 'the tab type kind is not plan')
  assert.equal(definition.priority ?? 'extension', 'extension', 'the tab type is not at the extension band')
  assert.deepEqual(JSON.parse(JSON.stringify(definition.patterns ?? [])).sort(),
    ['dsh-resource://plan-review/**', 'dsh-resource://plan/**'], 'the tab type does not claim the plan and plan-review globs')
  assert.deepEqual(seats.map(seat => `${seat.options.name}:${seat.options.key}`).sort(),
    ['sidebar.right.pane.tab.title:ds-bot/plan', 'sidebar.right.pane.tab:ds-bot/plan'], 'the body and title are not seated under ds-bot/plan')
  dispose()
  assert.deepEqual([tabs.length, seats.length], [0, 0], 'the disposer does not unregister the tab type, body and title')
})

// the plan view registers with the shell group and its tab type is withdrawn with the group
test('R2 registers the plan view with the shell group and withdraws it with the group', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const { installPlanView, groupsFor, surfaceGroups } = view.exports
  assert.equal(typeof installPlanView, 'function', 'plan-view.js does not export installPlanView')
  assert.equal(typeof surfaceGroups, 'function', 'src/client/surface.js does not export surfaceGroups')
  const { ctx, tabs, seats } = fakeCtx()
  const groups = surfaceGroups({ shell: () => [() => disposeOf(installPlanView(ctx))], conversation: () => [] })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.equal(tabs.length, 1, 'the shell group does not register the plan tab type')
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.deepEqual([tabs.length, seats.length], [0, 0], 'leaving bot mode does not withdraw the plan tab type, body and title')
  groups.dispose()
  const bare = fakeCtx({ withTabs: false })
  assert.doesNotThrow(() => installPlanView(bare.ctx), 'installPlanView throws without the sidebarRightTabs service')
  assert.deepEqual([bare.tabs.length, bare.seats.length], [0, 0], 'installPlanView registers something without the sidebarRightTabs service')
})

// a review preview reads markdown from tab navigation params and a review without it is expired
test('R3 reads review previews and reports an expired one', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const { planView } = view.exports
  assert.equal(typeof planView, 'function', 'plan-view.js does not export planView')
  const params = { planReview: { markdown: MARKDOWN, title: 'Draft plan' } }
  const review = JSON.parse(JSON.stringify(planView(reviewTab(params), none())))
  assert.equal(review.state, 'review', `a review preview reports state ${review.state}, not review`)
  assert.equal(review.document.markdown, MARKDOWN, 'the review preview does not read the markdown from tab navigation params')
  assert.equal(review.document.title, 'Draft plan', 'the review preview does not read the title from tab navigation params')
  const expired = JSON.parse(JSON.stringify(planView(reviewTab({}), none())))
  assert.equal(expired.state, 'expired', `a review preview without planReview reports state ${expired.state}, not expired`)
  const expiredView = await shown(reviewTab({}), none())
  const control = copyControl(expiredView.runtime.tree())
  assert.ok(control, 'the expired plan view draws no Copy control')
  assert.ok(!control.props.disabled, 'the Copy control is disabled in the expired state')
})

// a live plan reads the resource value and failed, unavailable and loading follow its status
test('R4 maps the live, failed, unavailable and loading states', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const { planView } = view.exports
  assert.equal(typeof planView, 'function', 'plan-view.js does not export planView')
  const livePlan = JSON.parse(JSON.stringify(planView(liveTab(), live())))
  assert.equal(livePlan.state, 'live', `a live read reports state ${livePlan.state}, not live`)
  assert.equal(livePlan.document.markdown, MARKDOWN, 'a live read does not use the resource value as the document')
  const failedPlan = JSON.parse(JSON.stringify(planView(liveTab(), failed())))
  assert.equal(failedPlan.state, 'failed', `a failed read reports state ${failedPlan.state}, not failed`)
  assert.equal(failedPlan.failure?.message, 'the plan history is gone', 'a failed read does not carry the resource failure')
  assert.equal(planView(liveTab(), none()).state, 'unavailable', 'a resource with status none is not unavailable')
  assert.equal(planView(liveTab(), loading()).state, 'loading', 'a pending read is not loading')
})

// clicking copy writes the whole plan markdown verbatim to the clipboard, ignoring any selection
test('R5 copies the whole plan markdown verbatim', async () => {
  const view = await shown(reviewTab(), none())
  await click(view)
  assert.deepEqual(view.writes, [MARKDOWN], 'the copy control does not write the whole plan markdown verbatim, selection ignored')
})

// a successful copy announces Copied for 1.2 seconds, a repeat click restarts it and unmount clears it
test('R6 announces Copied for 1.2 seconds and clears the timer on unmount', async () => {
  const settled = await shown(reviewTab(), none())
  await click(settled)
  assert.equal(text(copyControl(settled.runtime.tree())).trim(), 'Copied', 'a resolved write does not show Copied')
  assert.ok(find(settled.runtime.tree(), node => (node.props?.role === 'status' || node.props?.['aria-live'] !== undefined) && text(node).includes('Copied')),
    'the Copied state is not exposed in a live region')
  assert.deepEqual(settled.timers.pending.map(timer => timer.delay), [1200], 'Copied does not last 1200 ms')
  settled.timers.pending[0].fn()
  assert.equal(text(copyControl(settled.runtime.tree())).trim(), 'Copy', 'Copied does not return to Copy after 1200 ms')

  const repeated = await shown(reviewTab(), none())
  await click(repeated)
  await click(repeated)
  assert.deepEqual(repeated.timers.pending.map(timer => timer.delay), [1200], 'a repeat click does not restart the 1200 ms window')

  const leaving = await shown(reviewTab(), none())
  await click(leaving)
  leaving.runtime.unmount()
  assert.deepEqual(leaving.timers.pending, [], 'unmount does not clear the pending timer')
})

// a rejected or missing copy shows the failure text for 2 seconds and never shows Copied
test('R7 shows the failure text and never Copied when the copy fails', async () => {
  const denied = await shown(reviewTab(), none(), { clipboard: 'denied' })
  await click(denied)
  assert.ok(text(denied.runtime.tree()).includes('Could not copy the plan.'), 'a rejected write shows no failure text')
  assert.ok(!text(denied.runtime.tree()).includes('Copied'), 'a rejected write still shows Copied')
  assert.deepEqual(denied.timers.pending.map(timer => timer.delay), [2000], 'the failure text does not last 2000 ms')
  denied.timers.pending[0].fn()
  assert.ok(!text(denied.runtime.tree()).includes('Could not copy the plan.'), 'the failure text does not clear after 2000 ms')

  const missing = await shown(reviewTab(), none(), { clipboard: 'missing' })
  await click(missing)
  assert.ok(text(missing.runtime.tree()).includes('Could not copy the plan.'), 'a missing navigator.clipboard shows no failure text')
  assert.ok(!text(missing.runtime.tree()).includes('Copied'), 'a missing navigator.clipboard still shows Copied')

  const empty = await shown(reviewTab({}), none())
  await click(empty)
  assert.deepEqual(empty.writes, [], 'a click with no plan text wrote to the clipboard')
  assert.ok(text(empty.runtime.tree()).includes('Could not copy the plan.'), 'a click with no plan text shows no failure text')
})

// without plan text the body shows its state line and a failed read shows the failure message
test('R8 shows state lines and the resource failure message', async () => {
  const pending = await shown(liveTab(), loading())
  assert.ok(text(pending.runtime.tree()).includes('Loading the plan…'), 'a pending read shows no loading state line')
  const absent = await shown(liveTab(), none())
  assert.ok(text(absent.runtime.tree()).includes('This plan is not available.'), 'a status-none read shows no unavailable state line')
  const expired = await shown(reviewTab({}), none())
  assert.ok(text(expired.runtime.tree()).includes('This plan preview has expired.'), 'an expired preview shows no expired state line')
  const broken = await shown(liveTab(), failed())
  assert.ok(text(broken.runtime.tree()).includes('the plan history is gone'), 'a failed read does not show the resource failure message')
})

// the tab chip shows the plan title, else the title captured at open, else Plan
test('R9 falls back from the plan title to the captured title and Plan', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const { PlanTabTitle } = view.exports
  assert.equal(typeof PlanTabTitle, 'function', 'plan-view.js does not export PlanTabTitle')
  const titleOf = (tab, resource) => {
    view.runtime.reset()
    return text(view.runtime.mount(PlanTabTitle, { useTabInfo: () => ({ tab }), useResource: () => resource })).trim()
  }
  assert.equal(titleOf(reviewTab(), none()), 'Draft plan', 'the tab chip does not show the plan title')
  assert.equal(titleOf({ navigation: { address: 'dsh-resource://plan/session-1/call-1' }, title: 'Opened plan' }, { status: 'live', value: { callId: 'call-1', markdown: MARKDOWN } }), 'Opened plan', 'the tab chip does not fall back to the title captured at open')
  assert.equal(titleOf({ navigation: { address: 'dsh-resource://plan/session-1/call-1' } }, loading()), 'Plan', 'the tab chip does not fall back to Plan')
})

// the plan styles use only --bt tokens, the 8px radius step and no literal colors or springs
test('R10 keeps plan styles on existing tokens and the 8px radius', async () => {
  const view = await load()
  assert.ok(view, MISSING)
  const css = view.exports.PLAN_CSS
  assert.equal(typeof css, 'string', 'plan-view.js does not export PLAN_CSS')
  const styles = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(styles, /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i, 'PLAN_CSS uses a literal hex color')
  assert.doesNotMatch(styles, /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i, 'PLAN_CSS uses a literal color function')
  const tokens = new Set(['--bt-card', '--bt-line', '--bt-ink-2', '--bt-hover'])
  const used = [...styles.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1])
  assert.deepEqual(used.filter(name => !tokens.has(name)), [], 'PLAN_CSS reads a token outside --bt-card, --bt-line, --bt-ink-2 and --bt-hover')
  const corners = [...styles.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/gi)]
    .flatMap(match => match[1].trim().split(/\s+/))
    .filter(Boolean)
  assert.deepEqual(corners.filter(value => value !== '0' && value !== '8px'), [], 'PLAN_CSS uses a radius other than the 8px step')
  assert.doesNotMatch(styles, /@keyframes|\banimation\s*:|\btransition\s*:/i, 'PLAN_CSS adds motion')
  const scrollers = [...styles.matchAll(/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/gi)]
  assert.equal(scrollers.length, 1, `PLAN_CSS has ${scrollers.length} scrolling rules; the document must be the only scroller`)
})

// every new plan view string has a Chinese entry and Copy, Copied and Footnotes are reused
test('R11 adds the plan view strings to the Chinese dictionary', async () => {
  const dictionary = await dictionaryOf()
  assert.ok(dictionary, 'src/client/i18n.js is missing or cannot be built')
  const zh = JSON.parse(JSON.stringify(dictionary.zh ?? {}))
  const added = [
    'Plan',
    'Copy plan as Markdown',
    'Loading the plan…',
    'This plan is not available.',
    'The plan could not be loaded.',
    'This plan preview has expired.',
    'Could not copy the plan.',
  ]
  const missing = added.filter(key => typeof zh[key] !== 'string' || zh[key].trim() === '' || zh[key] === key)
  assert.deepEqual(missing, [], `the Chinese dictionary has no entry for: ${missing.join(', ')}`)
  assert.equal(zh.Copy, '复制', 'Copy is not reused from the existing dictionary')
  assert.equal(zh.Copied, '已复制', 'Copied is not reused from the existing dictionary')
  assert.equal(zh.Footnotes, '脚注', 'Footnotes is not reused from the existing dictionary')
})
