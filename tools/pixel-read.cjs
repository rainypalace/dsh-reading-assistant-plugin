// 不用视觉模型的「读图」：像素级分析（颜色桶、主体包围盒、ASCII 字符画）
const sharp = require('C:/Users/wa/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp')

const SRC = 'D:/vibe projects/dsh_demo/放大镜大肥鱼 Q版（GPT2）.png'

function bucket(r, g, b) {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  if (mx >= 245) return 'B' // 白/浅底
  if (b >= 130 && b > r + 30 && b >= g - 10) return 'N' // 蓝（头发/裙/尾）
  if (r > 170 && g > 120 && b < 120 && r > b + 60) return 'G' // 金/棕（放大镜/纽扣）
  if (r > 200 && g > 150 && b > 130 && r > b + 40) return 'S' // 肤色
  if (r > 200 && g > 200 && b > 200) return 'W' // 白色（围裙/袜）
  if (mx - mn < 40 && mx < 120) return 'D' // 深色
  return '?'
}

async function main() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height, CH = 4
  // 背景阈值找主体包围盒
  let minX = w, minY = h, maxX = -1, maxY = -1
  const counts = {}
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * CH
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (Math.min(r, g, b) < 244) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        const k = bucket(r, g, b)
        counts[k] = (counts[k] || 0) + 1
      }
    }
  }
  console.log('subject bbox: x[' + minX + ',' + maxX + '] y[' + minY + ',' + maxY + '] size ' + (maxX - minX) + 'x' + (maxY - minY))
  const total = Object.values(counts).reduce((a, b2) => a + b2, 0)
  const pct = (k) => ((counts[k] || 0) * 100 / total).toFixed(1) + '%'
  console.log('N(蓝) ' + pct('N') + ' W(白) ' + pct('W') + ' S(肤) ' + pct('S') + ' G(金棕) ' + pct('G') + ' D(深) ' + pct('D') + ' ?(其他) ' + pct('?'))

  // 40 宽亮度字符画
  const CW = 46
  const CH2 = Math.round((h / w) * CW * 0.5)
  const chars = ' .:-=+*#%@'
  const out = []
  for (let row = 0; row < CH2; row++) {
    let line = ''
    for (let col = 0; col < CW; col++) {
      const x0 = Math.floor(col * w / CW), x1 = Math.floor((col + 1) * w / CW)
      const y0 = Math.floor(row * h / CH2), y1 = Math.floor((row + 1) * h / CH2)
      let sum = 0, n = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * CH
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        n++
      }
      const lum = sum / n
      line += chars[Math.min(chars.length - 1, Math.floor((255 - lum) / 256 * chars.length))]
    }
    out.push(line)
  }
  console.log('--- luminance ascii ---')
  console.log(out.join('\n'))

  // 30 宽颜色桶字符画
  const CW2 = 38
  const CH3 = Math.round((h / w) * CW2 * 0.5)
  const out2 = []
  for (let row = 0; row < CH3; row++) {
    let line = ''
    for (let col = 0; col < CW2; col++) {
      const x0 = Math.floor(col * w / CW2), x1 = Math.floor((col + 1) * w / CW2)
      const y0 = Math.floor(row * h / CH3), y1 = Math.floor((row + 1) * h / CH3)
      const cnt = {}
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * CH
        const k = bucket(data[i], data[i + 1], data[i + 2])
        cnt[k] = (cnt[k] || 0) + 1
      }
      let best = ' ', bn = 0
      for (const k in cnt) if (cnt[k] > bn && k !== 'B') { best = k; bn = cnt[k] }
      line += best
    }
    out2.push(line)
  }
  console.log('--- color ascii (N蓝 W白 S肤 G金 D深 .=白底) ---')
  console.log(out2.join('\n'))
}
main().catch((e) => { console.error(e); process.exit(1) })
