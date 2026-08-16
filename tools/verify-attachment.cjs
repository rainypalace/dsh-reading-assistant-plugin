const fs = require('fs')
const crypto = require('crypto')
const sharp = require('C:/Users/wa/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')

const path = 'C:/Users/wa/.dsh/attachments/v1/objects/cb/cbce2e646a132d10fb8a78b419cbcb7852fd9691be23868394c5c40682c77f41'
const ref = {
  attachmentId: 'sha256:cbce2e646a132d10fb8a78b419cbcb7852fd9691be23868394c5c40682c77f41',
  mediaType: 'image/png',
  bytes: 44693,
  width: 221,
  height: 169,
}

async function main() {
  const data = fs.readFileSync(path)
  const digest = crypto.createHash('sha256').update(data).digest('hex')
  console.log('digest match:', digest === ref.attachmentId.slice(7))
  console.log('bytes match:', data.length === ref.bytes, '(actual ' + data.length + ')')
  const meta = await sharp(data).metadata()
  console.log('meta:', meta.format, meta.width + 'x' + meta.height, 'expect png ' + ref.width + 'x' + ref.height)
  const ok = digest === ref.attachmentId.slice(7) && data.length === ref.bytes &&
    meta.format === 'png' && meta.width === ref.width && meta.height === ref.height
  console.log(ok ? 'VERIFY OK — /image/ route will succeed after restart' : 'VERIFY FAIL')
}
main().catch((e) => { console.error(e); process.exit(1) })
