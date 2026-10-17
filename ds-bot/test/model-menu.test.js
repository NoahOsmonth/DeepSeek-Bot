import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The client runs on React; the tests need a render that keeps hook state, runs the
// effects, and can be called again like React does after a state change.
let current = null
const fakeNode = {
  focus() {},
  contains: () => false,
  getBoundingClientRect: () => ({ left: 0, right: 120, top: 100, bottom: 132, width: 120, height: 32 }),
}
const react = {
  createElement: (type, props, ...children) => {
    if (props?.ref && typeof props.ref === 'object') props.ref.current = fakeNode
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState: (initial) => {
    const at = current.slot++
    if (!(at in current.slots)) current.slots[at] = typeof initial === 'function' ? initial() : initial
    return [current.slots[at], (next) => { current.slots[at] = typeof next === 'function' ? next(current.slots[at]) : next }]
  },
  useEffect: (run) => { current.slot++; current.effects.push(run) },
  useLayoutEffect: () => {},
  useRef: (initial) => {
    const at = current.slot++
    if (!(at in current.slots)) current.slots[at] = { current: initial }
    return current.slots[at]
  },
  useCallback: fn => fn,
  useMemo: make => make(),
  Fragment: 'fragment',
}
function render(draw) {
  const view = { slots: [], effects: [], slot: 0 }
  current = view
  const pass = () => {
    current.slot = 0
    current.effects = []
    const tree = draw()
    const effects = current.effects
    current.effects = []
    for (const run of effects) run()
    return tree
  }
  view.tree = pass()
  view.rerender = () => { view.tree = pass(); return view.tree }
  return view
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  window: {
    innerWidth: 1200, innerHeight: 800,
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {},
  },
  document: { body: {} },
  // The closing animations of a menu are not part of these tests.
  setTimeout: () => 0,
  clearTimeout() {},
  require: (name) => {
    const platform = {
      react,
      'react-dom': { createPortal: tree => tree },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { groupModels, ModelChoiceDock, effortRows, thinkingOf, ThinkingRow } = module.exports

// Renders the named components of an element tree, leaving the rest as elements.
const expand = (tree, names) => {
  if (Array.isArray(tree)) return tree.flatMap(child => expand(child, names))
  if (tree === null || typeof tree !== 'object') return tree
  if (names.includes(tree.type?.name)) return expand(tree.type(tree.props), names)
  return { ...tree, children: tree.children.map(child => expand(child, names)) }
}

function nodes(tree, match) {
  if (tree === null || typeof tree !== 'object') return []
  const children = Array.isArray(tree) ? tree : (tree.children ?? [])
  return [...(Array.isArray(tree) ? [] : match(tree) ? [tree] : []), ...children.flatMap(child => nodes(child, match))]
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// `harness`: the window has DSH's own settings to send the user to, as the plugin does.
function dock(models, { model, ready = true, harness = true } = {}) {
  const picked = []
  const bot = { id: 'chief', name: 'Chief', model }
  const roster = { ready, byId: { chief: bot }, models, defaultModel: models[0]?.ref }
  const view = render(() => ModelChoiceDock({
    sessionId: bot.id, useRoster: select => select(roster),
    actions: {
      updateBot: (id, patch) => { picked.push([id, patch.model]); return Promise.resolve() },
      ...(harness ? { openHarnessSettings: () => {}, openHarnessOnboarding: () => {} } : {}),
    },
  }))
  return { tree: view.tree, picked }
}

const models = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
]

test('the first model choice shows provider groups and keeps each model route', () => {
  const { tree, picked } = dock(models)
  const groups = nodes(tree, node => node.props.className === 'bt-model-choice-group')
  assert.deepEqual(groups.map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.deepEqual(groups.map(group => nodes(group, node => node.props.className === 'bt-model-choice-provider')[0].children[0]), ['DeepSeek', 'Ollama'])
  const buttons = groups.map(group => nodes(group, node => node.type === 'button'))
  assert.deepEqual(buttons.map(list => list.map(button => button.children[0])), [['DeepSeek Flash', 'DeepSeek Pro'], ['DeepSeek Flash']])
  assert.match(buttons[0][0].props.title, /official\/flash.*Harness default/)
  buttons[1][0].props.onClick()
  buttons[0][0].props.onClick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'official/flash']])
  assert.equal(nodes(tree, node => node.type === 'button' && node.children.includes('Manage models')).length, 1)
})

test('providers with the same display name stay distinct, and unnamed providers use their id', () => {
  const entries = [
    { ...models[0], providerName: 'Cloud' },
    { ...models[1], providerName: 'Cloud' },
    { ref: 'custom/flash', provider: 'custom', name: 'Flash' },
  ]
  const groups = groupModels(entries)
  assert.deepEqual(Array.from(groups, ([label, list]) => [label, Array.from(list, model => model.ref)]), [
    ['Cloud (official)', ['official/flash']],
    ['Cloud (local)', ['local/flash']],
    ['custom', ['custom/flash']],
  ])
})

test('an unavailable model offers the same provider groups', () => {
  const { tree } = dock(models, { model: 'gone/flash' })
  assert.deepEqual(nodes(tree, node => node.props.className === 'bt-model-choice-group').map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.ok(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0].includes('not available anymore'))
})

test('an empty catalog offers setup choices, and a ready model needs no choice dock', () => {
  const { tree } = dock([])
  assert.deepEqual(nodes(tree, node => node.type === 'button').map(button => button.children[0]), [
    'Enter a DeepSeek API key', 'Open settings to set up a custom model',
  ])
  assert.equal(dock(models, { model: models[0].ref }).tree, null)
  assert.equal(dock(models, { ready: false }).tree, null)
})

test('without DSH\'s own settings, the choice offers no way into them', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock(models, { harness: false }).tree), ['DeepSeek Flash', 'DeepSeek Pro', 'DeepSeek Flash'])
  assert.deepEqual(buttons(dock([], { harness: false }).tree), [])
})

