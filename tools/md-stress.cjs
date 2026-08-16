// 渲染器压力测试：长文本、表格、嵌套强调等是否出现超线性耗时
const fs = require('fs')
const src = fs.readFileSync('D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js', 'utf8')

function extract(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start === -1) throw new Error(name + ' not found')
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
const getMd = new Function(
  [extract('escapeHtml'), extract('inlineMd'), extract('splitTableRow'), extract('isTableSeparator'), extract('mdToHtml')].join('\n') + '\nreturn mdToHtml'
)
const md = getMd()

function bench(name, text, n) {
  const t0 = process.hrtime.bigint()
  let out = ''
  for (let i = 0; i < n; i++) out = md(text)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(name + ': ' + ms.toFixed(1) + 'ms / ' + n + ' runs (' + (ms / n).toFixed(2) + 'ms each), output len ' + out.length)
}

// 大表格（30 行 × 5 列）
const bigTable = '| ' + Array.from({ length: 5 }, (_, i) => '列' + i).join(' | ') + ' |\n' +
  '| --- | :---: | ---: | --- | :---: |\n' +
  Array.from({ length: 30 }, (_, r) => '| ' + Array.from({ length: 5 }, (_, c) => '内容' + r + '-' + c).join(' | ') + ' |').join('\n')
bench('30行表格', bigTable, 50)

// 长段落（30KB 文本 + 强调符号）
let long = ''
for (let i = 0; i < 400; i++) long += '第' + i + '段：**加粗**与*斜体*以及`代码a*b`混合内容，附链接[示例](https://example.com/x)。\n'
bench('30KB 长文本', long, 20)

// 表格 + 长文本混合（模拟流式 partial）
bench('表格+长文本混合', bigTable + '\n\n' + long, 20)

// 病理：不闭合的强调符号
let adversarial = ''
for (let i = 0; i < 500; i++) adversarial += '**加粗' + i + ' 未闭合 *斜体 x y z ~~删除\n'
bench('未闭合强调符号', adversarial, 20)

// 表格分隔行缺失（半截表格）
const halfTable = Array.from({ length: 40 }, (_, r) => '| a' + r + ' | b' + r + ' |').join('\n')
bench('无分隔行的表格行', halfTable, 50)
