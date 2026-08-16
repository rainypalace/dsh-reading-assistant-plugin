/**
 * 读书模式（持久插件）Client bundle — 懒加载 CJS 工厂形式。
 * 仅 require('react')（shell 种子模块）；HTTP 调用走同源 fetch/XHR。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reading-assistant-plugin',
  factory: (require) => {
    const React = require('react')

    // 由 apply() 注入：基于 timer 服务的让出事件循环（分块编码时保持 UI 响应）
    let yieldNow = () => Promise.resolve()

    // 由 apply() 注入：历史截图读取（sessions.readAttachment，与默认对话组件同源）
    let loadAttachmentImage = () => Promise.reject(new Error('历史截图读取服务不可用'))

    // 由 apply() 注入：取消当前会话运行（停止生成）
    let cancelSession = () => {}

    // ---------- HTTP 调用（同源，替代动态插件的 host.call） ----------
    const callJson = async (path, args) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args === undefined ? {} : args),
      })
      if (!res.ok) {
        let t = ''
        try { t = await res.text() } catch (e) { /* ignore */ }
        throw new Error('HTTP ' + res.status + (t ? ' ' + t.slice(0, 200) : ''))
      }
      return res.json()
    }

    const getJson = async (path) => {
      const res = await fetch(path)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    // ---------- base64 ----------
    async function fileToBase64(file, onProgress) {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const total = bytes.length
      let out = ''
      const CHUNK = 0x7FFE // 32766，能被 3 整除，可独立 base64
      let last = 0
      for (let i = 0; i < total; i += CHUNK) {
        const piece = String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
        out += btoa(piece)
        const done = Math.min(total, i + CHUNK)
        if (onProgress && (done - last >= 2 * 1024 * 1024 || done >= total)) {
          last = done
          onProgress(done, total)
        }
        if ((i / CHUNK) % 4 === 3) await yieldNow()
      }
      return out
    }

    // Uint8Array → base64（分块，避免参数溢出）
    async function bytesToBase64(bytes) {
      let out = ''
      const CHUNK = 0x7FFE
      for (let i = 0; i < bytes.length; i += CHUNK) {
        out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)))
        if ((i / CHUNK) % 8 === 7) await yieldNow()
      }
      return out
    }

    // ---------- 剪贴板图片提取 ----------
    function readClipboardFiles(dt) {
      const files = []
      if (dt && dt.files && dt.files.length) {
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i]
          if (f) files.push(f)
        }
      }
      if (dt && dt.items && dt.items.length) {
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i]
          if (!item) continue
          try {
            if (item.kind === 'file' && /^image\//.test(String(item.type || ''))) {
              const f = typeof item.getAsFile === 'function' ? item.getAsFile() : null
              if (f) files.push(f)
            }
          } catch (e) { /* ignore */ }
        }
      }
      return files
    }

    // 在任意文本中搜索图片线索：data URL / blob: / 图片文件 URL
    function findAnyImageToken(text) {
      if (!text) return null
      let m = /(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/i.exec(text)
      if (m) return m[1]
      m = /(blob:[^\s"'<>]+)/i.exec(text)
      if (m) return m[1]
      m = /(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?)/i.exec(text)
      if (m) return m[1]
      return null
    }

    // HTML 实体解码（剪贴板 HTML 里的 src 属性常被转义，如 &amp;）
    function decodeHtmlEntities(s) {
      return String(s === undefined || s === null ? '' : s)
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    }

    // 收集 HTML 中所有图片候选：img 标签的 src/data-src（按出现顺序、去重），
    // 再兜底裸 data:/blob:/图片 URL。不再只取第一个，避免第一个候选失败就放弃。
    function collectImageCandidates(html) {
      if (!html) return []
      const out = []
      const push = (u) => {
        if (u && out.indexOf(u) < 0) out.push(u)
      }
      const re = /<img[^>]*>/gi
      let m
      while ((m = re.exec(html))) {
        const tag = m[0]
        const sm = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag) || /\bsrc\s*=\s*'([^']*)'/i.exec(tag) ||
          /\bdata-src\s*=\s*"([^"]*)"/i.exec(tag) || /\bdata-src\s*=\s*'([^']*)'/i.exec(tag)
        if (sm) push(decodeHtmlEntities(sm[1]))
      }
      const tok = findAnyImageToken(html)
      if (tok) push(tok)
      return out
    }

    // 将 blob: URL 通过离屏画布还原为 Blob
    function blobUrlToBlob(blobUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            const canvas = new OffscreenCanvas(Math.max(1, img.naturalWidth || 1), Math.max(1, img.naturalHeight || 1))
            const ctx2d = canvas.getContext('2d')
            if (!ctx2d) {
              reject(new Error('无法创建画布'))
              return
            }
            ctx2d.drawImage(img, 0, 0)
            canvas.convertToBlob({ type: 'image/png' }).then(resolve).catch(reject)
          } catch (e) {
            reject(e)
          }
        }
        img.onerror = () => reject(new Error('图片加载失败'))
        img.src = blobUrl
      })
    }

    // 解析剪贴板中的图片地址 → 图片对象 / Blob / null
    async function resolvePastedImage(src) {
      if (!src) return null
      const data = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(src)
      if (data) {
        return { kind: 'img', img: { name: 'pasted-image', type: data[1], base64: data[2], preview: src } }
      }
      if (/^blob:/i.test(src)) {
        const blob = await blobUrlToBlob(src)
        return { kind: 'blob', blob }
      }
      if (/^https?:/i.test(src)) {
        const err = new Error('剪贴板里的图片是网页链接，无法直接读取')
        err.kind = 'http'
        err.src = src
        throw err
      }
      if (/^file:/i.test(src)) {
        const err = new Error('剪贴板里的截图是本地文件引用（file://），浏览器禁止网页读取本地文件')
        err.kind = 'file'
        err.src = src
        throw err
      }
      return null
    }

    // ---------- 轻量 Markdown 渲染 ----------
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function inlineMd(s) {
      const src = String(s)
      // 先把行内代码段切开，避免其内容被其他规则污染
      const parts = src.split(/(`[^`]+`)/g)
      for (let k = 0; k < parts.length; k++) {
        if (k % 2 === 1) {
          parts[k] = '<code>' + parts[k].slice(1, -1) + '</code>'
          continue
        }
        let out = parts[k]
        out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        out = out.replace(/(^|[^*])\*([^*\n]+)\*($|[^*])/g, '$1<em>$2</em>$3')
        out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>')
        parts[k] = out
      }
      return parts.join('')
    }

    // 表格行拆分：去掉首尾管道符后按 | 切分
    function splitTableRow(line) {
      let t = String(line).trim()
      if (t.startsWith('|')) t = t.slice(1)
      if (t.endsWith('|')) t = t.slice(0, -1)
      return t.split('|')
    }

    // 表格分隔行（如 | --- | :---: | ---: |）
    function isTableSeparator(line) {
      const t = String(line || '').trim()
      if (t.indexOf('|') === -1) return false
      const cells = splitTableRow(t)
      if (cells.length === 0) return false
      for (const c of cells) {
        if (!/^:?-{3,}:?$/.test(c.trim())) return false
      }
      return true
    }

    function mdToHtml(src) {
      const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n')
      const out = []
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (/^```/.test(line)) {
          const buf = []
          i++
          while (i < lines.length && !/^```\s*$/.test(lines[i])) {
            buf.push(lines[i])
            i++
          }
          i++
          out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>')
          continue
        }
        // 表格：表头行 + 分隔行 + 数据行
        if (/^\s*\|/.test(line) && isTableSeparator(lines[i + 1])) {
          const headerCells = splitTableRow(line)
          const aligns = splitTableRow(lines[i + 1]).map((c) => {
            const t = c.trim()
            if (t.startsWith(':') && t.endsWith(':')) return 'center'
            if (t.endsWith(':')) return 'right'
            return 'left'
          })
          const rows = []
          let j = i + 2
          while (j < lines.length && /^\s*\|/.test(lines[j]) && !isTableSeparator(lines[j])) {
            rows.push(splitTableRow(lines[j]))
            j++
          }
          i = j
          const cell = (text, tag, align) => {
            const style = align !== 'left' ? ' style="text-align:' + align + '"' : ''
            return '<' + tag + style + '>' + inlineMd(escapeHtml(text.trim())) + '</' + tag + '>'
          }
          const head = '<tr>' + headerCells.map((c, k) => cell(c, 'th', aligns[k] || 'left')).join('') + '</tr>'
          const body = rows.map((r) => '<tr>' + r.map((c, k) => cell(c, 'td', aligns[k] || 'left')).join('') + '</tr>').join('')
          out.push('<table><thead>' + head + '</thead>' + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>')
          continue
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h) {
          const level = h[1].length
          out.push('<h' + level + '>' + inlineMd(escapeHtml(h[2])) + '</h' + level + '>')
          i++
          continue
        }
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
          out.push('<hr/>')
          i++
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buf.push(lines[i].replace(/^\s*>\s?/, ''))
            i++
          }
          out.push('<blockquote>' + inlineMd(escapeHtml(buf.join(' '))) + '</blockquote>')
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            buf.push('<li>' + inlineMd(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/, ''))) + '</li>')
            i++
          }
          out.push('<ul>' + buf.join('') + '</ul>')
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            buf.push('<li>' + inlineMd(escapeHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ''))) + '</li>')
            i++
          }
          out.push('<ol>' + buf.join('') + '</ol>')
          continue
        }
        if (/^\s*$/.test(line)) {
          i++
          continue
        }
        const buf = []
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
          buf.push(lines[i])
          i++
        }
        // 以 | 开头但不是完整表格的行（常见于流式输出：表格行先于分隔行到达）：
        // 按普通段落吞掉一行，保证 i 必然前进，避免死循环
        if (buf.length === 0 && i < lines.length) {
          buf.push(lines[i])
          i++
        }
        out.push('<p>' + inlineMd(escapeHtml(buf.join(' '))) + '</p>')
      }
      return out.join('\n')
    }

    // ---------- mdToHtml 结果缓存（LRU） ----------
    // 流式期间每个 chunk 都会触发重渲染；历史气泡与 partial 的文本只有
    // partial 在增长，其余不变。缓存命中后渲染成本从「全量重解析」降为 O(1)。
    const mdCache = new Map()
    const mdCacheMax = 256
    function mdToHtmlCached(src) {
      const key = src === null || src === undefined ? '' : src
      const hit = mdCache.get(key)
      if (hit !== undefined) {
        mdCache.delete(key)
        mdCache.set(key, hit)
        return hit
      }
      const html = mdToHtml(key)
      mdCache.set(key, html)
      if (mdCache.size > mdCacheMax) {
        const oldest = mdCache.keys().next().value
        mdCache.delete(oldest)
      }
      return html
    }

    // ---------- 插件全局状态 ----------
    const state = { active: false, dialogue: true, doc: null, notice: null, upload: null, settingsOpen: false, helpOpen: false, historyOpen: false, jumpTo: null, imageViewer: null, pdfPage: 1, jumpPage: null, draft: '', draftImage: null, pendingMsgs: [], perfWarn: null, cfg: { avatarSize: 116, panelWidth: 380, showAvatarHint: true, recognitionOpen: false, chatFontSize: 13, pdfRenderer: 'edge' } }
    const listeners = new Set()
    const store = {
      get: () => state,
      set(patch) {
        Object.assign(state, patch)
        for (const fn of listeners) {
          try { fn() } catch (e) { /* ignore */ }
        }
      },
      subscribe(fn) {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    }

    function useReader() {
      const [v, setV] = React.useState(0)
      React.useEffect(() => store.subscribe(() => setV((x) => x + 1)), [])
      return state
    }

    // ---------- 会话消息提取 ----------
    // 内容分块：文本拼合 + 图片引用（其余块忽略）
    function contentParts(content) {
      let text = ''
      const images = []
      const list = Array.isArray(content) ? content : []
      for (const block of list) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'image' && block.attachment !== undefined && block.attachment !== null) images.push(block.attachment)
      }
      return { text, images }
    }

    // 节点是否来自读书模式插件（其注入的问题按用户气泡展示）
    function isReadingModeSource(node) {
      const src = node && node.source
      if (src !== null && typeof src === 'object' && src.plugin === 'reading-mode') return true
      return false
    }

    // 从读书模式注入文本中拆出「干净问题」与「截图识别结果」（识别结果折叠展示）
    function splitRecognition(text) {
      const marker = '【用户截图识别结果'
      const i = text.indexOf(marker)
      if (i === -1) return { question: text, recognition: '' }
      return { question: text.slice(0, i).trim(), recognition: text.slice(i) }
    }

    // 去掉「【读书模式 · 正在阅读《X》】」前缀（文档信息在顶栏已有）
    function stripDocPrefix(text) {
      return String(text === undefined || text === null ? '' : text).replace(/^【读书模式 · 正在阅读《[^》]*》】\s*/, '')
    }

    // 读书模式消息 → 用户气泡条目（干净问题 + 折叠识别结果 + source.image 缩略图）
    function buildReadingModeEntry(node, parts) {
      const split = splitRecognition(stripDocPrefix(parts.text))
      const images = parts.images.slice()
      const srcImg = node.source && typeof node.source === 'object' ? node.source.image : null
      if (srcImg !== null && srcImg !== undefined && typeof srcImg.attachmentId === 'string' &&
          !images.some((a) => a && a.attachmentId === srcImg.attachmentId)) {
        images.push(srcImg)
      }
      return { key: 'u' + node.seq, kind: 'user', text: split.question, recognition: split.recognition, images, time: node.time, page: node.source && typeof node.source === 'object' && Number.isSafeInteger(node.source.page) && node.source.page >= 1 ? node.source.page : null }
    }

    // 首行摘要（折叠时显示）
    function firstLine(text) {
      const t = String(text === undefined || text === null ? '' : text)
      const i = t.indexOf('\n')
      return i === -1 ? t : t.slice(0, i)
    }

    function deriveMessages(snap) {
      if (snap === undefined || snap === null) return []
      const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
      const out = []
      for (const node of nodes.slice(-200)) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind === 'user' || node.kind === 'steering') {
          const parts = contentParts(node.content)
          if (parts.text === '' && parts.images.length === 0) continue
          if (isReadingModeSource(node)) {
            out.push(buildReadingModeEntry(node, parts))
          } else {
            out.push({ key: 'u' + node.seq, kind: 'user', text: parts.text, images: parts.images, time: node.time })
          }
        } else if (node.kind === 'context') {
          const parts = contentParts(node.content)
          if (parts.text === '' && parts.images.length === 0) continue
          if (isReadingModeSource(node)) {
            out.push(buildReadingModeEntry(node, parts))
          } else {
            out.push({ key: 'c' + node.seq, kind: 'context', text: parts.text, time: node.time })
          }
        } else if (node.kind === 'assistant') {
          const blocks = Array.isArray(node.blocks) ? node.blocks : []
          let text = ''
          const think = []
          const images = []
          for (const b of blocks) {
            if (!b) continue
            if (b.kind === 'text' && typeof b.text === 'string') text += b.text
            else if (b.kind === 'reasoning' && typeof b.text === 'string' && b.text.trim() !== '') think.push(b.text)
            else if (b.kind === 'image' && b.attachment !== undefined && b.attachment !== null) images.push(b.attachment)
          }
          if (text === '' && think.length === 0 && images.length === 0) continue
          out.push({ key: 'a' + node.seq, kind: 'assistant', text, think, images, time: node.time, interrupted: node.interrupted === true })
        } else if (node.kind === 'turn-error') {
          out.push({ key: 'e' + node.seq, kind: 'turn-error', message: typeof node.message === 'string' ? node.message : '回合出错' })
        }
      }
      return out
    }

    // 流式 partial：文本 + 思考过程
    function partialView(snap) {
      if (!snap || !snap.partial || !Array.isArray(snap.partial.blocks)) return null
      let text = ''
      const think = []
      for (const b of snap.partial.blocks) {
        if (!b) continue
        if (b.kind === 'text' && typeof b.text === 'string') text += b.text
        else if (b.kind === 'reasoning' && typeof b.text === 'string' && b.text.trim() !== '') think.push(b.text)
      }
      if (text === '' && think.length === 0) return null
      return { text, think }
    }

    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 KB'
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
      return Math.max(1, Math.round(n / 1024)) + ' KB'
    }

    // ---------- PDF 上传：XHR 直传（快、带进度），失败回退 base64 JSON ----------
    // ---------- 本地文档打开（File System Access + IndexedDB 句柄持久化） ----------
    // 上传通道废弃：Blob URL 直接喂浏览器内置查看器，零上传、无大小限制
    const idbReady = (() => {
      try { return typeof indexedDB !== 'undefined' } catch (e) { return false }
    })()

    function idbOpen() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('dsh-reading-mode', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('docs')) req.result.createObjectStore('docs', { keyPath: 'name' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    }

    async function idbPutDoc(name, value) {
      if (!idbReady) return
      try {
        const db = await idbOpen()
        await new Promise((res, rej) => {
          const tx = db.transaction('docs', 'readwrite')
          tx.objectStore('docs').put({ name, value, openedAt: Date.now() })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        })
      } catch (e) { /* ignore */ }
    }

    async function idbListDocs() {
      if (!idbReady) return []
      try {
        const db = await idbOpen()
        return await new Promise((res) => {
          const tx = db.transaction('docs', 'readonly')
          const req = tx.objectStore('docs').getAll()
          req.onsuccess = () => res(req.result || [])
          req.onerror = () => res([])
        })
      } catch (e) { return [] }
    }

    async function idbDeleteDoc(name) {
      if (!idbReady) return
      try {
        const db = await idbOpen()
        await new Promise((res) => {
          const tx = db.transaction('docs', 'readwrite')
          tx.objectStore('docs').delete(name)
          tx.oncomplete = () => res()
        })
      } catch (e) { /* ignore */ }
    }

    // 从 File 打开文档（Blob URL 直接喂浏览器内置查看器）
    async function openFromFile(file) {
      const name = String(file.name || 'document')
      const isPdf = /\.pdf$/i.test(name) || file.type === 'application/pdf'
      const isMd = /\.(md|markdown|mdown|mkd)$/i.test(name) || /markdown/i.test(String(file.type || ''))
      if (!isPdf && !isMd) {
        store.set({ notice: '仅支持 PDF 或 Markdown 文档' })
        return false
      }
      try {
        if (isPdf) {
          const url = URL.createObjectURL(file)
          store.set({ doc: { kind: 'pdf', title: name, url, file }, notice: null })
        } else {
          const text = await file.text()
          if (text.length > 8 * 1024 * 1024) {
            store.set({ notice: 'Markdown 过大（上限 8MB）' })
            return false
          }
          store.set({ doc: { kind: 'md', title: name, text }, notice: null })
        }
        return true
      } catch (e) {
        store.set({ notice: '文档打开失败：' + ((e && e.message) ? e.message : String(e)) })
        return false
      }
    }

    // 打开文件选择器：优先 File System Access API，回退隐藏的 input[type=file]
    let fallbackInputRef = null
    async function chooseDocument() {
      if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
        try {
          const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [{ description: '文档', accept: { 'application/pdf': ['.pdf'], 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] } }],
          })
          if (handle === undefined || handle === null) return
          const file = await handle.getFile()
          if (await openFromFile(file)) await idbPutDoc(file.name, handle)
        } catch (e) {
          if (e && e.name === 'AbortError') return // 用户取消
          store.set({ notice: '打开文件失败：' + ((e && e.message) ? e.message : String(e)) })
        }
      } else if (fallbackInputRef !== null && fallbackInputRef !== undefined) {
        fallbackInputRef.click()
      }
    }

    // 从 File（拖放 / 回退选择）打开并尽力持久化
    async function handleFiles(fileList) {
      const file = fileList && fileList.length ? fileList[0] : null
      if (file === null) return
      if (await openFromFile(file)) {
        if (typeof window.showOpenFilePicker !== 'function') await idbPutDoc(file.name, file)
      }
    }

    // 恢复上次文档：句柄路径需权限确认；File 记录直接打开
    async function restoreDoc(record) {
      const value = record.value
      try {
        if (value !== null && typeof value === 'object' && typeof value.getFile === 'function') {
          let perm = 'prompt'
          try { perm = await value.queryPermission({ mode: 'read' }) } catch (e) { /* ignore */ }
          if (perm === 'denied') {
            store.set({ notice: '没有「' + record.name + '」的读取权限，请重新打开该文件' })
            return
          }
          if (perm === 'prompt') {
            try { perm = await value.requestPermission({ mode: 'read' }) } catch (e) { perm = 'denied' }
          }
          if (perm !== 'granted') {
            store.set({ notice: '未获授权，请重新打开该文件' })
            return
          }
          const file = await value.getFile()
          await openFromFile(file)
        } else if (typeof File !== 'undefined' && value instanceof File) {
          await openFromFile(value)
        } else {
          store.set({ notice: '这条记录已失效，请重新打开文件' })
          await idbDeleteDoc(record.name)
        }
      } catch (e) {
        store.set({ notice: '恢复文档失败（文件可能已被移动或删除）：' + ((e && e.message) ? e.message : String(e)) })
        await idbDeleteDoc(record.name)
      }
    }

    // ---------- pdf.js 官方组件渲染（PDFViewer，Firefox 同款管线，页码可编程） ----------
    const PDFJS_LIB_URL = '/__dsr_doc__/pdfjs/pdf.min.mjs'
    const PDFJS_WORKER_URL = '/__dsr_doc__/pdfjs/pdf.worker.min.mjs'
    const PDFJS_VIEWER_URL = '/__dsr_doc__/pdfjs/pdf_viewer.mjs'
    const PDFJS_VIEWER_CSS_URL = '/__dsr_doc__/pdfjs/pdf_viewer.css'
    const PDFJS_CMAP_URL = '/__dsr_doc__/pdfjs/cMaps/'
    const PDFJS_ICC_URL = '/__dsr_doc__/pdfjs/iccs/'
    const PDFJS_FONTS_URL = '/__dsr_doc__/pdfjs/standard_fonts/'
    const PDFJS_WASM_URL = '/__dsr_doc__/pdfjs/wasm/'

    // 阅读进度（localStorage，按书名+文件大小记录，上限 50 条）
    const PROGRESS_KEY = 'dsr-rm-progress'
    function progressLoad() {
      try {
        const v = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}')
        return v !== null && typeof v === 'object' ? v : {}
      } catch (e) { return {} }
    }
    function progressSave(map) {
      try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(map)) } catch (e) { /* ignore */ }
    }

    function PdfJsReader(props) {
      const file = props.file
      const [status, setStatus] = React.useState('loading')
      const [numPages, setNumPages] = React.useState(0)
      const [currentPage, setCurrentPage] = React.useState(0)
      const [zoomLabel, setZoomLabel] = React.useState('')
      const [pageInput, setPageInput] = React.useState('')
      const hostRef = React.useRef(null)
      const viewerDivRef = React.useRef(null)
      const viewerRef = React.useRef(null)
      const pollRef = React.useRef(null)
      const pageInputRef = React.useRef(null)
      const pdfRef = React.useRef(null)
      const jumpGenRef = React.useRef(0)
      const dimsRef = React.useRef(null)
      const restoringRef = React.useRef(false)
      const [restoreNote, setRestoreNote] = React.useState(false)
      const s0 = useReader()

      // 页码输入框：跟随当前页，但输入聚焦时不被轮询覆盖
      React.useEffect(() => {
        if (document.activeElement !== pageInputRef.current) setPageInput(String(currentPage || ''))
      }, [currentPage])

      // 历史索引「跳回第 X 页」
      React.useEffect(() => {
        if (s0.jumpPage === null || s0.jumpPage === undefined || status !== 'ready' || numPages === 0) return
        gotoPage(s0.jumpPage)
        store.set({ jumpPage: null })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s0.jumpPage, status, numPages])

      React.useEffect(() => {
        let alive = true
        let viewer = null
        let pdf = null
        let styleEl = null
        let onPageRendered = null
        let cancelOnUser = null
        ;(async () => {
          try {
            const cssRes = await fetch(PDFJS_VIEWER_CSS_URL)
            if (!cssRes.ok) throw new Error('查看器样式加载失败 HTTP ' + cssRes.status)
            const cssText = await cssRes.text()
            if (!alive) return
            styleEl = document.createElement('style')
            styleEl.textContent = cssText
            document.head.appendChild(styleEl)

            const lib = await import(PDFJS_LIB_URL)
            if (!alive) return
            globalThis.pdfjsLib = lib
            lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
            const viewerMod = await import(PDFJS_VIEWER_URL)
            if (!alive) return

            const buf = await file.arrayBuffer()
            if (!alive) return
            pdf = await lib.getDocument({
              data: buf,
              cMapUrl: PDFJS_CMAP_URL,
              cMapPacked: true,
              iccUrl: PDFJS_ICC_URL,
              standardFontDataUrl: PDFJS_FONTS_URL,
              wasmUrl: PDFJS_WASM_URL,
              useWasm: true,
            }).promise
            if (!alive) { try { pdf.destroy() } catch (e) { /* ignore */ } return }
            setNumPages(pdf.numPages)

            const host = hostRef.current
            const viewerEl = viewerDivRef.current
            if (host === null || host === undefined || viewerEl === null || viewerEl === undefined) {
              setStatus('error:容器未就绪，请重试')
              return
            }
            const eventBus = new viewerMod.EventBus()
            // 兜底：显式给 CSS 缩放变量，避免 auto 首帧拿不到页宽算出 NaN → 页 div 零尺寸
            try { viewerEl.style.setProperty('--scale-factor', '1') } catch (e) { /* ignore */ }
            viewer = new viewerMod.PDFViewer({
              container: host,
              viewer: viewerEl,
              eventBus,
              textLayerMode: 1,
            })
            viewerRef.current = viewer
            await viewer.setDocument(pdf)
            if (!alive) return
            setStatus('ready')
            // ---------- v1.7.7 阅读进度恢复（单链路两段式精确跳） ----------
            // 旧版 7 个触发点（pagerendered+6 定时器）反复估算跳页互相打架，且恢复
            // 中间态会被 3 秒节流写盘污染。新版：等阅读器稳定（page-width 生效并再
            // 渲染一帧）→ 唯一一次 preciseJump（官方估算快跳 → 预取真实页高修正未
            // 渲染页占位 → 官方再跳一次，offsetTop 全链真实即精确落点）。
            // 恢复/精确跳期间 restoringRef=true，轮询与卸载均暂停写盘。
            pdfRef.current = pdf
            const progressKey = (props.title || 'doc') + ':' + (file.size || 0)
            let saved = null
            try {
              const probe = '__dsr_rm_t__'
              localStorage.setItem(probe, '1')
              localStorage.removeItem(probe)
              saved = progressLoad()[progressKey]
            } catch (e) {
              store.set({ notice: '浏览器本地存储不可用（' + ((e && e.message) ? e.message : String(e)) + '），阅读进度无法保存' })
            }
            const restoreTarget = saved && Number.isSafeInteger(saved.page) && saved.page > 1 ? saved.page : null
            // 用户手动滚动/按键 = 放弃自动恢复（用户意图优先）
            cancelOnUser = () => cancelJump()
            try {
              host.addEventListener('wheel', cancelOnUser, { passive: true })
              host.addEventListener('touchstart', cancelOnUser, { passive: true })
              host.addEventListener('keydown', cancelOnUser)
            } catch (e) { /* ignore */ }
            let scaleApplied = false
            let restoreFired = false
            onPageRendered = () => {
              if (!scaleApplied || restoreFired || restoreTarget === null) return
              restoreFired = true
              // page-width 重绘完成后等 250ms，布局稳定后开始精确跳
              setTimeout(() => { if (alive) preciseJump(restoreTarget, { note: true }) }, 250)
            }
            try { eventBus._on('pagerendered', onPageRendered) } catch (e) { /* ignore */ }
            // 适配宽度（数字缩放引导已无必要：pdfViewer 类修复后 auto 正常）
            setTimeout(() => {
              if (!alive) return
              try { viewer.currentScaleValue = 'page-width' } catch (e) { /* ignore */ }
              scaleApplied = true
            }, 150)
            let lastSave = 0
            pollRef.current = setInterval(() => {
              try {
                if (viewer === null || viewer === undefined) return
                const cur = viewer.currentPageNumber || 1
                setCurrentPage(cur)
                // 同步给插件 store（提问时带上页码）
                if (state.pdfPage !== cur) store.set({ pdfPage: cur })
                // 进度落盘（节流 3 秒；恢复/精确跳期间暂停，防中间位置污染）
                const now = Date.now()
                if (!restoringRef.current && now - lastSave >= 3000) {
                  lastSave = now
                  const map = progressLoad()
                  map[progressKey] = { page: cur, at: now }
                  const keys = Object.keys(map)
                  if (keys.length > 50) delete map[keys[0]]
                  progressSave(map)
                }
                const s2 = viewer.currentScale
                if (typeof s2 === 'number') setZoomLabel(Math.round(s2 * 100) + '%')
              } catch (e) { /* ignore */ }
            }, 400)
          } catch (e) {
            if (alive) setStatus('error:' + ((e && e.message) ? e.message : String(e)))
          }
        })()
        return () => {
          alive = false
          const busy = restoringRef.current
          jumpGenRef.current += 1
          restoringRef.current = false
          setRestoreNote(false)
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
          try {
            // 卸载时保存最终页码（恢复/精确跳进行中不写，保留旧值防中间位置污染）
            const v = viewerRef.current
            if (v !== null && v !== undefined && !busy) {
              const cur = v.currentPageNumber || 1
              const progressKey = (props.title || 'doc') + ':' + (file.size || 0)
              const map = progressLoad()
              map[progressKey] = { page: cur, at: Date.now() }
              const keys = Object.keys(map)
              if (keys.length > 50) delete map[keys[0]]
              progressSave(map)
            }
          } catch (e) { /* ignore */ }
          if (onPageRendered !== null) { try { eventBus._off('pagerendered', onPageRendered) } catch (e) { /* ignore */ } }
          if (cancelOnUser !== null) {
            try {
              if (host !== null && host !== undefined) {
                host.removeEventListener('wheel', cancelOnUser)
                host.removeEventListener('touchstart', cancelOnUser)
                host.removeEventListener('keydown', cancelOnUser)
              }
            } catch (e) { /* ignore */ }
          }
          try { if (viewer !== null && viewer !== undefined && typeof viewer.cleanup === 'function') viewer.cleanup() } catch (e) { /* ignore */ }
          try { if (pdf !== null && pdf !== undefined) pdf.destroy() } catch (e) { /* ignore */ }
          viewerRef.current = null
          pdfRef.current = null
          dimsRef.current = null
          if (styleEl !== null) { try { styleEl.remove() } catch (e) { /* ignore */ } }
        }
      }, [file])

      // ---------- v1.7.7 两段式精确跳页 ----------
      // 根因：未渲染页的 div 是 CSS 占位尺寸（816×1056），官方 scrollPageIntoView
      // 用 div.offsetTop 定位 → 上方占位高度与真实高度差累计 → 远跳过冲十几页。
      // 对策：后台预取 1..target-1 页 viewport（纯几何计算，不渲染画布），把未渲染
      // 页 div 的高度改成真实值，再跳一次即精确。恢复与远距页码跳转共用此链路。
      const cancelJump = () => {
        jumpGenRef.current += 1
        restoringRef.current = false
        setRestoreNote(false)
      }
      const saveProgressNow = (page) => {
        try {
          const progressKey = (props.title || 'doc') + ':' + (file.size || 0)
          const map = progressLoad()
          map[progressKey] = { page, at: Date.now() }
          const keys = Object.keys(map)
          if (keys.length > 50) delete map[keys[0]]
          progressSave(map)
        } catch (e) { /* ignore */ }
      }
      // 预取 1..target-1 页真实高度（PDF 单位），修正未渲染页 div 的占位高度
      async function fixPlaceholders(target, gen) {
        const pdf = pdfRef.current
        const v = viewerRef.current
        if (pdf === null || pdf === undefined || v === null || v === undefined) return
        const total = target - 1
        if (total <= 0) return
        if (dimsRef.current === null || dimsRef.current === undefined) {
          dimsRef.current = { heights: new Array(Math.max(1, v.pagesCount)) }
        }
        const dims = dimsRef.current
        const toSet = []
        const toFetch = []
        for (let i = 0; i < total; i++) {
          const pv = v.getPageView(i)
          if (pv === null || pv === undefined || pv.pdfPage) continue // 已渲染页官方已用真实尺寸
          toSet.push(i)
          if (!dims.heights[i]) toFetch.push(i)
        }
        const CONC = 24
        for (let b = 0; b < toFetch.length; b += CONC) {
          const batch = toFetch.slice(b, b + CONC)
          await Promise.all(batch.map(async (i) => {
            try {
              const page = await pdf.getPage(i + 1)
              const vp = page.getViewport({ scale: 1 })
              dims.heights[i] = vp.height
            } catch (e) { /* 单页失败保留占位，不影响整体 */ }
          }))
          if (gen !== jumpGenRef.current) return
        }
        if (gen !== jumpGenRef.current) return
        const cssScale = ((v.currentScale || 1) * 96) / 72
        for (const i of toSet) {
          const h = dims.heights[i]
          if (!h) continue
          const pv = v.getPageView(i)
          if (pv !== null && pv !== undefined && pv.div && !pv.pdfPage) {
            pv.div.style.height = (Math.round(h * cssScale * 100) / 100) + 'px'
          }
        }
      }
      // 两段式精确跳：官方估算快跳 → 占位修正 → 官方再跳（offsetTop 全链真实）
      async function preciseJump(page, opts) {
        const gen = jumpGenRef.current + 1
        jumpGenRef.current = gen
        const v = viewerRef.current
        if (v === null || v === undefined || pdfRef.current === null || pdfRef.current === undefined) return
        const target = Math.max(1, Math.min(v.pagesCount, page))
        restoringRef.current = true
        if (opts !== null && opts !== undefined && opts.note === true) setRestoreNote(true)
        try {
          v.scrollPageIntoView({ pageNumber: target })
          if (target > 1) {
            await fixPlaceholders(target, gen)
            if (gen !== jumpGenRef.current) return
            v.scrollPageIntoView({ pageNumber: target })
          }
        } catch (e) { /* ignore */ }
        if (gen === jumpGenRef.current) {
          restoringRef.current = false
          setRestoreNote(false)
          saveProgressNow(target)
        }
      }
      const gotoPage = (n) => {
        const v = viewerRef.current
        if (v === null || v === undefined || numPages === 0) return
        const target = Math.max(1, Math.min(numPages, n))
        // 近距离（目标页已渲染）→ 官方定位即精确；远跳 → 两段式精确跳
        const pv = v.getPageView(target - 1)
        const near = (Math.abs((v.currentPageNumber || 1) - target) <= 2) || (pv !== null && pv !== undefined && pv.pdfPage)
        if (near) {
          try { v.scrollPageIntoView({ pageNumber: target }) } catch (e) { /* ignore */ }
        } else {
          preciseJump(target, {})
        }
      }
      const zoom = (f) => {
        const v = viewerRef.current
        if (v === null || v === undefined) return
        try {
          const next = Math.max(0.5, Math.min(3, Math.round(v.currentScale * f * 100) / 100))
          v.currentScaleValue = String(next)
        } catch (e) { /* ignore */ }
      }

      return React.createElement('div', { className: 'dsr-pdfjs' },
        React.createElement('div', { className: 'dsr-pdfjs-bar' },
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '上一页', onClick: () => gotoPage(currentPage - 1) }, '‹'),
          React.createElement('input', {
            className: 'dsr-pdfjs-pageinput',
            type: 'number',
            min: 1,
            max: numPages,
            value: pageInput,
            ref: pageInputRef,
            title: '输入页码后回车跳转',
            onChange: (e) => setPageInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                const n = parseInt(pageInput, 10)
                if (Number.isSafeInteger(n)) { gotoPage(n); e.currentTarget.blur() }
              } else if (e.key === 'Escape') {
                e.currentTarget.blur()
              }
            },
            onFocus: (e) => e.currentTarget.select(),
          }),
          React.createElement('span', { className: 'dsr-pdfjs-page' }, '/ ' + numPages + ' 页'),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '下一页', onClick: () => gotoPage(currentPage + 1) }, '›'),
          React.createElement('span', { className: 'dsr-pdfjs-sep' }),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '缩小', onClick: () => zoom(0.8) }, '－'),
          React.createElement('span', { className: 'dsr-pdfjs-page' }, zoomLabel || '适配宽度'),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '放大', onClick: () => zoom(1.25) }, '＋')
        ),
        restoreNote
          ? React.createElement('div', { className: 'dsr-pdfjs-restorenote' }, '正在恢复阅读进度…')
          : null,
        // 包装层占满剩余空间；host 绝对定位只填包装层内部，不遮工具栏
        React.createElement('div', { className: 'dsr-pdfjs-hostwrap' },
          React.createElement('div', { className: 'dsr-pdfjs-host', ref: hostRef },
            React.createElement('div', { className: 'dsr-pdfjs-viewer pdfViewer', ref: viewerDivRef })
          )
        ),
        status !== 'ready'
          ? React.createElement('div', { className: 'dsr-pdf-status' },
              status === 'loading' ? '正在加载 PDF…' : status
            )
          : null
      )
    }

    // ---------- 助手立绘（Q 版大肥鱼，白底已洗为透明，WebP base64 内嵌） ----------
    const AVATAR_B64 = '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'
    const AVATAR_SRC = 'data:image/webp;base64,' + AVATAR_B64
    // 第二张立绘：拿放大镜的助手（文档空状态插图）
    const AVATAR2_B64 = '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'
    const AVATAR2_SRC = 'data:image/webp;base64,' + AVATAR2_B64
    function Avatar(props) {
      const size = props.size || 120
      return React.createElement('img', {
        className: 'dsr-avatar',
        src: AVATAR_SRC,
        alt: '学习助手',
        draggable: false,
        width: size,
        style: { width: size, height: 'auto', display: 'block' },
      })
    }

    // ---------- 思考过程折叠行（对齐默认对话组件的 Think 披露行） ----------
    function ThinkRow(props) {
      const [open, setOpen] = React.useState(props.defaultOpen === true)
      const summary = firstLine(props.text)
      const toggle = () => setOpen((v) => !v)
      return React.createElement('div', { className: 'dsr-think' },
        React.createElement('div', {
          className: 'dsr-think-head',
          role: 'button',
          tabIndex: 0,
          onClick: toggle,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
        },
          React.createElement('span', { className: 'dsr-think-chevron', style: { transform: open ? 'rotate(90deg)' : 'none' } }, '▸'),
          React.createElement('span', { className: 'dsr-think-title' }, props.label || '思考过程'),
          props.running === true ? React.createElement('span', { className: 'dsr-think-running' }, '生成中') : null,
          open ? null : React.createElement('span', { className: 'dsr-think-summary', title: summary }, summary)
        ),
        open ? React.createElement('div', { className: 'dsr-think-body' }, props.text) : null
      )
    }

    // ---------- 历史截图缩略图（sessions.readAttachment，与默认组件同源） ----------
    function ImageThumb(props) {
      const att = props.attachment
      const sessionId = props.sessionId
      const [url, setUrl] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        setUrl(null)
        setFailed(false)
        loadAttachmentImage(sessionId, att).then((u) => { if (alive) setUrl(u) }, () => { if (alive) setFailed(true) })
        return () => { alive = false }
      }, [sessionId, att === null || att === undefined ? '' : att.attachmentId])
      if (failed) return React.createElement('div', { className: 'dsr-img-placeholder' + (props.small === true ? ' dsr-hist-thumbbox' : ''), title: '历史截图读取失败' }, '🖼')
      if (url === null) return React.createElement('div', { className: 'dsr-img-placeholder' + (props.small === true ? ' dsr-hist-thumbbox' : ''), title: '正在读取截图…' }, '🖼')
      return React.createElement('img', {
        className: 'dsr-msg-img' + (props.small === true ? ' dsr-hist-thumb' : ''),
        src: url,
        alt: (att && att.name) ? att.name : '截图',
        title: '点击查看大图',
        onClick: () => store.set({ imageViewer: url }),
      })
    }

    function ImageThumbs(props) {
      const images = Array.isArray(props.images) ? props.images : []
      if (images.length === 0) return null
      return React.createElement('div', { className: 'dsr-user-imgs' },
        images.map((att, i) => React.createElement(ImageThumb, {
          key: (att && att.attachmentId) ? att.attachmentId : 'i' + i,
          attachment: att,
          sessionId: props.sessionId,
        }))
      )
    }

    // 非读书模式的上下文注入：小号居中折叠行
    function ContextRow(props) {
      const [open, setOpen] = React.useState(false)
      const summary = firstLine(props.text)
      const toggle = () => setOpen((v) => !v)
      return React.createElement('div', { className: 'dsr-msg dsr-msg-context' },
        React.createElement('div', {
          className: 'dsr-think-head',
          role: 'button',
          tabIndex: 0,
          onClick: toggle,
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
        },
          React.createElement('span', { className: 'dsr-think-chevron', style: { transform: open ? 'rotate(90deg)' : 'none' } }, '▸'),
          React.createElement('span', { className: 'dsr-think-title' }, '上下文注入'),
          open ? null : React.createElement('span', { className: 'dsr-think-summary', title: summary }, summary)
        ),
        open ? React.createElement('div', { className: 'dsr-think-body' }, props.text) : null
      )
    }

    // ---------- 界面组件 ----------
    // 侧边栏底部与 Cordis Plugin 的全宽徽章同排，展开态下会被挤出容器；
    // 因此展开态不渲染（标题栏按钮是主入口），仅在窄条模式下显示图标入口。
    function SidebarButton(props) {
      const s = useReader()
      const wide = props && props.wide === true
      if (wide) return null
      return React.createElement('div', {
        className: 'dsr-sidebtn' + (s.active ? ' dsr-on' : ''),
        role: 'button',
        tabIndex: 0,
        title: s.active ? '退出读书模式' : '进入读书模式',
        onClick: () => store.set({ active: !s.active }),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            store.set({ active: !s.active })
          }
        },
      },
        React.createElement('svg', { className: 'dsr-sidebtn-icon', viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
          React.createElement('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          React.createElement('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' })
        )
      )
    }

    function HeaderActionButton() {
      const s = useReader()
      return React.createElement('div', {
        className: 'dsr-hdbtn' + (s.active ? ' dsr-hdbtn-on' : ''),
        role: 'button',
        tabIndex: 0,
        title: s.active ? '退出读书模式' : '进入读书模式',
        onClick: () => store.set({ active: !s.active }),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            store.set({ active: !s.active })
          }
        },
      },
        React.createElement('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true },
          React.createElement('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          React.createElement('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' })
        ),
        React.createElement('span', null, s.active ? '退出读书' : '读书模式')
      )
    }

    function HeaderBar() {
      const s = useReader()
      return React.createElement('div', { className: 'dsr-header' },
        React.createElement('span', { className: 'dsr-header-badge' }, '读书模式'),
        React.createElement('span', { className: 'dsr-header-doc', title: s.doc ? s.doc.title : '' }, s.doc ? s.doc.title : '未加载文档'),
        React.createElement('div', { className: 'dsr-header-actions' },
          React.createElement('button', { className: 'dsr-loadbtn', title: '打开本地 PDF / Markdown（直接本地打开，不占用上传）', onClick: () => chooseDocument() }, '打开本地文档'),
          React.createElement('button', {
            className: 'dsr-iconbtn',
            title: s.dialogue ? '收起对话，仅显示助手立绘' : '展开对话',
            onClick: () => store.set({ dialogue: !s.dialogue }),
          }, s.dialogue ? '仅立绘' : '对话'),
          React.createElement('button', {
            className: 'dsr-iconbtn dsr-exit',
            title: '退出读书模式',
            onClick: () => store.set({ active: false }),
          }, '退出')
        )
      )
    }

    function DocPane(props) {
      const doc = props.doc
      const s = useReader()
      const [drag, setDrag] = React.useState(false)
      const [frameReady, setFrameReady] = React.useState(false)
      const [savedDocs, setSavedDocs] = React.useState([])
      const docUrl = doc === null ? null : doc.url
      React.useEffect(() => { setFrameReady(false) }, [docUrl])
      // 空状态时加载最近打开的文档记录
      React.useEffect(() => {
        if (doc !== null) return
        let alive = true
        idbListDocs().then((list) => {
          if (!alive) return
          list.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
          setSavedDocs(list.slice(0, 3))
        })
        return () => { alive = false }
      }, [doc === null])
      const drop = (e) => {
        e.preventDefault()
        setDrag(false)
        const dt = e.dataTransfer
        if (dt && dt.files && dt.files.length) handleFiles(dt.files)
      }
      const onDropzoneKey = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseDocument() }
      }

      let inner = null
      if (doc === null) {
        inner = React.createElement('div', { className: 'dsr-doc-empty' },
          React.createElement('div', {
            className: 'dsr-dropzone',
            role: 'button',
            tabIndex: 0,
            title: '打开本地文件',
            onClick: () => chooseDocument(),
            onKeyDown: onDropzoneKey,
          },
            React.createElement('img', { className: 'dsr-drop-avatar', src: AVATAR2_SRC, alt: '学习助手', draggable: false }),
            React.createElement('div', { className: 'dsr-drop-title' }, drag ? '松开鼠标，开始阅读' : '把文档拖到这里'),
            React.createElement('div', { className: 'dsr-drop-sub' }, '支持 PDF / Markdown · 点击虚线框打开本地文件'),
            React.createElement('div', { className: 'dsr-drop-tip' }, '遇到不懂的知识点，截图粘贴给右侧的学习助手')
          ),
          savedDocs.length > 0
            ? React.createElement('div', { className: 'dsr-restore' },
                savedDocs.map((r) => React.createElement('div', { key: r.name, className: 'dsr-restore-row' },
                  React.createElement('button', { className: 'dsr-restore-btn', title: '重新打开此文件（需授权）', onClick: () => restoreDoc(r) }, '继续阅读《' + r.name + '》'),
                  React.createElement('button', {
                    className: 'dsr-restore-x',
                    title: '移除这条记录',
                    onClick: () => {
                      idbDeleteDoc(r.name)
                      setSavedDocs((cur) => cur.filter((x) => x.name !== r.name))
                    },
                  }, '✕')
                )))
            : null,
          React.createElement('input', {
            ref: (el) => { fallbackInputRef = el },
            type: 'file',
            accept: '.pdf,.md,.markdown,application/pdf,text/markdown',
            style: { display: 'none' },
            onChange: (e) => { handleFiles(e.target.files); e.target.value = '' },
          })
        )
      } else if (doc.kind === 'pdf') {
        const usePdfjs = s.cfg.pdfRenderer === 'pdfjs' && doc.file !== undefined && doc.file !== null
        inner = usePdfjs
          ? React.createElement(PdfJsReader, { file: doc.file, title: doc.title })
          : React.createElement(React.Fragment, null,
              React.createElement('iframe', { key: doc.url, className: 'dsr-doc-frame', src: doc.url, title: doc.title, onLoad: () => setFrameReady(true) }),
              frameReady ? null : React.createElement('div', { className: 'dsr-upload' },
                React.createElement('div', { className: 'dsr-upload-card' },
                  React.createElement('div', { className: 'dsr-upload-title' }, '正在渲染 PDF…')
                )
              )
            )
      } else {
        inner = React.createElement('div', { className: 'dsr-doc-md-scroll' },
          React.createElement('div', { className: 'dsr-doc-md-inner dsr-md', dangerouslySetInnerHTML: { __html: mdToHtmlCached(doc.text) } })
        )
      }

      return React.createElement('div', {
        className: 'dsr-doc' + (drag ? ' dsr-dragging' : ''),
        onDragOver: (e) => { e.preventDefault(); setDrag(true) },
        onDragLeave: () => setDrag(false),
        onDrop: drop,
      },
        inner,
        doc !== null && doc.kind === 'pdf'
          ? React.createElement('div', { className: 'dsr-pdf-switch' },
              React.createElement('button', {
                className: 'dsr-pdf-switch-btn',
                title: '两种渲染器读同一文件，可随时切换',
                onClick: () => settingsApply({ pdfRenderer: s.cfg.pdfRenderer === 'pdfjs' ? 'edge' : 'pdfjs' }),
              }, s.cfg.pdfRenderer === 'pdfjs' ? '当前：高级模式（页码）· 切换内置查看器' : '当前：内置查看器 · 切换高级模式（页码/进度）')
            )
          : null
      )
    }

    // ---------- 读书模式设置（宿主 settings.yaml 持久化） ----------
    let settingsSaveTimer = null
    let settingsPendingPatch = null
    const settingsSave = () => {
      if (settingsSaveTimer !== null) return
      settingsSaveTimer = setTimeout(async () => {
        settingsSaveTimer = null
        const patch = settingsPendingPatch
        settingsPendingPatch = null
        if (patch === null || patch === undefined) return
        const prev = state.cfg
        try {
          const res = await callJson('/__dsr_doc__/settings', { patch })
          if (res && res.ok === true && res.value && typeof res.value === 'object') {
            store.set({ cfg: Object.assign({}, state.cfg, res.value) })
          }
        } catch (e) {
          store.set({ cfg: prev, notice: '设置保存失败：' + ((e && e.message) ? e.message : String(e)) })
        }
      }, 350)
    }
    const settingsApply = (patch) => {
      store.set({ cfg: Object.assign({}, state.cfg, patch) })
      settingsPendingPatch = Object.assign({}, settingsPendingPatch, patch)
      settingsSave()
    }
    const settingsReset = async () => {
      const prev = state.cfg
      try {
        const res = await callJson('/__dsr_doc__/settings', { replace: true })
        if (res && res.ok === true && res.value && typeof res.value === 'object') {
          store.set({ cfg: Object.assign({}, state.cfg, res.value) })
        }
      } catch (e) {
        store.set({ cfg: prev, notice: '设置恢复失败：' + ((e && e.message) ? e.message : String(e)) })
      }
    }
    const settingsRefresh = async () => {
      try {
        const res = await getJson('/__dsr_doc__/settings')
        if (res && res.ok === true && res.value && typeof res.value === 'object') {
          store.set({ cfg: Object.assign({}, state.cfg, res.value) })
        }
      } catch (e) { /* 宿主未重启或路由不可用：保持默认 */ }
    }

    function SettingRow(props) {
      return React.createElement('label', { className: 'dsr-setting-row' },
        React.createElement('span', { className: 'dsr-setting-label' }, props.label),
        props.children,
        props.valueText !== undefined && props.valueText !== null
          ? React.createElement('span', { className: 'dsr-setting-value' }, props.valueText)
          : null
      )
    }

    function SettingsPanel() {
      const s = useReader()
      const cfg = s.cfg
      React.useEffect(() => { settingsRefresh() }, [])
      return React.createElement('div', { className: 'dsr-settings' },
        React.createElement('div', { className: 'dsr-settings-head' },
          React.createElement('span', { className: 'dsr-settings-title' }, '读书模式设置'),
          React.createElement('button', { className: 'dsr-iconbtn', title: '关闭设置', onClick: () => store.set({ settingsOpen: false }) }, '✕')
        ),
        React.createElement('div', { className: 'dsr-settings-body' },
          React.createElement(SettingRow, { label: '立绘大小', valueText: cfg.avatarSize + 'px' },
            React.createElement('input', {
              type: 'range', min: 60, max: 240, step: 4, value: cfg.avatarSize,
              onChange: (e) => settingsApply({ avatarSize: parseInt(e.target.value, 10) || 116 }),
            })
          ),
          React.createElement(SettingRow, { label: '对话面板宽度', valueText: cfg.panelWidth + 'px' },
            React.createElement('input', {
              type: 'range', min: 280, max: 560, step: 10, value: cfg.panelWidth,
              onChange: (e) => settingsApply({ panelWidth: parseInt(e.target.value, 10) || 380 }),
            })
          ),
          React.createElement(SettingRow, { label: '对话历史字号', valueText: cfg.chatFontSize + 'px' },
            React.createElement('input', {
              type: 'range', min: 11, max: 20, step: 1, value: cfg.chatFontSize,
              onChange: (e) => settingsApply({ chatFontSize: parseInt(e.target.value, 10) || 13 }),
            })
          ),
          React.createElement(SettingRow, { label: '显示立绘提示胶囊' },
            React.createElement('input', {
              type: 'checkbox', checked: cfg.showAvatarHint === true,
              onChange: (e) => settingsApply({ showAvatarHint: e.target.checked }),
            })
          ),
          React.createElement(SettingRow, { label: '截图识别结果默认展开' },
            React.createElement('input', {
              type: 'checkbox', checked: cfg.recognitionOpen === true,
              onChange: (e) => settingsApply({ recognitionOpen: e.target.checked }),
            })
          ),
          React.createElement(SettingRow, { label: 'PDF 渲染器' },
            React.createElement('div', { className: 'dsr-radio-row' },
              React.createElement('label', { className: 'dsr-radio' },
                React.createElement('input', { type: 'radio', name: 'pdfRenderer', checked: cfg.pdfRenderer === 'edge', onChange: () => settingsApply({ pdfRenderer: 'edge' }) }),
                React.createElement('span', null, '内置查看器')
              ),
              React.createElement('label', { className: 'dsr-radio' },
                React.createElement('input', { type: 'radio', name: 'pdfRenderer', checked: cfg.pdfRenderer === 'pdfjs', onChange: () => settingsApply({ pdfRenderer: 'pdfjs' }) }),
                React.createElement('span', null, '高级（页码）')
              )
            )
          )
        ),
        React.createElement('div', { className: 'dsr-settings-foot' },
          React.createElement('button', { className: 'dsr-iconbtn', title: '恢复默认值', onClick: settingsReset }, '恢复默认')
        )
      )
    }

    // ---------- 使用教程抽屉 ----------
    const HELP_ROWS = [
      ['📚', '打开本地文档', '点「打开本地文档」选择 PDF / Markdown（本地直接打开，不占上传、无大小限制），或把文件拖进阅读区。刷新后可在空状态一键「继续阅读」上次文档（首次需授权）。'],
      ['🖼', '截图提问', 'Win+Shift+S 截图 → 点通知里的「复制」→ 回到对话面板 Ctrl+V 粘贴（可附带文字问题）→ 点发送。视觉模型识别截图后，由主模型解答。快捷提示词（如「解释一下这段话」）点选后与输入文字一起提交。'],
      ['📋', '读剪贴板', '点「📋 读剪贴板」直接读取系统剪贴板中的截图（无需粘贴）。'],
      ['💬', '立绘与面板', '「✕」收起为立绘；点立绘重新展开；hover 立绘可滑出设置齿轮。'],
      ['🧾', '对话历史', '提问与回答以气泡展示；截图缩略图点击可看原图；「思考过程」与「截图识别结果」可展开查看。'],
      ['⚙', '设置', '立绘大小、面板宽度、字号、识别结果默认展开等，改动即时生效并持久保存。'],
    ]
    function HelpPanel() {
      return React.createElement('div', { className: 'dsr-settings dsr-help' },
        React.createElement('div', { className: 'dsr-settings-head' },
          React.createElement('span', { className: 'dsr-settings-title' }, '读书模式使用教程'),
          React.createElement('button', { className: 'dsr-iconbtn', title: '关闭教程', onClick: () => store.set({ helpOpen: false }) }, '✕')
        ),
        React.createElement('div', { className: 'dsr-help-body' },
          HELP_ROWS.map((row, i) => React.createElement('div', { key: i, className: 'dsr-help-row' },
            React.createElement('span', { className: 'dsr-help-icon' }, row[0]),
            React.createElement('div', { className: 'dsr-help-text' },
              React.createElement('div', { className: 'dsr-help-title' }, row[1]),
              React.createElement('div', { className: 'dsr-help-desc' }, row[2])
            )
          ))
        )
      )
    }

    // ---------- 历史问题索引抽屉 ----------
    function HistoryPanel(props) {
      const items = props.items || []
      const jumpTo = (key) => {
        store.set({ historyOpen: false, dialogue: true, jumpTo: key })
      }
      return React.createElement('div', { className: 'dsr-settings dsr-history' },
        React.createElement('div', { className: 'dsr-settings-head' },
          React.createElement('span', { className: 'dsr-settings-title' }, '历史问题'),
          React.createElement('button', { className: 'dsr-iconbtn', title: '关闭历史', onClick: () => store.set({ historyOpen: false }) }, '✕')
        ),
        React.createElement('div', { className: 'dsr-hist-body' },
          items.length === 0
            ? React.createElement('div', { className: 'dsr-hist-empty' }, '还没有提问记录。遇到不懂的，截图粘贴给学习助手吧。')
            : items.map((it, i) => {
                const q = it.user
                const qText = (q.text || '').trim() === '' ? '（截图提问）' : q.text
                const aText = it.answer === null ? '（等待回答…）' : (firstLine(it.answer.text) || '（无文字回答）').slice(0, 60)
                const firstAtt = q.images && q.images.length > 0 ? q.images[0] : null
                const localPrev = q.localImages && q.localImages.length > 0 ? q.localImages[0] : null
                return React.createElement('div', {
                  key: q.key + '-' + i,
                  className: 'dsr-hist-row',
                  title: '跳转到这条问答' + (q.page !== null && q.page !== undefined && q.page >= 1 ? '（并跳回第 ' + q.page + ' 页）' : ''),
                  onClick: () => {
                    jumpTo(q.key)
                    if (q.page !== null && q.page !== undefined && q.page >= 1) {
                      const st = state
                      if (st.doc !== null && st.doc !== undefined && st.doc.kind === 'pdf' && st.cfg.pdfRenderer === 'pdfjs') {
                        store.set({ jumpPage: q.page })
                      }
                    }
                  },
                },
                  firstAtt !== null
                    ? React.createElement('span', { style: { flex: 'none', display: 'flex' }, onClick: (e) => e.stopPropagation() },
                        React.createElement(ImageThumb, { attachment: firstAtt, sessionId: props.sessionId, small: true }))
                    : localPrev !== null
                      ? React.createElement('div', { className: 'dsr-hist-thumbbox' },
                          React.createElement('img', {
                            className: 'dsr-hist-thumb',
                            src: localPrev,
                            alt: '截图',
                            title: '点击查看大图',
                            onClick: (e) => { e.stopPropagation(); store.set({ imageViewer: localPrev }) },
                          }))
                      : React.createElement('div', { className: 'dsr-hist-thumbbox dsr-hist-nopic' }, '💬'),
                  React.createElement('div', { className: 'dsr-hist-text' },
                    React.createElement('div', { className: 'dsr-hist-q' },
                      q.page !== null && q.page !== undefined && q.page >= 1
                        ? React.createElement('button', {
                            className: 'dsr-hist-page',
                            title: '跳回第 ' + q.page + ' 页（需在高级模式打开对应文档）',
                            onClick: (e) => {
                              e.stopPropagation()
                              const st = state
                              if (st.doc === null || st.doc === undefined || st.doc.kind !== 'pdf' || st.cfg.pdfRenderer !== 'pdfjs') {
                                store.set({ notice: '跳页需要在「高级模式（页码）」下打开对应 PDF' })
                                return
                              }
                              store.set({ historyOpen: false, dialogue: true, jumpPage: q.page })
                            },
                          }, '📄 第 ' + q.page + ' 页')
                        : null,
                      qText
                    ),
                    React.createElement('div', { className: 'dsr-hist-meta' },
                      React.createElement('span', null, fmtClock(q.time || 0) || '—'),
                      React.createElement('span', { className: 'dsr-hist-a' }, aText)
                    )
                  )
                )
              })
        )
      )
    }

    // ---------- 图片查看浮层 ----------
    function ImageViewer() {
      const s = useReader()
      const url = s.imageViewer
      const close = () => store.set({ imageViewer: null })
      React.useEffect(() => {
        if (url === null || url === undefined) return
        const onKey = (e) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [url === null || url === undefined])
      if (url === null || url === undefined) return null
      return React.createElement('div', { className: 'dsr-viewer', onClick: close },
        React.createElement('img', { className: 'dsr-viewer-img', src: url, alt: '截图大图', onClick: (e) => e.stopPropagation() }),
        React.createElement('button', { className: 'dsr-viewer-x', title: '关闭', onClick: close }, '✕')
      )
    }

    function AvatarFloating() {
      const s = useReader()
      const cfg = s.cfg
      const [hover, setHover] = React.useState(false)
      // hover intent：离开后延迟 300ms 再收起，给鼠标跨过齿轮与立绘之间缝隙的时间
      const timerRef = React.useRef(null)
      React.useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current) }, [])
      const onEnter = () => {
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
        setHover(true)
      }
      const onLeave = () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { timerRef.current = null; setHover(false) }, 300)
      }
      return React.createElement('div', {
        className: 'dsr-avatar-float',
        title: '打开对话，粘贴截图提问',
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
        onClick: () => store.set({ dialogue: true }),
      },
        React.createElement('div', {
          className: 'dsr-avatar-gear' + (hover ? ' dsr-avatar-gear-show' : ''),
          role: 'button',
          tabIndex: 0,
          title: '读书模式设置',
          onClick: (e) => { e.stopPropagation(); store.set({ settingsOpen: true }) },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); store.set({ settingsOpen: true }) } },
        }, '⚙'),
        React.createElement('div', { className: 'dsr-avatar-float-bob' }, React.createElement(Avatar, { size: cfg.avatarSize })),
        cfg.showAvatarHint === true ? React.createElement('div', { className: 'dsr-avatar-hint' }, '遇到不懂的？点击问我') : null
      )
    }

    // 错误横幅：支持字符串或 { main, detail, raw } 结构，raw 部分折叠显示
    function ErrorBanner(props) {
      const e = props.error
      const obj = (typeof e === 'object' && e !== null) ? e : { main: String(e) }
      return React.createElement('div', { className: 'dsr-chat-error' },
        React.createElement('div', null, obj.main),
        obj.detail ? React.createElement('div', { className: 'dsr-chat-error-sub' }, obj.detail) : null,
        obj.raw ? React.createElement('details', { className: 'dsr-chat-error-details' },
          React.createElement('summary', null, '查看剪贴板内容'),
          React.createElement('pre', null, obj.raw)
        ) : null
      )
    }

    // 消息时间：今天只显示时分，跨天显示月-日 时:分
    function fmtClock(t) {
      const d = new Date(t)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => (n < 10 ? '0' + n : '' + n)
      const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
      const now = new Date()
      return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm
    }

    // 单条消息气泡：复制按钮 + 悬停时间 + 已停止标记
    function Bubble(props) {
      const m = props.m
      const isUser = m.kind === 'user'
      const [copied, setCopied] = React.useState(false)
      const copyTimer = React.useRef(null)
      React.useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current) }, [])
      const doCopy = () => {
        if (copied || m.text === undefined || m.text === null) return
        const text = String(m.text)
        let p
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          p = navigator.clipboard.writeText(text).then(() => true, () => false)
        } else {
          p = Promise.resolve(false)
        }
        p.then((ok) => {
          if (!ok) return
          setCopied(true)
          if (copyTimer.current !== null) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => setCopied(false), 1200)
        })
      }
      const timeText = typeof m.time === 'number' && m.time > 0 ? fmtClock(m.time) : ''
      const cls = 'dsr-msg ' + (isUser ? 'dsr-msg-user' : 'dsr-msg-assistant')
      return React.createElement('div', { className: cls, 'data-msg-key': m.key },
        m.interrupted === true ? React.createElement('span', { className: 'dsr-msg-stopped' }, '已停止') : null,
        React.createElement('div', { className: 'dsr-msg-meta' },
          timeText !== '' ? React.createElement('span', { className: 'dsr-msg-time' }, timeText) : null,
          m.text ? React.createElement('button', { type: 'button', className: 'dsr-msg-copy', title: copied ? '已复制' : '复制', onClick: doCopy },
            copied ? '✓' : React.createElement('svg', { viewBox: '0 0 24 24', width: 12, height: 12, 'aria-hidden': true },
              React.createElement('rect', { x: 8, y: 8, width: 12, height: 12, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
              React.createElement('path', { d: 'M4 15V5a2 2 0 0 1 2-2h10', fill: 'none', stroke: 'currentColor', strokeWidth: 2 })
            )) : null
        ),
        isUser && m.images && m.images.length > 0
          ? React.createElement(ImageThumbs, { images: m.images, sessionId: props.sessionId })
          : null,
        isUser && m.localImages && m.localImages.length > 0
          ? React.createElement('div', { className: 'dsr-user-imgs' },
              m.localImages.map((p, i) => React.createElement('img', {
                key: i,
                className: 'dsr-msg-img',
                src: p,
                alt: '截图',
                title: '点击查看大图',
                onClick: () => store.set({ imageViewer: p }),
              }))
            )
          : null,
        isUser && m.recognition
          ? React.createElement(ThinkRow, { text: m.recognition, label: '截图识别结果', defaultOpen: props.recognitionOpen === true })
          : null,
        !isUser && m.think && m.think.length > 0
          ? React.createElement('div', { className: 'dsr-think-stack' }, m.think.map((t, i) => React.createElement(ThinkRow, { key: i, text: t })))
          : null,
        !isUser && m.images && m.images.length > 0
          ? React.createElement(ImageThumbs, { images: m.images, sessionId: props.sessionId })
          : null,
        m.text ? React.createElement('div', { className: 'dsr-md', dangerouslySetInnerHTML: { __html: mdToHtmlCached(m.text) } }) : null
      )
    }

    function ChatPanel(props) {
      const [busy, setBusy] = React.useState(false)
      const [busyText, setBusyText] = React.useState('发送中…')
      const [error, setError] = React.useState(null)
      const [quick, setQuick] = React.useState('')
      const listRef = React.useRef(null)
      const s = useReader()
      const cfg = s.cfg
      // 草稿与截图预览提升到插件 store：切「仅立绘」再切回不丢失
      const draft = s.draft
      const image = s.draftImage
      const setDraft = (v) => store.set({ draft: v })
      const setImage = (v) => store.set({ draftImage: v })

      const msgs = props.messages || []
      const partial = props.partial || null
      const partialKey = props.partialKey || ''
      const running = props.running === true

      React.useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [msgs.length, partialKey, running])

      // 历史问题跳转：等面板展开动画完成（320ms）后滚动定位并高亮
      const jumpKey = s.jumpTo
      React.useEffect(() => {
        if (jumpKey === null || jumpKey === undefined) return
        const timer = setTimeout(() => {
          const el = listRef.current
          if (el !== null && el !== undefined) {
            let escaped = jumpKey
            try {
              if (typeof window.CSS === 'object' && typeof window.CSS.escape === 'function') escaped = window.CSS.escape(jumpKey)
            } catch (e) { /* ignore */ }
            const target = el.querySelector('[data-msg-key="' + escaped + '"]')
            if (target !== null) {
              if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'center' })
              target.classList.add('dsr-msg-flash')
              setTimeout(() => target.classList.remove('dsr-msg-flash'), 1600)
            }
          }
          store.set({ jumpTo: null })
        }, 320)
        return () => clearTimeout(timer)
      }, [jumpKey])

      const processImageFile = async (file) => {
        if (!/^image\//.test(String(file.type || ''))) {
          setError('只能粘贴图片（PNG / JPEG / WebP / GIF）')
          return
        }
        if (file.size > 20 * 1024 * 1024) {
          setError('图片过大（上限 20MB）')
          return
        }
        setError(null)
        const b64 = await fileToBase64(file)
        const mime = file.type || 'image/png'
        setImage({ name: file.name, type: mime, base64: b64, preview: 'data:' + mime + ';base64,' + b64 })
      }

      const pickFiles = (files) => {
        const f = files && files.length ? files[0] : null
        if (f === null) return
        processImageFile(f).catch((e) => setError('读取图片失败：' + ((e && e.message) ? e.message : String(e))))
      }

      const applyResolved = async (resolved) => {
        if (resolved === null || resolved === undefined) return
        if (resolved.kind === 'img') {
          setImage(resolved.img)
          setError(null)
          return
        }
        if (resolved.kind === 'blob') {
          const blob = resolved.blob
          await processImageFile(new File([blob], 'clipboard-screenshot.png', { type: blob.type || 'image/png' }))
        }
      }

      // 直接从系统剪贴板读取内存中的截图（Windows 截图未落盘的情况）
      const readClipboard = async () => {
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
            setError('浏览器不支持读取剪贴板，请直接 Ctrl+V 粘贴')
            return
          }
          const items = await navigator.clipboard.read()
          // 第一遍：找 image/* 类型
          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            const types = item && item.types ? item.types : []
            for (const t of types) {
              if (/^image\//.test(t)) {
                const blob = await item.getType(t)
                if (blob && blob.size > 0) {
                  await processImageFile(new File([blob], 'clipboard-screenshot.png', { type: t }))
                  return
                }
              }
            }
          }
          // 第二遍：从 text/html / text/plain 中提取图片
          const seenTypes = []
          let htmlSnippet = ''
          let textSnippet = ''
          const candidates = []
          const kinds = new Set()
          let lastErr = null
          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            const types = item && item.types ? item.types : []
            for (const t of types) seenTypes.push(t)
            if (types.indexOf('text/html') >= 0) {
              try {
                const blob = await item.getType('text/html')
                const html = await blob.text()
                htmlSnippet = String(html).replace(/\s+/g, ' ').slice(0, 400)
                for (const src of collectImageCandidates(html)) {
                  if (candidates.indexOf(src) < 0) candidates.push(src)
                }
              } catch (e) { /* ignore */ }
            }
            if (types.indexOf('text/plain') >= 0) {
              try {
                const blob = await item.getType('text/plain')
                const text = await blob.text()
                textSnippet = String(text).replace(/\s+/g, ' ').slice(0, 200)
                const tok = findAnyImageToken(text)
                if (tok && candidates.indexOf(tok) < 0) candidates.push(tok)
              } catch (e) { /* ignore */ }
            }
          }
          // 逐个尝试候选，全部失败再报错；记录失败类型以便给针对性提示
          for (let i = 0; i < candidates.length; i++) {
            try {
              const resolved = await resolvePastedImage(candidates[i])
              if (resolved !== null && resolved !== undefined) {
                await applyResolved(resolved)
                return
              }
            } catch (e) {
              lastErr = (e && e.message) ? e.message : String(e)
              if (e && e.kind) kinds.add(e.kind)
            }
          }
          const unique = Array.from(new Set(seenTypes)).join(', ') || '无'
          const raw = '剪贴板类型：' + unique +
            (htmlSnippet ? '\nHTML：' + htmlSnippet : '') +
            (textSnippet ? '\n文本：' + textSnippet : '')
          if (kinds.has('file')) {
            setError({
              main: '读到了截图，但它是本地文件引用（file://），浏览器安全策略禁止网页读取',
              detail: '这是 Edge「网页捕获」复制内容的常见形态。请改用 Win+Shift+S 截图 → 点击通知右下角的「复制」按钮 → 回来 Ctrl+V 粘贴；或把截图另存后用「🖼 截图」选择。',
              raw,
            })
            return
          }
          if (kinds.has('http')) {
            setError({
              main: lastErr || '剪贴板里的图片是网页链接，无法直接读取',
              detail: '请把图片另存到本地，再用「🖼 截图」选择。',
              raw,
            })
            return
          }
          if (lastErr) {
            setError({ main: lastErr, raw })
            return
          }
          setError({
            main: '剪贴板里没有图片（只有文字或网页内容）',
            detail: '如果刚按过 Win+Shift+S：截图会先出现在屏幕底部的通知里，请点通知右下角的「复制」按钮（或到 设置 → 截图工具 开启「截图后自动复制到剪贴板」），再回来按 Ctrl+V 粘贴。',
            raw,
          })
        } catch (e) {
          setError('读取剪贴板失败：' + ((e && e.message) ? e.message : String(e)) + '（可尝试直接 Ctrl+V 粘贴）')
        }
      }

      // 提交核心：question 为最终问题文本（快捷提示注入也走这里）
      const doSend = async (question) => {
        if (props.sessionId === undefined || props.sessionId === null) {
          setError('请先在左侧打开或新建一个会话，再提问。')
          return
        }
        setBusy(true)
        setBusyText(image !== null ? '识别截图中…' : '发送中…')
        setError(null)
        // 提问时阅读页码：仅 pdfjs 高级模式下有意义（用户正在看的那一页）
        const s0 = state
        const askPage = s0.doc !== null && s0.doc !== undefined && s0.doc.kind === 'pdf' &&
          s0.cfg.pdfRenderer === 'pdfjs' && Number.isSafeInteger(s0.pdfPage) && s0.pdfPage >= 1
          ? s0.pdfPage
          : null
        // 乐观渲染：提交瞬间先插一条本地用户气泡（真实节点投影到达后按文本去重替换）
        const pendingText = question === '' ? '（截图提问）' : question
        const pendingKey = 'p' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        const pendingEntry = {
          key: pendingKey,
          kind: 'user',
          text: pendingText,
          localImages: image !== null ? [image.preview] : [],
          time: Date.now(),
          page: askPage,
        }
        store.set({ pendingMsgs: state.pendingMsgs.concat([pendingEntry]) })
        let fullQuestion = question
        if (s0.doc) fullQuestion = '【读书模式 · 正在阅读《' + s0.doc.title + '》】\n' + fullQuestion
        const payload = { sessionId: props.sessionId, text: fullQuestion }
        if (image !== null) payload.image = { name: image.name, mediaType: image.type, base64: image.base64 }
        if (askPage !== null) payload.page = askPage
        try {
          const res = await callJson('/__dsr_doc__/ask', payload)
          if (res && res.ok === true) {
            store.set({ draft: '', draftImage: null })
            setQuick('')
          } else {
            store.set({ pendingMsgs: state.pendingMsgs.filter((p) => p.key !== pendingKey) })
            setError((res && res.error) ? res.error : '发送失败，请重试')
          }
        } catch (e) {
          store.set({ pendingMsgs: state.pendingMsgs.filter((p) => p.key !== pendingKey) })
          setError('发送失败：' + ((e && e.message) ? e.message : String(e)))
        } finally {
          setBusy(false)
        }
      }

      const send = async () => {
        const text = draft.trim()
        const hasQuick = quick !== ''
        if (text === '' && image === null && !hasQuick) return
        let question
        if (hasQuick) {
          question = text === '' ? quick : quick + '\n' + text
        } else {
          question = text === '' ? '（截图提问）' : text
        }
        await doSend(question)
      }

      // 快捷提示词：点选高亮（不写入文本框、不立即提交），
      // 点「发送」时与手写文字合并提交；截图自动附带
      const QUICK_PROMPTS = ['解释一下这段话', '这是为什么', '总结这段内容', '举个例子']

      const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          send()
        }
      }

      const onPaste = (e) => {
        const dt = e.clipboardData || (e.nativeEvent && e.nativeEvent.clipboardData)
        if (!dt) return
        const files = readClipboardFiles(dt)
        if (files.length > 0) {
          e.preventDefault()
          pickFiles(files)
          return
        }
        let html = ''
        try { html = dt.getData ? dt.getData('text/html') : '' } catch (err) { /* ignore */ }
        const candidates = collectImageCandidates(html)
        if (candidates.length === 0) return // 纯文本：走默认粘贴行为
        const src = candidates[0]
        // 本地文件 / 网页链接：不吞掉粘贴（文字仍会进入输入框），只给针对性提示
        if (/^file:/i.test(src)) {
          setError({
            main: '粘贴内容里的截图是本地文件引用（file://），浏览器禁止网页读取',
            detail: '请改用 Win+Shift+S 截图 → 点击通知右下角的「复制」→ 回来 Ctrl+V 粘贴；或把截图另存后用「🖼 截图」选择。',
            raw: 'src: ' + src.slice(0, 300),
          })
          return
        }
        if (/^https?:/i.test(src)) {
          setError({
            main: '粘贴内容里的图片是网页链接，无法直接读取',
            detail: '请把图片另存到本地，再用「🖼 截图」选择。',
            raw: 'src: ' + src.slice(0, 300),
          })
          return
        }
        e.preventDefault()
        resolvePastedImage(src).then((resolved) => applyResolved(resolved)).catch((err) => setError(((err && err.message) ? err.message : String(err))))
      }

      const bubbles = []
      const shown = msgs.slice(-80)
      for (const m of shown) {
        if (m.kind === 'turn-error') {
          bubbles.push(React.createElement('div', { key: m.key, className: 'dsr-msg dsr-msg-error' }, m.message))
          continue
        }
        if (m.kind === 'context') {
          bubbles.push(React.createElement(ContextRow, { key: m.key, text: m.text }))
          continue
        }
        bubbles.push(React.createElement(Bubble, { key: m.key, m, sessionId: props.sessionId, recognitionOpen: cfg.recognitionOpen === true }))
      }
      if (partial !== null && running) {
        bubbles.push(React.createElement('div', { key: 'dsr-partial', className: 'dsr-msg dsr-msg-assistant' },
          partial.think && partial.think.length > 0
            ? React.createElement('div', { className: 'dsr-think-stack' }, partial.think.map((t, i) => React.createElement(ThinkRow, { key: i, text: t, running: true })))
            : null,
          partial.text !== ''
            ? React.createElement('div', { className: 'dsr-md', dangerouslySetInnerHTML: { __html: mdToHtmlCached(partial.text) } })
            : null,
          React.createElement('span', { className: 'dsr-cursor' }, '▍')
        ))
      } else if (running) {
        bubbles.push(React.createElement('div', { key: 'dsr-running', className: 'dsr-msg dsr-msg-assistant' },
          React.createElement('div', { className: 'dsr-msg-running' }, '正在思考…')
        ))
      }

      const open = props.open === true
      return React.createElement('div', {
        className: 'dsr-chat' + (open ? ' dsr-chat-open' : ''),
        style: { width: open ? cfg.panelWidth : 0 },
        onPaste: onPaste,
      },
        React.createElement('div', { className: 'dsr-chat-inner', style: { width: cfg.panelWidth } },
        React.createElement('div', { className: 'dsr-chat-head' },
          React.createElement(Avatar, { size: 40 }),
          React.createElement('div', { className: 'dsr-chat-title' },
            React.createElement('div', { className: 'dsr-chat-name' }, '学习助手')
          ),
          React.createElement('button', {
            className: 'dsr-iconbtn',
            title: '历史问题（快速定位到之前的提问）',
            onClick: () => store.set({ historyOpen: !state.historyOpen, settingsOpen: false, helpOpen: false }),
          },
            React.createElement('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true },
              React.createElement('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
              React.createElement('path', { d: 'M12 7v5l3.5 2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' })
            )
          ),
          React.createElement('button', { className: 'dsr-iconbtn', title: '使用教程', onClick: () => store.set({ helpOpen: !state.helpOpen, settingsOpen: false, historyOpen: false }) }, '？'),
          React.createElement('button', { className: 'dsr-iconbtn', title: '读书模式设置', onClick: () => store.set({ settingsOpen: !state.settingsOpen, helpOpen: false, historyOpen: false }) }, '⚙'),
          React.createElement('button', { className: 'dsr-iconbtn', title: '收起为立绘', onClick: () => store.set({ dialogue: false }) }, '✕')
        ),
        React.createElement('div', { className: 'dsr-chat-list', ref: listRef, style: { fontSize: cfg.chatFontSize } },
          bubbles.length > 0 ? bubbles : React.createElement('div', { className: 'dsr-chat-empty' }, '向助手提问：输入问题，或直接粘贴 / 上传教材截图。')
        ),
        error !== null ? React.createElement(ErrorBanner, { error }) : null,
        React.createElement('div', { className: 'dsr-chat-input' },
          image !== null ? React.createElement('div', { className: 'dsr-preview' },
            React.createElement('img', { src: image.preview, alt: '截图预览' }),
            React.createElement('button', { className: 'dsr-preview-x', title: '移除截图', onClick: () => setImage(null) }, '✕')
          ) : null,
          React.createElement('textarea', {
            className: 'dsr-chat-ta',
            rows: 3,
            placeholder: '输入问题…（Enter 发送，Shift+Enter 换行）',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown,
          }),
          React.createElement('div', { className: 'dsr-quick-row' },
            QUICK_PROMPTS.map((p) => React.createElement('button', {
              key: p,
              type: 'button',
              className: 'dsr-quickchip' + (quick === p ? ' dsr-quickchip-on' : ''),
              title: '选中「' + p + '」，点发送时与输入文字一并提交（截图自动附带）',
              disabled: busy,
              onClick: () => setQuick((cur) => (cur === p ? '' : p)),
            }, p))
          ),
          React.createElement('div', { className: 'dsr-chat-row' },
            React.createElement('label', { className: 'dsr-chipbtn dsr-chipbtn-icon', title: '选择截图文件' },
              React.createElement('input', {
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp,image/gif',
                style: { display: 'none' },
                onChange: (e) => { pickFiles(e.target.files); e.target.value = '' },
              }),
              React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true },
                React.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
                React.createElement('circle', { cx: 8.5, cy: 8.5, r: 1.6, fill: 'currentColor' }),
                React.createElement('path', { d: 'M4 17l5.2-5.2a1.5 1.5 0 0 1 2.1 0L16 16.5M14.5 14.5L16 13a1.5 1.5 0 0 1 2.1 0L20.5 15', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' })
              )
            ),
            React.createElement('button', {
              className: 'dsr-chipbtn dsr-chipbtn-icon',
              type: 'button',
              title: '读取系统剪贴板中的截图（Win+Shift+S 截图后需点通知里的「复制」才会进剪贴板）',
              onClick: readClipboard,
            },
              React.createElement('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true },
                React.createElement('rect', { x: 5, y: 4, width: 14, height: 17, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
                React.createElement('path', { d: 'M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 })
              )
            ),
            React.createElement('span', { className: 'dsr-chat-hint' }, 'Ctrl+V 粘贴'),
            React.createElement('div', { style: { flex: 1 } }),
            busy
              ? React.createElement('button', {
                  className: 'dsr-send dsr-send-stop',
                  title: '停止生成',
                  onClick: () => cancelSession(props.sessionId),
                }, '停止')
              : React.createElement('button', {
                  className: 'dsr-send',
                  disabled: draft.trim() === '' && image === null && quick === '',
                  onClick: send,
                }, '发送')
          )
        )
        )
      )
    }

    // 流式快照节流门（单 Reader 实例）
    const snapGate = { version: 0, lastTime: 0, latest: undefined, wasRunning: false }
    function snapGateUse(useSession) {
      useSession((x) => {
        const now = typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now()
        snapGate.latest = x // 引用始终跟进，渲染是否发生由 version 决定
        const force = x.running !== snapGate.wasRunning
        snapGate.wasRunning = x.running
        // 仅流式期间节流；空闲快照（收尾节点投影等）立即渲染，
        // 避免最终消息节点在节流窗口内到达被吞掉 → 输出内容消失
        if (force || !x.running || now - snapGate.lastTime >= 120) {
          snapGate.version += 1
          snapGate.lastTime = now
        }
        return snapGate.version
      })
      return snapGate.latest
    }

    function Reader(props) {
      const s = useReader()
      const sessionId = props.sessionId
      // 流式快照节流：思考/工具输出的每个增量都更新快照，全量订阅会每 chunk 重渲染
      // 整个对话树（历史气泡全部重新解析 markdown）→ 长输出时浏览器假死。
      // 这里用「版本号门」把渲染频率压到约 8 次/秒；running 状态翻转立即放行。
      if (typeof props.useSession !== 'function') return null
      const snap = snapGateUse(props.useSession)
      const derived = React.useMemo(() => deriveMessages(snap), [snap])
      // 乐观气泡与真实节点合并：pending 放在末尾（最新）；真实节点到达后按文本去重
      const messages = React.useMemo(() => {
        const pending = Array.isArray(s.pendingMsgs) ? s.pendingMsgs : []
        if (pending.length === 0) return derived
        const texts = new Set()
        for (const m of derived) if (m.kind === 'user') texts.add(m.text)
        const active = pending.filter((p) => !texts.has(p.text))
        return derived.concat(active)
      }, [derived, s.pendingMsgs])
      // 清理已被真实节点替换的 pending（store 写入放 effect，避免渲染期写 store）
      React.useEffect(() => {
        const pending = Array.isArray(s.pendingMsgs) ? s.pendingMsgs : []
        if (pending.length === 0) return
        const texts = new Set()
        for (const m of derived) if (m.kind === 'user') texts.add(m.text)
        const active = pending.filter((p) => !texts.has(p.text))
        if (active.length !== pending.length) store.set({ pendingMsgs: active })
      }, [derived, s.pendingMsgs])
      const partial = React.useMemo(() => partialView(snap), [snap])
      // 历史问题索引：问题-回答配对（最新在前，最多 60 条）
      const historyItems = React.useMemo(() => {
        const items = []
        let lastUser = null
        for (const m of messages) {
          if (m.kind === 'user') {
            lastUser = m
          } else if (m.kind === 'assistant' && lastUser !== null) {
            items.push({ user: lastUser, answer: m })
            lastUser = null
          }
        }
        if (lastUser !== null) items.push({ user: lastUser, answer: null })
        return items.slice(-60).reverse()
      }, [messages])
      let partialKey = ''
      if (partial !== null) {
        partialKey = partial.text.length + ':' + partial.think.reduce((n, t) => n + t.length, 0)
      }
      const running = snap ? snap.running === true : false

      return React.createElement('div', { className: 'dsr-root' },
        React.createElement(HeaderBar, null),
        s.perfWarn !== null && s.perfWarn !== undefined
          ? React.createElement('div', { className: 'dsr-notice dsr-notice-perf' },
              '⚠ 检测到主线程卡顿 ' + s.perfWarn.duration + 'ms（' + s.perfWarn.at + '）。请把这条信息反馈给开发者。',
              React.createElement('button', { className: 'dsr-notice-x', onClick: () => store.set({ perfWarn: null }) }, '✕')
            )
          : null,
        s.notice ? React.createElement('div', { className: 'dsr-notice' }, s.notice) : null,
        React.createElement('div', { className: 'dsr-main' },
          React.createElement('div', { className: 'dsr-body' },
            React.createElement(DocPane, { doc: s.doc }),
            React.createElement(ChatPanel, { open: s.dialogue, sessionId, messages, partial, partialKey, running }),
            s.dialogue ? null : React.createElement(AvatarFloating, null)
          ),
          s.settingsOpen ? React.createElement(SettingsPanel, null) : null,
          s.helpOpen ? React.createElement(HelpPanel, null) : null,
          s.historyOpen ? React.createElement(HistoryPanel, { items: historyItems, sessionId }) : null
        ),
        React.createElement(ImageViewer, null)
      )
    }

    // ---------- 样式 ----------
    const CSS = [
      '.dsr-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#f9fafb);color:var(--dsw-alias-label-primary,#0f1115);overflow:hidden;font-family:inherit;position:relative}',
      '.dsr-header{flex:none;display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dsr-header-badge{font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary,#3964fe);border:1px solid var(--dsw-alias-brand-primary,#3964fe);border-radius:8px;padding:2px 8px;white-space:nowrap}',
      '.dsr-header-doc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsr-header-actions{display:flex;align-items:center;gap:8px}',
      '.dsr-loadbtn{display:inline-flex;align-items:center;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-size:12px;cursor:pointer}',
      '.dsr-loadbtn:hover{border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-loadbtn-lg{padding:10px 18px;font-size:13px;font-weight:600}',
      '.dsr-iconbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;cursor:pointer}',
      '.dsr-iconbtn:hover{color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-exit:hover{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsr-notice{flex:none;padding:6px 16px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#b26a00);background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/4%));border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-notice-perf{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsr-notice-x{flex:none;margin-left:auto;border:none;background:none;color:inherit;cursor:pointer;font-size:12px;padding:0 4px}',
      '.dsr-main{flex:1;min-height:0;display:flex;position:relative}',
      '.dsr-body{flex:1;min-height:0;min-width:0;display:flex;position:relative}',
      '.dsr-doc{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-base,#f9fafb)}',
      '.dsr-doc-frame{flex:1;width:100%;border:0}',
      '.dsr-doc-md-scroll{overflow:auto}',
      '.dsr-doc-md-inner{max-width:860px;margin:0 auto;padding:36px 48px 96px}',
      '.dsr-md{line-height:1.75;font-size:14px;word-break:break-word}',
      '.dsr-md h1,.dsr-md h2,.dsr-md h3,.dsr-md h4,.dsr-md h5,.dsr-md h6{margin:1.3em 0 .5em;line-height:1.3;font-weight:600}',
      '.dsr-md h1{font-size:1.7em;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));padding-bottom:.3em}',
      '.dsr-md h2{font-size:1.4em}',
      '.dsr-md h3{font-size:1.18em}',
      '.dsr-md p{margin:.55em 0}',
      '.dsr-md code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:.88em;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%));padding:1px 5px;border-radius:4px}',
      '.dsr-md pre{background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%));border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));border-radius:10px;padding:12px 14px;overflow:auto;margin:.8em 0}',
      '.dsr-md pre code{background:none;padding:0;border:none}',
      '.dsr-md blockquote{border-left:3px solid var(--dsw-alias-brand-primary,#3964fe);margin:.8em 0;padding:2px 14px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:0 8px 8px 0}',
      '.dsr-md ul,.dsr-md ol{margin:.5em 0;padding-left:1.7em}',
      '.dsr-md li{margin:.2em 0}',
      '.dsr-md a{color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));margin:1.2em 0}',
      '.dsr-md img{max-width:100%}',
      '.dsr-md table{border-collapse:collapse;margin:.8em 0;display:block;overflow-x:auto;max-width:100%}',
      '.dsr-md th,.dsr-md td{border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));padding:5px 10px;font-size:.92em;text-align:left;word-break:break-word;min-width:48px}',
      '.dsr-md th{background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/4%));font-weight:600}',
      '.dsr-msg-user .dsr-md th,.dsr-msg-user .dsr-md td{border-color:rgb(22 48 95/18%)}',
      '.dsr-msg-user .dsr-md th{background:rgb(22 48 95/6%)}',
      '.dsr-chat-list .dsr-msg{font-size:1em}',
      '.dsr-chat-list .dsr-md{font-size:1em;line-height:1.7}',
      '.dsr-chat-list .dsr-think-head{font-size:.88em}',
      '.dsr-chat-list .dsr-think-body{font-size:.92em}',
      '.dsr-chat-list .dsr-think-summary{font-size:1em}',
      '.dsr-chat-list .dsr-imgchip{font-size:.9em}',
      '.dsr-doc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px;text-align:center}',
      '.dsr-dropzone{display:flex;flex-direction:column;align-items:center;gap:8px;border:2px dashed var(--dsw-alias-border-l2,rgb(0 0 0/18%));border-radius:20px;padding:30px 56px;cursor:pointer;background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .18s ease,background .18s ease,transform .18s ease,box-shadow .18s ease;max-width:92%;box-sizing:border-box}',
      '.dsr-dropzone:hover{border-color:var(--dsw-alias-brand-primary,#3964fe);box-shadow:0 6px 24px rgb(0 0 0/8%)}',
      '.dsr-dragging .dsr-dropzone{border-color:var(--dsw-alias-brand-primary,#3964fe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 7%,var(--dsw-alias-bg-layer-1,#fff));transform:scale(1.02);box-shadow:0 10px 32px rgb(0 0 0/12%)}',
      '.dsr-drop-avatar{width:170px;height:auto;display:block;filter:drop-shadow(0 8px 18px rgb(0 0 0/14%));user-select:none;pointer-events:none}',
      '.dsr-drop-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dsr-drop-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsr-drop-tip{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:320px;line-height:1.6}',
      '.dsr-restore{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
      '.dsr-restore-row{display:flex;align-items:center;gap:8px;justify-content:center}',
      '.dsr-restore-btn{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;border-radius:999px;padding:4px 14px;cursor:pointer;font-family:inherit}',
      '.dsr-restore-btn:hover{color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-restore-x{flex:none;width:20px;height:20px;border:none;border-radius:50%;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/6%));color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:10px;cursor:pointer}',
      '.dsr-avatar-float{position:absolute;top:18px;right:18px;z-index:5;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;background:none;border:none;padding:0;box-shadow:none;animation:dsr-avatar-in .22s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)) .06s backwards}',
      '@keyframes dsr-avatar-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.dsr-avatar-float-bob{animation:dsr-bob 3.2s ease-in-out infinite;filter:drop-shadow(0 10px 20px rgb(0 0 0/22%))}',
      '.dsr-avatar-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 74%,transparent);border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/8%));border-radius:999px;padding:2px 12px;backdrop-filter:blur(3px);box-shadow:0 2px 8px rgb(0 0 0/10%)}',
      '.dsr-avatar-gear{position:absolute;left:-30px;top:50%;transform:translate(10px,-50%);width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));box-shadow:0 4px 14px rgb(0 0 0/14%);font-size:14px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:6}',
      '.dsr-avatar-gear-show{opacity:1;pointer-events:auto;transform:translate(0,-50%)}',
      '.dsr-avatar-gear:hover{color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-settings{position:relative;flex:none;width:320px;max-width:92vw;z-index:40;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-left:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));box-shadow:-12px 0 32px rgb(0 0 0/12%);animation:dsr-settings-in .22s ease}',
      '@keyframes dsr-settings-in{from{transform:translateX(100%)}to{transform:translateX(0)}}',
      '.dsr-settings-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-settings-title{font-size:13px;font-weight:600}',
      '.dsr-settings-body{flex:1;min-height:0;overflow-y:auto;padding:6px 14px;display:flex;flex-direction:column}',
      '.dsr-setting-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/6%))}',
      '.dsr-setting-label{flex:none;width:118px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsr-setting-row input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-setting-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#3964fe);cursor:pointer}',
      '.dsr-setting-value{flex:none;min-width:44px;text-align:right;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',
      '.dsr-radio-row{flex:1;display:flex;gap:14px}',
      '.dsr-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.dsr-radio input{accent-color:var(--dsw-alias-brand-primary,#3964fe);cursor:pointer}',
      '.dsr-pdfjs{flex:1;min-width:0;display:flex;flex-direction:column;background:#525659;position:relative}',
      '.dsr-pdfjs-restorenote{position:absolute;top:46px;left:50%;transform:translateX(-50%);z-index:30;background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-secondary,#61666b);border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));border-radius:999px;padding:4px 14px;font-size:12px;box-shadow:0 2px 10px rgb(0 0 0/12%);pointer-events:none;white-space:nowrap}',
      '.dsr-pdfjs-bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-pdfjs-btn{width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;justify-content:center}',
      '.dsr-pdfjs-btn:hover{color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-pdfjs-page{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsr-pdfjs-pageinput{width:52px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));border-radius:7px;font-size:12px;text-align:center;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);font-family:inherit}',
      '.dsr-pdfjs-pageinput:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-hist-page{flex:none;display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 6%,transparent);border-radius:999px;font-size:10.5px;padding:0 8px;line-height:1.7;cursor:pointer;font-family:inherit;margin-right:6px}',
      '.dsr-hist-page:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 12%,transparent)}',
      '.dsr-pdfjs-sep{flex:1}',
      '.dsr-pdfjs-scroll{flex:1;min-height:0;overflow:auto}',
      '.dsr-pdfjs-host{position:absolute;inset:0;overflow:auto}',
      '.dsr-pdfjs-viewer{min-height:100%}',
      '.dsr-pdfjs-hostwrap{position:relative;flex:1;min-height:0;overflow:hidden}',
      '.dsr-pdf-page{display:flex;justify-content:center;overflow:hidden;background:#f2f2f2;margin-bottom:6px}',
      '.dsr-pdf-canvas{display:block;box-shadow:0 2px 10px rgb(0 0 0/18%)}',
      '.dsr-pdf-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:#e8eaed;background:rgb(60 63 66/92%);z-index:5}',
      '.dsr-pdfjs-err{flex:none;padding:5px 14px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsr-pdf-switch{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:6}',
      '.dsr-pdf-switch-btn{border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/14%));border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font-size:11.5px;padding:5px 14px;cursor:pointer;box-shadow:0 4px 16px rgb(0 0 0/14%);font-family:inherit;white-space:nowrap}',
      '.dsr-pdf-switch-btn:hover{color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-settings-foot{flex:none;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));display:flex;justify-content:flex-end}',
      '.dsr-help-body{flex:1;min-height:0;overflow-y:auto;padding:6px 14px;display:flex;flex-direction:column}',
      '.dsr-help-row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/6%))}',
      '.dsr-help-icon{flex:none;font-size:15px;line-height:1.4}',
      '.dsr-help-text{flex:1;min-width:0}',
      '.dsr-help-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dsr-help-desc{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#61666b);margin-top:2px}',
      '.dsr-hist-body{flex:1;min-height:0;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column}',
      '.dsr-hist-empty{margin:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);text-align:center;line-height:1.7;padding:20px}',
      '.dsr-hist-row{display:flex;gap:10px;padding:8px 4px;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/6%));cursor:pointer;align-items:flex-start;border-radius:8px}',
      '.dsr-hist-row:hover{background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/3%))}',
      '.dsr-hist-thumbbox{flex:none;width:44px;height:44px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%));display:flex;align-items:center;justify-content:center;font-size:14px}',
      '.dsr-hist-thumb{width:44px;height:44px;object-fit:cover;display:block;max-width:none;max-height:none}',
      '.dsr-hist-nopic{color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dsr-hist-text{flex:1;min-width:0}',
      '.dsr-hist-q{font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;word-break:break-word}',
      '.dsr-hist-meta{margin-top:3px;display:flex;gap:6px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);min-width:0}',
      '.dsr-hist-a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsr-msg-flash{animation:dsr-flash 1.6s ease}',
      '@keyframes dsr-flash{0%{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#3964fe)}30%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 16%,transparent)}100%{box-shadow:none}}',
      '.dsr-viewer{position:fixed;inset:0;z-index:120;background:rgb(0 0 0/72%);display:flex;align-items:center;justify-content:center;animation:dsr-viewer-in .18s ease}',
      '@keyframes dsr-viewer-in{from{opacity:0}to{opacity:1}}',
      '.dsr-viewer-img{max-width:90vw;max-height:86vh;border-radius:10px;box-shadow:0 18px 60px rgb(0 0 0/45%);display:block}',
      '.dsr-viewer-x{position:absolute;top:16px;right:20px;width:34px;height:34px;border:none;border-radius:50%;background:rgb(255 255 255/16%);color:#fff;font-size:15px;cursor:pointer;font-family:inherit}',
      '.dsr-viewer-x:hover{background:rgb(255 255 255/30%)}',
      '@keyframes dsr-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
      '.dsr-chat{flex:none;width:380px;max-width:92vw;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));background:var(--dsw-alias-bg-layer-1,#fff);min-height:0;overflow:hidden;transition:width .28s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}',
      '.dsr-chat:not(.dsr-chat-open){border-left-color:transparent}',
      '.dsr-chat-inner{flex:none;display:flex;flex-direction:column;height:100%;min-width:0}',
      '.dsr-chat-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-chat-title{flex:1;min-width:0}',
      '.dsr-chat-name{font-size:13px;font-weight:600}',
      '.dsr-chat-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 12px;display:flex;flex-direction:column;gap:10px}',
      '.dsr-chat-empty{margin:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);text-align:center;line-height:1.7}',
      '.dsr-msg{max-width:92%;border-radius:12px;padding:8px 12px;font-size:13px;position:relative}',
      '.dsr-msg-user{align-self:flex-end;background:#e8f0fe;color:#16305f;border:1px solid #bcd0ff;border-bottom-right-radius:4px}',
      '.dsr-msg-user .dsr-md code{background:rgb(22 48 95/8%);color:#16305f}',
      '.dsr-msg-user .dsr-md a{color:#0b57d0;text-decoration:underline}',
      '.dsr-msg-user .dsr-think-head{color:#5b6b8c}',
      '.dsr-msg-user .dsr-think-body{color:#5b6b8c}',
      '.dsr-msg-user .dsr-think-running{color:#0b57d0}',
      '.dsr-msg-user .dsr-msg-img{border-color:rgb(22 48 95/15%)}',
      '.dsr-msg-user .dsr-img-placeholder{background:rgb(22 48 95/8%)}',
      '.dsr-msg-assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/4%));border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/8%));border-bottom-left-radius:4px}',
      '.dsr-msg-running{color:var(--dsw-alias-label-secondary,#61666b);font-size:12px}',
      '.dsr-cursor{display:inline-block;color:var(--dsw-alias-brand-primary,#3964fe);animation:dsr-blink 1s steps(2) infinite;margin-left:2px}',
      '@keyframes dsr-blink{50%{opacity:0}}',
      '.dsr-imgchip{display:inline-flex;align-items:center;gap:4px;font-size:12px;background:rgb(255 255 255/18%);border-radius:8px;padding:3px 8px;margin-bottom:6px}',
      '.dsr-think-stack{display:flex;flex-direction:column;gap:2px;margin-bottom:6px;min-width:0}',
      '.dsr-think{min-width:0}',
      '.dsr-think-head{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;user-select:none;padding:2px 0;min-width:0}',
      '.dsr-think-chevron{display:inline-block;transition:transform .15s ease;font-size:10px;flex:none}',
      '.dsr-think-title{flex:none}',
      '.dsr-think-running{font-size:10px;color:var(--dsw-alias-brand-primary,#3964fe);flex:none}',
      '.dsr-think-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.85}',
      '.dsr-think-body{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#8a8f98);padding:4px 0 2px 12px}',
      '.dsr-user-imgs{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin-bottom:6px}',
      '.dsr-msg-assistant .dsr-user-imgs{justify-content:flex-start}',
      '.dsr-msg-img{max-width:170px;max-height:130px;border-radius:10px;border:1px solid rgb(255 255 255/35%);display:block;cursor:zoom-in}',
      '.dsr-msg-assistant .dsr-msg-img{border-color:var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-img-placeholder{width:48px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:rgb(255 255 255/18%);font-size:14px}',
      '.dsr-msg-assistant .dsr-img-placeholder{background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%))}',
      '.dsr-msg-meta{position:absolute;top:4px;right:6px;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .15s ease}',
      '.dsr-msg:hover .dsr-msg-meta{opacity:1}',
      '.dsr-msg-time{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}',
      '.dsr-msg-copy{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;font-size:11px;box-shadow:0 1px 4px rgb(0 0 0/12%)}',
      '.dsr-msg-user .dsr-msg-copy{color:#16305f}',
      '.dsr-msg-copy:hover{color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-msg-stopped{position:absolute;top:5px;left:10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%));border-radius:6px;padding:0 6px;line-height:1.6}',
      '.dsr-msg-user .dsr-msg-stopped{background:rgb(22 48 95/8%);color:#5b6b8c}',
      '.dsr-msg-context{align-self:center;max-width:88%;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/4%));border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/8%));border-radius:10px;padding:2px 10px 4px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dsr-msg-error{align-self:center;max-width:88%;background:rgb(229 72 77/8%);color:var(--dsw-alias-state-error-primary,#e5484d);border-radius:10px;padding:4px 10px;font-size:12px}',
      '.dsr-chat-error{flex:none;padding:6px 14px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/4%));border-top:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%))}',
      '.dsr-chat-error-sub{margin-top:3px;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsr-chat-error-details{margin-top:5px;font-size:11px}',
      '.dsr-chat-error-details summary{cursor:pointer;color:var(--dsw-alias-brand-primary,#3964fe);user-select:none}',
      '.dsr-chat-error-details pre{max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-base,#f9fafb);border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));border-radius:8px;padding:6px 8px;margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:1.5}',
      '.dsr-chat-input{flex:none;border-top:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.dsr-chat-ta{width:100%;resize:none;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));border-radius:10px;padding:8px 10px;font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-base,#f9fafb);color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;box-sizing:border-box}',
      '.dsr-chat-ta:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-chat-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsr-chipbtn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;background:var(--dsw-alias-bg-layer-1,#fff);font-family:inherit}',
      '.dsr-chipbtn:hover{color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-chipbtn-icon{padding:5px 8px}',
      '.dsr-chipbtn-icon svg{display:block}',
      '.dsr-chat-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsr-quick-row{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsr-quickchip{flex:none;display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/12%));background:var(--dsw-alias-bg-base,#f9fafb);color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;cursor:pointer;font-family:inherit}',
      '.dsr-quickchip:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 6%,var(--dsw-alias-bg-base,#f9fafb))}',
      '.dsr-quickchip-on{background:#3964fe;color:#fff;border-color:#3964fe}',
      '.dsr-quickchip-on:hover:not(:disabled){color:#fff;border-color:#3964fe;background:#3964fe}',
      '.dsr-quickchip:disabled{opacity:.5;cursor:not-allowed}',
      '.dsr-send{padding:6px 16px;border:none;border-radius:8px;background:#3964fe;color:#fff;font-size:12px;font-weight:600;cursor:pointer}',
      '.dsr-send-stop{background:#e5484d}',
      '.dsr-send-stop:hover{opacity:.9}',
      '.dsr-send:hover{opacity:.9}',
      '.dsr-send:disabled{opacity:.45;cursor:not-allowed}',
      '.dsr-preview{position:relative;display:inline-block;align-self:flex-start}',
      '.dsr-preview img{max-width:220px;max-height:160px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));display:block}',
      '.dsr-preview-x{position:absolute;top:-8px;right:-8px;width:20px;height:20px;border-radius:50%;border:none;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font-size:11px;line-height:1;cursor:pointer}',
      '.dsr-upload{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-bg-base,#f9fafb) 90%, transparent);padding:24px}',
      '.dsr-upload-card{display:flex;flex-direction:column;gap:10px;align-items:center;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));border-radius:14px;padding:22px 28px;box-shadow:0 10px 30px rgb(0 0 0/10%);min-width:280px;max-width:70%}',
      '.dsr-upload-title{font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsr-upload-bar{width:100%;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/8%));overflow:hidden}',
      '.dsr-upload-fill{height:100%;background:var(--dsw-alias-brand-primary,#3964fe);border-radius:3px;transition:width .15s ease;animation:dsr-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsr-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.dsr-upload-pct{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}',
      '.dsr-sidebtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:8px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;box-sizing:border-box;user-select:none}',
      '.dsr-sidebtn:hover{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%))}',
      '.dsr-sidebtn.dsr-on{color:var(--dsw-alias-brand-primary,#3964fe);background:var(--dsw-alias-bg-layer-2,rgb(0 0 0/5%))}',
      '.dsr-sidebtn-icon{flex:none}',
      '.dsr-avatar{flex:none;user-select:none}',
      '.dsr-hdbtn{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgb(0 0 0/10%));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}',
      '.dsr-hdbtn:hover{color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
      '.dsr-hdbtn-on{color:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe)}',
    ].join('\n')

    // ---------- 插件装配 ----------
    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 启动即拉取一次设置（否则刷新后先用默认值渲染，开设置面板才更新）
      settingsRefresh()

      // 用 timer 服务实现「让出事件循环」，使回退通道的分块编码能实时刷新进度
      const timer = ctx.get('timer')
      if (timer !== undefined) yieldNow = () => timer.timeout(0)

      // 长任务自诊断：主线程卡顿 > 400ms 时在面板顶部显示横幅（无需控制台）
      let longTaskObserver = null
      try {
        if (typeof PerformanceObserver === 'function') {
          longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration > 400) {
                store.set({
                  perfWarn: {
                    duration: Math.round(entry.duration),
                    at: new Date().toLocaleTimeString(),
                  },
                })
              }
            }
          })
          try { longTaskObserver.observe({ entryTypes: ['longtask'] }) } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      if (longTaskObserver !== null) {
        ctx.effect(() => () => { try { longTaskObserver.disconnect() } catch (e) { /* ignore */ } })
      }

      // 历史截图读取：先走默认同源通道（sessions.readAttachment），
      // 失败则回退读书模式自己的附件路由（插件保存的截图不经会话附件注册）
      const sessions = ctx.get('sessions')
      if (sessions !== undefined) {
        cancelSession = (sessionId) => {
          try {
            const binding = sessions.binding(sessionId)
            if (binding !== undefined && binding.session && typeof binding.session.cancel === 'function') {
              binding.session.cancel().catch(() => {})
            }
          } catch (e) { /* ignore */ }
        }
      }
      const imageCache = new Map()
      const toImageUrl = async (mediaType, bytes) => {
        if (typeof URL.createObjectURL === 'function') {
          return URL.createObjectURL(new Blob([bytes.buffer], { type: mediaType }))
        }
        return 'data:' + mediaType + ';base64,' + await bytesToBase64(bytes)
      }
      loadAttachmentImage = (sessionId, attachment) => {
        if (attachment === null || attachment === undefined || typeof attachment.attachmentId !== 'string') {
          return Promise.reject(new Error('无效的截图引用'))
        }
        const key = sessionId + ':' + attachment.attachmentId
        const hit = imageCache.get(key)
        if (hit !== undefined) return hit
        const pending = (async () => {
          let lastErr = null
          if (sessions !== undefined) {
            try {
              const binding = sessions.binding(sessionId)
              if (binding !== undefined && binding.session) {
                const result = await binding.session.readAttachment(attachment.attachmentId)
                if (result !== undefined && result !== null && result.ok === true) {
                  const att = result.value && result.value.attachment
                  const data = result.value && result.value.data
                  const mediaType = (att && att.mediaType) ? att.mediaType : 'image/png'
                  return await toImageUrl(mediaType, data instanceof Uint8Array ? data : Uint8Array.from(data))
                }
                lastErr = new Error('会话附件读取失败')
              } else {
                lastErr = new Error('会话不可用')
              }
            } catch (e) {
              lastErr = e && e.message ? e : new Error(String(e))
            }
          }
          // 回退：读书模式自己的附件路由（按 attachmentId + 完整 ref 字段取字节）
          try {
            const params = new URLSearchParams()
            if (attachment.mediaType) params.set('mediaType', attachment.mediaType)
            if (attachment.bytes !== undefined && attachment.bytes !== null) params.set('bytes', String(attachment.bytes))
            if (attachment.width !== undefined && attachment.width !== null) params.set('width', String(attachment.width))
            if (attachment.height !== undefined && attachment.height !== null) params.set('height', String(attachment.height))
            const qs = params.toString()
            const res = await fetch('/__dsr_doc__/image/' + encodeURIComponent(attachment.attachmentId) + (qs ? '?' + qs : ''))
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const blob = await res.blob()
            const mediaType = blob.type || (attachment.mediaType || 'image/png')
            const bytes = new Uint8Array(await blob.arrayBuffer())
            return await toImageUrl(mediaType, bytes)
          } catch (e2) {
            throw (lastErr || e2)
          }
        })()
        imageCache.set(key, pending)
        return pending
      }

      // 样式：手动注入 <style>（模块系统会自动打 data-plugin 标记，HMR 安全）
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.append(styleEl)
      ctx.effect(() => () => { styleEl.remove() })

      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'reading-mode', order: 60, label: '读书模式' },
        (props) => React.createElement(SidebarButton, props),
      ))

      slots.inject('conversation.session.header.actions', () => slots.register(
        { name: 'conversation.session.header.actions', id: 'reading-mode', order: 5, label: '读书模式' },
        (props) => React.createElement(HeaderActionButton, props),
      ))

      let convInject = null
      const syncActive = () => {
        if (state.active && convInject === null) {
          convInject = slots.inject('conversation', () => slots.register(
            { name: 'conversation', priority: -1 },
            (props) => React.createElement(Reader, props),
          ))
          const layout = ctx.get('layout')
          if (layout !== undefined) layout.closeDetails()
        } else if (!state.active && convInject !== null) {
          const d = convInject
          convInject = null
          d()
        }
      }
      ctx.effect(() => store.subscribe(syncActive))
      syncActive()
    }

    return { apply }
  },
})
