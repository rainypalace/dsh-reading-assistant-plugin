// 用 Node 修复并升级 package.json（工作区 + 已安装两份，UTF-8 无 BOM）
const fs = require('fs')
const content = JSON.stringify({
  name: 'dsh-reading-mode',
  version: '1.7.6',
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
for (const p of [
  'D:/vibe projects/dsh_demo/reading-mode-pkg/package.json',
  'C:/Users/wa/.dsh/profiles/web/.packages/reading-mode/package.json',
]) {
  fs.writeFileSync(p, content, 'utf8')
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
  console.log('OK:', p, '->', parsed.version)
}
// 部署 client.js
fs.copyFileSync('D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js', 'C:/Users/wa/.dsh/profiles/web/.packages/reading-mode/lib/client.js')
console.log('client.js deployed')
