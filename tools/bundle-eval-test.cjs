// 模拟浏览器模块加载环境，验证 client bundle 工厂函数能否通过求值
const fs = require('fs')
const vm = require('vm')

const src = fs.readFileSync('D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js', 'utf8')

let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) { captured = spec },
    },
  },
  React: {}, // 工厂内的 require('react') 由下面 require 提供
  console,
}
// 工厂里 require('react') 返回空对象即可（求值阶段不调用其方法）
const requireStub = (name) => {
  if (name === 'react') return {}
  throw new Error('unexpected require: ' + name)
}
sandbox.window.require = requireStub

try {
  vm.createContext(sandbox)
  vm.runInContext('var __fn = undefined;', sandbox)
  // bundle 顶层执行 window.__ModuleLoader__.load(...)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  console.log('bundle eval OK')
  console.log('factory captured:', typeof captured, captured && typeof captured.factory)
} catch (e) {
  console.error('BUNDLE EVAL FAILED:', e.message)
  console.error(e.stack && e.stack.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
}
