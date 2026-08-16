// 模拟完整启动：工厂求值 + apply(ctx) 执行，找出 apply 抛错位置
const fs = require('fs')
const vm = require('vm')

const src = fs.readFileSync('D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js', 'utf8')

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: 'Fragment',
}

const registered = []
const slotsStub = {
  inject: (key, fn) => {
    try {
      fn()
      console.log('slot inject ok:', key)
    } catch (e) {
      console.log('slot inject FAILED:', key, '->', e.message)
    }
    return () => {}
  },
  register: (def, comp) => {
    registered.push(def)
    return comp
  },
}

const styleStub = { remove() {} }
const documentStub = {
  createElement: () => ({ textContent: '', dataset: {}, append() {}, remove() {} }),
  head: { append() {} },
}

let factoryFn = null
const sandbox = {
  window: {
    __ModuleLoader__: { load(spec) { factoryFn = spec.factory } },
  },
  console,
  document: documentStub,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

const apply = factoryFn((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
}).apply

const ctx = {
  get: (name) => {
    if (name === 'slots') return slotsStub
    if (name === 'document') return documentStub
    return undefined
  },
  effect: (fn) => { try { return fn() } catch (e) { console.log('effect FAILED:', e.message); return () => {} } },
  on: () => () => {},
}

try {
  apply(ctx)
  console.log('APPLY OK')
  console.log('registered entries:', registered.map((r) => r.name + '/' + r.id).join(', '))
} catch (e) {
  console.error('APPLY THREW:', e.message)
  console.error(e.stack.split('\n').slice(0, 8).join('\n'))
  process.exit(1)
}
