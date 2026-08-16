/** 第二张立绘（放大镜版）处理：白底 → 透明，缩至 360px，输出 WebP + base64。 */
const fs = require('fs')
const sharp = require('C:/Users/wa/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')

const SRC = 'D:/vibe projects/dsh_demo/放大镜大肥鱼 Q版（GPT2）.png'
const OUT_DIR = 'D:/vibe projects/dsh_demo/reading-mode-pkg/assets'
const OUT_WEBP = OUT_DIR + '/avatar2.webp'
const OUT_B64 = OUT_DIR + '/avatar2.base64.txt'

async function main() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const CH = 4
  const px = Buffer.from(data)
  const minRGB = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) minRGB[p] = Math.min(px[p * CH], px[p * CH + 1], px[p * CH + 2])

  const border = []
  for (let x = 0; x < w; x++) { border.push(minRGB[x]); border.push(minRGB[(h - 1) * w + x]) }
  for (let y = 0; y < h; y++) { border.push(minRGB[y * w]); border.push(minRGB[y * w + w - 1]) }
  border.sort((a, b) => a - b)
  const med = border[border.length >> 1]
  console.log('border minRGB: min=' + border[0] + ' med=' + med + ' max=' + border[border.length - 1])

  const TH = Math.max(230, med - 8)
  const visited = new Uint8Array(w * h)
  const queue = []
  const seed = (x, y) => {
    const p = y * w + x
    if (!visited[p] && minRGB[p] >= TH) { visited[p] = 1; queue.push(x, y) }
  }
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1) }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y) }
  let qi = 0
  while (qi < queue.length) {
    const x = queue[qi++]
    const y = queue[qi++]
    if (x + 1 < w) seed(x + 1, y)
    if (x - 1 >= 0) seed(x - 1, y)
    if (y + 1 < h) seed(x, y + 1)
    if (y - 1 >= 0) seed(x, y - 1)
  }

  let bgCount = 0
  for (let p = 0; p < w * h; p++) {
    if (!visited[p]) continue
    bgCount++
    const x = p % w
    const y = (p / w) | 0
    let touchesFg = false
    if (x > 0 && !visited[p - 1]) touchesFg = true
    else if (x < w - 1 && !visited[p + 1]) touchesFg = true
    else if (y > 0 && !visited[p - w]) touchesFg = true
    else if (y < h - 1 && !visited[p + w]) touchesFg = true
    if (!touchesFg) { px[p * CH + 3] = 0; continue }
    const i = p * CH
    const m = minRGB[p]
    if (m >= 254) { px[i + 3] = 0; continue }
    const af = (255 - m) / 255
    const a = 255 - m
    for (let c = 0; c < 3; c++) {
      const C = px[i + c]
      px[i + c] = Math.max(0, Math.min(255, Math.round((C - 255 * (1 - af)) / af)))
    }
    px[i + 3] = a
  }
  console.log('bg pixels: ' + bgCount + ' (' + (100 * bgCount / (w * h)).toFixed(1) + '%)')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const webp = await sharp(px, { raw: { width: w, height: h, channels: CH } })
    .resize(360, 360, { fit: 'inside', kernel: 'lanczos3' })
    .webp({ quality: 92, alphaQuality: 100 })
    .toBuffer()
  fs.writeFileSync(OUT_WEBP, webp)
  fs.writeFileSync(OUT_B64, webp.toString('base64'))
  console.log('webp bytes: ' + webp.length + ', base64 chars: ' + webp.toString('base64').length)
  const meta = await sharp(OUT_WEBP).metadata()
  console.log('webp meta: ' + meta.width + 'x' + meta.height + ' format=' + meta.format + ' hasAlpha=' + meta.hasAlpha)
}
main().catch((e) => { console.error(e); process.exit(1) })
