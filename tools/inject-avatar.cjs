const fs = require('fs')
const clientPath = 'D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js'
const b64Path = 'D:/vibe projects/dsh_demo/reading-mode-pkg/assets/avatar.base64.txt'
const client = fs.readFileSync(clientPath, 'utf8')
const b64 = fs.readFileSync(b64Path, 'utf8').trim()
if (client.indexOf('__AVATAR_B64__') < 0) {
  console.error('placeholder not found in client.js')
  process.exit(1)
}
const out = client.replace('__AVATAR_B64__', b64)
fs.writeFileSync(clientPath, out)
console.log('injected base64 chars:', b64.length)
console.log('client.js new size:', fs.statSync(clientPath).size)
