/**
 * 读书模式（持久插件）Host 端。
 * 纯 ESM：能力来自注入服务、Node 内建全局，以及唯一的外部依赖
 * @deepseek-ai/schemastery（仅用于构建设置命名空间的 schema；
 * 已验证可从 profiles/node_modules 解析）。
 * - webServer 路由：PDF 直传上传 / base64 回退上传 / 文档读取(Range) / 提问(视觉管线) / 设置读写
 * - 提问链路：attachments.saveImage 持久化截图 → llm 视觉模型识别 → agents 收件箱注入纯文本
 * - 设置：ctx.settings 注册 'reading-mode' 命名空间 → settings.yaml 持久化、热加载
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default {
  name: 'reading-mode',
  inject: ['webServer', 'attachments', 'agents', 'llm', 'settings'],
  apply(ctx) {
    const { webServer, attachments, agents, llm, settings } = ctx

    // pdf.js 静态资源目录（自渲染阅读器）
    const pdfjsDir = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'pdfjs'))

    // ---------- 设置命名空间（settings.yaml 持久化，live 热生效） ----------
    const settingsScope = settings.register('reading-mode', z.object({
      avatarSize: z.number().min(60).max(240).default(116),
      panelWidth: z.number().min(280).max(560).default(380),
      showAvatarHint: z.boolean().default(true),
      recognitionOpen: z.boolean().default(false),
      chatFontSize: z.number().min(11).max(20).default(13),
      pdfRenderer: z.union([z.const('edge'), z.const('pdfjs')]).default('edge'),
    }), { applies: 'live' })

    let msgSeq = 0
    const newId = () =>
      'rm-' + Date.now().toString(36) + '-' + (++msgSeq).toString(36) + '-' + Math.random().toString(36).slice(2, 10)

    const errOf = (e) => (e && e.message) ? String(e.message) : String(e)

    const sendJson = (res, status, obj) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    }

    // 读取请求体为 Buffer（限长）
    const readBody = (req, maxBytes) =>
      new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            reject(new Error('请求体过大'))
            try { req.destroy() } catch (e) { /* ignore */ }
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })

    // ---------- 视觉管线 ----------
    // 发现一个支持图片输入的视觉模型路由（inputModalities 含 'image'）
    const findVisionRoute = async () => {
      const providers = llm.listProviders()
      for (const p of providers) {
        try {
          const models = await llm.listModels(p.id)
          for (const m of models) {
            if (m && m.inputModalities && m.inputModalities.indexOf('image') >= 0) {
              return { provider: p.id, model: m.id }
            }
          }
        } catch (e) { /* 跳过无法枚举的 provider */ }
      }
      return null
    }

    // 视觉识别：截图 → 视觉模型 → 文字描述
    const describeImage = async (route, ref) => {
      const visionMsg = {
        id: newId(),
        role: 'user',
        content: [
          { type: 'text', text: '请详细识别这张截图的内容：完整转录其中的文字、公式、数字与符号，描述图表、表格和结构。只做客观识别，不要解答任何问题。' },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'plugin', plugin: 'reading-mode' },
      }
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [visionMsg],
        system: '你是一个教材截图识别助手，输出客观、完整、结构化的识别结果。',
        maxTokens: 2048,
      })
      let desc = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') desc += chunk.text
        else if (chunk.type === 'finish') {
          const kind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : String(chunk.reason)
          if (kind === 'error' || kind === 'aborted') {
            throw new Error('视觉识别失败：' + kind)
          }
        }
      }
      desc = desc.trim()
      if (desc === '') throw new Error('视觉识别返回为空')
      if (desc.length > 6000) desc = desc.slice(0, 6000) + '…（识别结果已截断）'
      return desc
    }

    // 提问核心：文本（+可选截图）→ 视觉识别 → 纯文本注入主模型收件箱
    const handleAsk = async (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
      const text = typeof args.text === 'string' ? args.text : ''
      const agent = agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: '没有活动的会话：请先在左侧打开或新建一个会话，再向助手提问。' }
      if (text.trim() === '') return { ok: false, error: '问题不能为空' }

      let finalText = text
      let savedImageRef = null
      if (args.image !== null && args.image !== undefined && typeof args.image === 'object') {
        const mediaType = typeof args.image.mediaType === 'string' && args.image.mediaType !== ''
          ? args.image.mediaType
          : (typeof args.image.type === 'string' ? args.image.type : '')
        const base64 = typeof args.image.base64 === 'string' ? args.image.base64 : ''
        const formatOk = mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif'
        if (!formatOk || base64.length === 0) {
          return { ok: false, error: '不支持的截图格式：' + (mediaType === '' ? '未知类型' : mediaType) + '（支持 PNG / JPEG / WebP / GIF）' }
        }
        try {
          const ref = await attachments.saveImage({
            data: Buffer.from(base64, 'base64'),
            mediaType,
            name: typeof args.image.name === 'string' ? args.image.name : 'screenshot',
          })
          // 截图引用随消息 source 落盘（source 只进日志、不进模型上下文），
          // 客户端据此在对话历史里渲染该问题的截图缩略图
          savedImageRef = ref
          // 主模型不支持视觉 → 先找视觉模型识别截图
          const route = await findVisionRoute()
          if (route !== null) {
            try {
              const desc = await describeImage(route, ref)
              finalText = text + '\n\n【用户截图识别结果（视觉模型：' + route.provider + '/' + route.model + ' 生成）】\n' + desc + '\n\n请仅依据以上识别结果回答用户的问题。'
            } catch (e) {
              finalText = text + '\n\n（用户附带了一张截图，但视觉识别失败：' + errOf(e) + '。请仅根据文字提问作答，并提示用户可以改用文字描述截图内容。）'
            }
          } else {
            finalText = text + '\n\n（用户附带了一张截图，但当前部署没有配置支持视觉的模型，无法识别截图内容。请仅根据文字提问作答，并提示用户可以改用文字描述截图内容。）'
          }
        } catch (e) {
          return { ok: false, error: '截图保存失败：' + errOf(e) }
        }
      }

      const source = { kind: 'plugin', plugin: 'reading-mode' }
      if (savedImageRef !== null) source.image = savedImageRef
      // 提问时的阅读页码（pdfjs 高级模式由客户端上报）：只进日志不进模型上下文
      if (Number.isSafeInteger(args.page) && args.page >= 1) source.page = args.page
      const message = { id: newId(), role: 'user', content: [{ type: 'text', text: finalText }], source }
      try {
        agent.followup(message)
      } catch (e) {
        return { ok: false, error: '发送失败：' + errOf(e) }
      }
      return { ok: true }
    }

    // ---------- 文档存储与路由 ----------
    const docs = new Map() // id -> { buf: Buffer, mediaType, name }
    let docSeq = 0

    const unroute = webServer.register({
      kind: 'prefix',
      path: '/__dsr_doc__',
      handler: async (req, res) => {
        const raw = String(req.url || '')
        const path = raw.split('?')[0]
        try {
          // ---- 上传端点：XHR 直传原始字节（快），?name= 携带文件名 ----
          if (path === '/__dsr_doc__/upload') {
            res.setHeader('Access-Control-Allow-Origin', '*')
            if ((req.method || '').toUpperCase() === 'OPTIONS') {
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
              res.setHeader('Access-Control-Allow-Headers', 'content-type')
              res.statusCode = 204
              res.end()
              return
            }
            if ((req.method || '').toUpperCase() !== 'POST') {
              res.statusCode = 405
              res.end('method not allowed')
              return
            }
            const qi = raw.indexOf('?')
            const q = qi >= 0 ? raw.slice(qi + 1) : ''
            let name = 'document.pdf'
            const nm = /(?:^|&)name=([^&]*)/.exec(q)
            if (nm) {
              try { name = decodeURIComponent(nm[1]) } catch (e) { name = 'document.pdf' }
            }
            const lenHeader = req.headers && req.headers['content-length'] ? parseInt(String(req.headers['content-length']), 10) : 0
            if (!Number.isSafeInteger(lenHeader) || lenHeader <= 0 || lenHeader > 64 * 1024 * 1024) {
              sendJson(res, 413, { ok: false, error: '文档大小无效或超过 64MB 上限' })
              return
            }
            let buf
            try {
              buf = await readBody(req, 64 * 1024 * 1024)
            } catch (e) {
              sendJson(res, 413, { ok: false, error: '文档超过 64MB 上限' })
              return
            }
            const id = 'd' + (++docSeq) + '-' + Date.now().toString(36)
            docs.set(id, { buf, mediaType: 'application/pdf', name })
            if (docs.size > 12) {
              const oldest = docs.keys().next().value
              docs.delete(oldest)
            }
            sendJson(res, 200, { ok: true, url: '/__dsr_doc__/' + id, size: buf.length })
            return
          }

          // ---- base64 回退上传（JSON） ----
          if (path === '/__dsr_doc__/upload-base64') {
            if ((req.method || '').toUpperCase() !== 'POST') {
              res.statusCode = 405
              res.end('method not allowed')
              return
            }
            let args
            try {
              args = JSON.parse((await readBody(req, 96 * 1024 * 1024)).toString('utf8'))
            } catch (e) {
              sendJson(res, 400, { ok: false, error: '参数错误' })
              return
            }
            const name = typeof args.name === 'string' ? args.name : 'document'
            const base64 = typeof args.base64 === 'string' ? args.base64 : ''
            if (base64.length === 0) {
              sendJson(res, 400, { ok: false, error: '文档内容为空' })
              return
            }
            let buf
            try {
              buf = Buffer.from(base64, 'base64')
            } catch (e) {
              sendJson(res, 400, { ok: false, error: '文档解码失败' })
              return
            }
            if (buf.length > 64 * 1024 * 1024) {
              sendJson(res, 413, { ok: false, error: '文档过大（上限 64MB）' })
              return
            }
            const id = 'd' + (++docSeq) + '-' + Date.now().toString(36)
            docs.set(id, { buf, mediaType: 'application/pdf', name })
            if (docs.size > 12) {
              const oldest = docs.keys().next().value
              docs.delete(oldest)
            }
            sendJson(res, 200, { ok: true, url: '/__dsr_doc__/' + id, size: buf.length })
            return
          }

          // ---- 提问（JSON）：视觉管线 + 主模型收件箱 ----
          if (path === '/__dsr_doc__/ask') {
            if ((req.method || '').toUpperCase() !== 'POST') {
              res.statusCode = 405
              res.end('method not allowed')
              return
            }
            let args
            try {
              args = JSON.parse((await readBody(req, 96 * 1024 * 1024)).toString('utf8'))
            } catch (e) {
              sendJson(res, 400, { ok: false, error: '参数错误' })
              return
            }
            sendJson(res, 200, await handleAsk(args))
            return
          }

          // ---- 视觉模型路由查询（调试） ----
          if (path === '/__dsr_doc__/vision-info') {
            const route = await findVisionRoute()
            sendJson(res, 200, { ok: true, route })
            return
          }

          // ---- pdf.js 静态资源（自渲染阅读器：核心/worker/cMaps/字体/wasm 解码器） ----
          if (path.startsWith('/__dsr_doc__/pdfjs/')) {
            const rel = path.slice('/__dsr_doc__/pdfjs/'.length)
            if (rel === '' || rel.indexOf('..') >= 0 || rel.indexOf('\\') >= 0 || rel.indexOf(':') >= 0) {
              res.statusCode = 400
              res.end('bad path')
              return
            }
            const filePath = normalize(join(pdfjsDir, rel))
            if (!filePath.startsWith(pdfjsDir) || !existsSync(filePath)) {
              res.statusCode = 404
              res.end('not found')
              return
            }
            try {
              const data = readFileSync(filePath)
              const dot = rel.lastIndexOf('.')
              const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : ''
              res.statusCode = 200
              res.setHeader('Content-Type', ext === 'mjs' || ext === 'js' ? 'text/javascript' : 'application/octet-stream')
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
              res.setHeader('Content-Length', String(data.length))
              res.end(data)
            } catch (e) {
              res.statusCode = 500
              res.end('read failed')
            }
            return
          }

          // ---- 设置读写：GET 读当前值；POST { patch } 合并写入 / { replace: true } 重置 ----
          if (path === '/__dsr_doc__/settings') {
            if ((req.method || '').toUpperCase() === 'GET') {
              sendJson(res, 200, { ok: true, value: settingsScope.get() })
              return
            }
            if ((req.method || '').toUpperCase() !== 'POST') {
              res.statusCode = 405
              res.end('method not allowed')
              return
            }
            let args
            try {
              args = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'))
            } catch (e) {
              sendJson(res, 400, { ok: false, error: '参数错误' })
              return
            }
            try {
              if (args !== null && typeof args === 'object' && args.replace === true) {
                await settingsScope.replace({})
              } else if (args !== null && typeof args === 'object' && args.patch !== null &&
                         typeof args.patch === 'object' && !Array.isArray(args.patch)) {
                await settingsScope.update(args.patch)
              } else {
                sendJson(res, 400, { ok: false, error: '参数错误：需要 { patch } 或 { replace: true }' })
                return
              }
              sendJson(res, 200, { ok: true, value: settingsScope.get() })
            } catch (e) {
              sendJson(res, 400, { ok: false, error: errOf(e) })
            }
            return
          }

          // ---- 历史截图读取：按 attachmentId 返回字节（对话气泡缩略图）。
          // readImage 会校验 ref 的 mediaType/bytes/width/height，因此路由要求
          // 客户端把日志里记录的完整 ref 字段以查询参数带回。 ----
          if (path.startsWith('/__dsr_doc__/image/')) {
            const id = decodeURIComponent(path.slice('/__dsr_doc__/image/'.length))
            if (id === '' || id.indexOf('/') >= 0 || id.indexOf('..') >= 0) {
              res.statusCode = 400
              res.end('bad attachment id')
              return
            }
            const qi = raw.indexOf('?')
            const q = qi >= 0 ? raw.slice(qi + 1) : ''
            const qp = (name) => {
              const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(q)
              return m ? decodeURIComponent(m[1]) : null
            }
            const mediaType = qp('mediaType')
            const bytesN = parseInt(qp('bytes'), 10)
            const widthN = parseInt(qp('width'), 10)
            const heightN = parseInt(qp('height'), 10)
            if (mediaType === null || !Number.isSafeInteger(bytesN) || !Number.isSafeInteger(widthN) || !Number.isSafeInteger(heightN)) {
              res.statusCode = 400
              res.end('missing attachment ref fields')
              return
            }
            try {
              const stored = await attachments.readImage({ attachmentId: id, mediaType, bytes: bytesN, width: widthN, height: heightN })
              res.statusCode = 200
              res.setHeader('Content-Type', mediaType)
              res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
              res.setHeader('Content-Length', String(stored.data.byteLength))
              res.end(Buffer.from(stored.data))
            } catch (e) {
              res.statusCode = 404
              res.setHeader('Content-Type', 'text/plain; charset=utf-8')
              res.end('attachment not found')
            }
            return
          }

          // ---- 文档读取：支持 Range 分段（PDF 查看器需要） ----
          const id = path.slice('/__dsr_doc__/'.length)
          const doc = docs.get(id)
          if (doc === undefined) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end('document not found')
            return
          }
          const total = doc.buf.length
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          const rangeHeader = (req.headers && req.headers.range) ? String(req.headers.range) : ''
          const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
          if (m !== null && (m[1] !== '' || m[2] !== '')) {
            let start
            let end
            if (m[1] === '') {
              const suffix = parseInt(m[2], 10)
              start = Math.max(total - suffix, 0)
              end = total - 1
            } else {
              start = parseInt(m[1], 10)
              end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1)
            }
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
              res.statusCode = 416
              res.setHeader('Content-Range', 'bytes */' + total)
              res.end()
              return
            }
            const len = end - start + 1
            res.statusCode = 206
            res.setHeader('Content-Type', doc.mediaType)
            res.setHeader('Content-Length', String(len))
            res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total)
            res.end(doc.buf.subarray(start, end + 1))
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', doc.mediaType)
          res.setHeader('Content-Length', String(total))
          res.end(doc.buf)
        } catch (e) {
          try {
            sendJson(res, 500, { ok: false, error: errOf(e) })
          } catch (e2) { /* ignore */ }
        }
      },
    })
    ctx.effect(() => unroute)
  },
}
