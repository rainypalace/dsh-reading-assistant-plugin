// 将 PdfJsReader 整段替换为 pdf.js 官方 PDFViewer 组件实现
const fs = require('fs')
const p = 'D:/vibe projects/dsh_demo/reading-mode-pkg/lib/client.js'
const src = fs.readFileSync(p, 'utf8')

const startAnchor = '    // ---------- pdf.js 自渲染阅读器（页码可编程、视口虚拟化渲染） ----------'
const endAnchor = '    // ---------- 助手立绘（Q 版大肥鱼，白底已洗为透明，WebP base64 内嵌） ----------'
const si = src.indexOf(startAnchor)
const ei = src.indexOf(endAnchor)
if (si === -1 || ei === -1 || ei <= si) { console.error('anchors not found', si, ei); process.exit(1) }

const newBlock = `    // ---------- pdf.js 官方组件渲染（PDFViewer，Firefox 同款管线，页码可编程） ----------
    const PDFJS_LIB_URL = '/__dsr_doc__/pdfjs/pdf.min.mjs'
    const PDFJS_WORKER_URL = '/__dsr_doc__/pdfjs/pdf.worker.min.mjs'
    const PDFJS_VIEWER_URL = '/__dsr_doc__/pdfjs/pdf_viewer.mjs'
    const PDFJS_VIEWER_CSS_URL = '/__dsr_doc__/pdfjs/pdf_viewer.css'
    const PDFJS_CMAP_URL = '/__dsr_doc__/pdfjs/cMaps/'
    const PDFJS_ICC_URL = '/__dsr_doc__/pdfjs/iccs/'
    const PDFJS_FONTS_URL = '/__dsr_doc__/pdfjs/standard_fonts/'
    const PDFJS_WASM_URL = '/__dsr_doc__/pdfjs/wasm/'

    function PdfJsReader(props) {
      const file = props.file
      const [status, setStatus] = React.useState('loading')
      const [numPages, setNumPages] = React.useState(0)
      const [currentPage, setCurrentPage] = React.useState(0)
      const [zoomLabel, setZoomLabel] = React.useState('')
      const hostRef = React.useRef(null)
      const viewerRef = React.useRef(null)
      const pollRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        let viewer = null
        let pdf = null
        let styleEl = null
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
            if (host === null || host === undefined) return
            viewer = new viewerMod.PDFViewer({ container: host, textLayerMode: 1 })
            viewerRef.current = viewer
            await viewer.setDocument(pdf)
            if (!alive) return
            try { viewer.currentScaleValue = 'page-width' } catch (e) { /* ignore */ }
            setStatus('ready')
            pollRef.current = setInterval(() => {
              try {
                if (viewer === null || viewer === undefined) return
                setCurrentPage(viewer.currentPageNumber || 1)
                const s = viewer.currentScale
                if (typeof s === 'number') setZoomLabel(Math.round(s * 100) + '%')
              } catch (e) { /* ignore */ }
            }, 400)
          } catch (e) {
            if (alive) setStatus('error:' + ((e && e.message) ? e.message : String(e)))
          }
        })()
        return () => {
          alive = false
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
          try { if (viewer !== null && viewer !== undefined && typeof viewer.cleanup === 'function') viewer.cleanup() } catch (e) { /* ignore */ }
          try { if (pdf !== null && pdf !== undefined) pdf.destroy() } catch (e) { /* ignore */ }
          viewerRef.current = null
          if (styleEl !== null) { try { styleEl.remove() } catch (e) { /* ignore */ } }
        }
      }, [file])

      const gotoPage = (n) => {
        const v = viewerRef.current
        if (v === null || v === undefined || numPages === 0) return
        const target = Math.max(1, Math.min(numPages, n))
        try { v.scrollPageIntoView({ pageNumber: target }) } catch (e) { /* ignore */ }
      }
      const zoom = (f) => {
        const v = viewerRef.current
        if (v === null || v === undefined) return
        try {
          const next = Math.max(0.5, Math.min(3, Math.round(v.currentScale * f * 100) / 100))
          v.currentScaleValue = String(next)
        } catch (e) { /* ignore */ }
      }

      if (status !== 'ready') {
        return React.createElement('div', { className: 'dsr-pdf-status' },
          status === 'loading' ? '正在加载 PDF…' : status
        )
      }

      return React.createElement('div', { className: 'dsr-pdfjs' },
        React.createElement('div', { className: 'dsr-pdfjs-bar' },
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '上一页', onClick: () => gotoPage(currentPage - 1) }, '‹'),
          React.createElement('span', { className: 'dsr-pdfjs-page' }, '第 ' + currentPage + ' / ' + numPages + ' 页'),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '下一页', onClick: () => gotoPage(currentPage + 1) }, '›'),
          React.createElement('span', { className: 'dsr-pdfjs-sep' }),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '缩小', onClick: () => zoom(0.8) }, '－'),
          React.createElement('span', { className: 'dsr-pdfjs-page' }, zoomLabel || '适配宽度'),
          React.createElement('button', { className: 'dsr-pdfjs-btn', title: '放大', onClick: () => zoom(1.25) }, '＋')
        ),
        React.createElement('div', { className: 'dsr-pdfjs-host', ref: hostRef })
      )
    }

`

const out = src.slice(0, si) + newBlock + src.slice(ei)
fs.writeFileSync(p, out, 'utf8')
console.log('replaced PdfJsReader implementation')
