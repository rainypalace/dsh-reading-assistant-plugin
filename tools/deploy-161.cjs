// 部署 v1.6.1：package.json + 双端代码 + pdfjs 资源（工作区 → 已安装目录）
const fs = require('fs')
const path = require('path')

const workspace = 'D:/vibe projects/dsh_demo/reading-mode-pkg'
const installed = 'C:/Users/wa/.dsh/profiles/web/.packages/reading-mode'

const content = JSON.stringify({
  name: 'dsh-reading-mode',
  version: '1.6.1',
  private: true,
  description: '读书模式：PDF/Markdown 阅读器 + 助手立绘 + 截图提问（视觉模型识别，主模型解答）',
  type: 'module',
  main: 'lib/index.js',
  exports: {
    '.': { default: './lib/index.js' },
    './client': './lib/client.js',
    './package.json': './package.json',
  },
  dsh: {
    client: { platform: 'web', inject: [] },
  },
}, null, 2) + '\n'

for (const p of [path.join(workspace, 'package.json'), path.join(installed, 'package.json')]) {
  fs.writeFileSync(p, content, 'utf8')
  console.log('OK:', p, '->', JSON.parse(fs.readFileSync(p, 'utf8')).version)
}

for (const rel of ['lib/client.js', 'lib/index.js']) {
  fs.copyFileSync(path.join(workspace, rel), path.join(installed, rel))
  console.log('copied', rel)
}

// pdfjs 资源
const srcAssets = path.join(workspace, 'assets', 'pdfjs')
const dstAssets = path.join(installed, 'assets', 'pdfjs')
fs.rmSync(dstAssets, { recursive: true, force: true })
fs.cpSync(srcAssets, dstAssets, { recursive: true })
let total = 0
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else total += fs.statSync(p).size
  }
}
walk(dstAssets)
console.log('pdfjs assets deployed:', (total / 1024 / 1024).toFixed(1), 'MB')
