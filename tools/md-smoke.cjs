// 冒烟测试：从 client.js 中抽取 mdToHtml/inlineMd/escapeHtml 相关代码验证表格渲染
const fs = require('fs')
const src = fs.readFileSync('D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js', 'utf8')

// 提取函数源码（截取 escapeHtml 到 mdToHtml 结束）
function extract(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start === -1) throw new Error(name + ' not found')
  // 找函数体结束：用大括号配对
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(start, i + 1)
}

const escapeHtml = extract('escapeHtml')
const inlineMd = extract('inlineMd')
const splitTableRow = extract('splitTableRow')
const isTableSeparator = extract('isTableSeparator')
const mdToHtml = extract('mdToHtml')

// 全部函数拼进同一作用域，返回 mdToHtml
const getMd = new Function(
  [escapeHtml, inlineMd, splitTableRow, isTableSeparator, mdToHtml].join('\n') + '\nreturn mdToHtml'
)
const mdToHtmlFn = getMd()

const cases = [
  [
    '表格',
    '| 指标 | GDP | GNP |\n| --- | :---: | ---: |\n| 口径 | 地域 | 国民 |\n| 差值 | 小 | 小 |',
  ],
  ['行内代码含星号', '计算结果为 `a*b*c`，**加粗** 与 *斜体* 并存。'],
  ['普通段落', '这是普通文本。'],
]
for (const [name, input] of cases) {
  console.log('=== ' + name + ' ===')
  console.log(mdToHtmlFn(input))
  console.log('')
}
