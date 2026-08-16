const fs = require('fs')

async function main() {
  const apiKey = process.env.QIANWENAI_API_KEY
  if (!apiKey) { console.error('QIANWENAI_API_KEY not set'); process.exit(1) }
  const img = fs.readFileSync('D:/vibe projects/dsh_demo/放大镜大肥鱼 Q版（GPT2）.png')
  const b64 = img.toString('base64')
  const body = {
    model: 'qwen3-vl-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '请客观详细地描述这张图片：1.主体的物种、颜色、姿态、服装/配饰、动作；2.手持或周围的道具（如放大镜）的位置与朝向；3.主体在画面中的位置与占比；4.背景情况；5.整体风格。只做客观描述。' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      },
    ],
    max_tokens: 1000,
  }
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text())
    process.exit(1)
  }
  const json = await res.json()
  console.log(json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : JSON.stringify(json).slice(0, 800))
}
main().catch((e) => { console.error(e); process.exit(1) })
