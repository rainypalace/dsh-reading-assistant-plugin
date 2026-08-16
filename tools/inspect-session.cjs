const zlib = require('node:zlib')
const fs = require('fs')
const path = 'C:/Users/wa/.dsh/sessions/--D-vibe~0020projects-dsh_demo--/session-a1de20fa-e887-4c29-8ad5-36f7b9efaeca/session.jsonl.zstd'
const buf = fs.readFileSync(path)
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const starts = []
let idx = 0
while (true) {
  const i = buf.indexOf(MAGIC, idx)
  if (i === -1) break
  starts.push(i)
  idx = i + 4
}
const events = []
for (const s of starts) {
  try {
    const text = zlib.zstdDecompressSync(buf.subarray(s)).toString('utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try { events.push(JSON.parse(t)) } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip frame */ }
}
// 打印所有 user/message（完整），重点看 reading-mode 来源
for (const ev of events) {
  if (ev.type !== 'user/message') continue
  const d = ev.data || {}
  const src = d.source
  const isRm = src && src.plugin === 'reading-mode'
  console.log('=== user/message seq=' + ev.seq + (isRm ? ' [READING-MODE]' : '') + ' source=' + JSON.stringify(src))
  const content = d.content || []
  for (const b of content) {
    if (b.type === 'text') console.log('    text: ' + String(b.text).slice(0, 300).replace(/\n/g, '\\n'))
    else if (b.type === 'image') console.log('    image block: attachment=' + JSON.stringify(b.attachment).slice(0, 300))
    else console.log('    other block: ' + JSON.stringify(b).slice(0, 200))
  }
}