test('the Thinking section always offers Default, so a picked level can be cleared', () => {
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  assert.deepEqual([...effortRows({ efforts, defaultEffort: 'high' }).map(row => row.effort)], [undefined, 'low', 'high'])
  assert.deepEqual([...effortRows({ efforts }).map(row => row.effort)], [undefined, 'low', 'high'])
  assert.equal(effortRows({ efforts: [] }).length, 0)
})

const levels = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }

test('a model the catalog serves gives its levels without asking the host', () => {
  const asked = []
  const reasoning = render(() => thinkingOf({ reasoning: levels }, 'p/m', { efforts: ref => { asked.push(ref); return Promise.resolve(levels) } })).tree
  assert.equal(reasoning, levels)
  assert.deepEqual(asked, [])
})

test('a model the catalog does not carry asks the host once and keeps the answer', async () => {
  const asked = []
  const actions = { efforts: ref => { asked.push(ref); return Promise.resolve({ efforts: [{ id: 'off', name: 'Off' }] }) } }
  const view = render(() => thinkingOf(undefined, 'p/other', actions))
  assert.equal(view.tree, undefined)
  await tick()
  assert.deepEqual(view.rerender(), { efforts: [{ id: 'off', name: 'Off' }] })
  assert.deepEqual(asked, ['p/other'])
})

test('a Bot without a model, and a host that fails or has no levels, give no levels', async () => {
  const none = render(() => thinkingOf(undefined, undefined, { efforts: () => { throw new Error('asked without a model') } }))
  assert.equal(none.tree, undefined)
  const failing = { asked: 0, efforts() { failing.asked += 1; return Promise.reject(new Error('no provider')) } }
  const failed = render(() => thinkingOf(undefined, 'p/gone', failing))
  assert.equal(failed.tree, undefined)
  await tick()
  assert.equal(failed.rerender(), undefined)
  assert.ok(failing.asked >= 1)
  const empty = render(() => thinkingOf(undefined, 'p/plain', { efforts: () => Promise.resolve({ efforts: [] }) }))
  assert.equal(empty.tree, undefined)
  await tick()
  assert.deepEqual(empty.rerender(), { efforts: [] })
})

const rosterWith = reasoning => ({
  models: [{ ref: 'p/m', provider: 'p', providerName: 'Cloud', name: 'Model', reasoning }],
  byId: {}, defaultModel: 'p/m',
})

function settingsRow({ effort, reasoning = levels, updates = [] } = {}) {
  const bot = { id: 'chief', name: 'Chief', model: 'p/m', effort }
  const roster = rosterWith(reasoning)
  const actions = {
    updateBot: (id, patch) => { updates.push([id, patch]); return Promise.resolve() },
    refreshModels: () => Promise.resolve(),
  }
  const view = render(() => ThinkingRow({ bot, roster, actions, run: promise => promise }))
  return { view, updates, bot }
}

// The buttons of the open Thinking menu, with the list component rendered out.
const menuButtons = tree => nodes(expand(nodes(tree, node => node.props.role === 'menu')[0], ['EffortItems']), node => node.type === 'button')
const labelOf = button => nodes(button, node => node.props.className === 'bt-menu-label')[0].children[0]

test('the settings row shows the model default while the Bot has no pick', () => {
  const { view } = settingsRow()
  assert.equal(nodes(view.tree, node => node.props.className === 'bt-bs-label')[0].children[0], 'Thinking level')
  assert.equal(nodes(view.tree, node => node.props.className === 'bt-set-hint')[0].children[0], 'Set by the model.')
  const trigger = nodes(view.tree, node => node.props.className === 'bt-model-trigger')[0]
  assert.equal(nodes(trigger, node => node.props.className === 'bt-model-name')[0].children[0], 'Low')
  assert.equal(trigger.props['aria-label'], 'Default: Low')
})

test('the settings row shows the Bot\'s pick and marks it in the list', () => {
  const { view } = settingsRow({ effort: 'high' })
  const trigger = nodes(view.tree, node => node.props.className === 'bt-model-trigger')[0]
  assert.equal(nodes(trigger, node => node.props.className === 'bt-model-name')[0].children[0], 'High')
  assert.equal(trigger.props['aria-label'], 'Thinking level: High')
  assert.equal(nodes(view.tree, node => node.props.className === 'bt-set-hint').length, 0)
  trigger.props.onClick()
  const buttons = menuButtons(view.rerender())
  assert.deepEqual(buttons.map(labelOf), ['Default', 'Low', 'High'])
  assert.deepEqual(buttons.map(button => button.props['aria-checked']), [false, false, true])
})

test('picking a level saves it on the Bot, and Default clears the pick', () => {
  const { view, updates } = settingsRow({ effort: 'high' })
  nodes(view.tree, node => node.props.className === 'bt-model-trigger')[0].props.onClick()
  menuButtons(view.rerender()).find(button => labelOf(button) === 'Low').props.onClick()
  assert.deepEqual(updates.map(([id, patch]) => [id, patch.effort]), [['chief', 'low']])
  nodes(view.tree, node => node.props.className === 'bt-model-trigger')[0].props.onClick()
  menuButtons(view.rerender()).find(button => labelOf(button) === 'Default').props.onClick()
  assert.deepEqual(updates.map(([id, patch]) => [id, patch.effort]), [['chief', 'low'], ['chief', null]])
})

test('a model with no levels renders no row', () => {
  assert.equal(settingsRow({ reasoning: { efforts: [] } }).view.tree, null)
})

test('a model whose levels cannot be read renders no row', async () => {
  const bot = { id: 'chief', name: 'Chief', model: 'p/unreadable' }
  const roster = { models: [{ ref: 'p/unreadable', provider: 'p', providerName: 'Cloud', name: 'Model' }], byId: {}, defaultModel: 'p/unreadable' }
  const actions = { efforts: () => Promise.reject(new Error('no provider')), updateBot: () => Promise.resolve() }
  const view = render(() => ThinkingRow({ bot, roster, actions, run: promise => promise }))
  assert.equal(view.tree, null)
  await tick()
  assert.equal(view.rerender(), null)
})

test('a Bot without a model has no Thinking level row', () => {
  const bot = { id: 'chief', name: 'Chief' }
  const view = render(() => ThinkingRow({ bot, roster: rosterWith(levels), actions: { updateBot: () => Promise.resolve() }, run: promise => promise }))
  assert.equal(view.tree, null)
})
