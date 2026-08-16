# dsh-reading-mode

DeepSeek Harness 读书模式插件：让大肥鱼成为你的阅读助手！在会话里打开一个专注的阅读工作台，支持PDF/Markdown 阅读器、阅读助手、截图提问（视觉模型识别 → 主模型解答）、页码归属与历史索引、阅读进度记忆。

## 功能

- **入口**：会话标题栏右侧「📖 读书模式」按钮，进入后占用会话区，右侧为顶栏 + 阅读器 + 对话面板/助手立绘。
- **文档**：
  - Markdown：内置轻量渲染（标题/列表/引用/代码/表格/粗斜体）。
  - PDF 双渲染器：浏览器内置查看器（File System Access 直开本地文件，零上传）与 pdf.js 高级模式（页码可编程、140MB+ 扫描版可用）。
- **截图提问**：粘贴/读剪贴板 → 视觉模型识别截图 → 主模型解答；截图随消息落盘、气泡内缩略图、点开大图浮层。
- **页码体系**：提问自动带当前页码（写进消息 source.page）、历史索引「📄 第 X 页」胶囊跳页。
- **阅读进度**：按书名+文件大小记忆页码（localStorage），重开文档精确恢复（两段式精确跳页）。
- **设置**：立绘大小/对话面板宽度/提示胶囊/识别结果展开/对话字号/渲染器选择（settings.yaml 持久化、热生效）。

## 安装（从 Git 仓库）

本插件未发布到 npm，请直接从 GitHub 仓库安装：

```sh
dsh plugin --profile web add github:rainypalace/dsh-reading-assistant-plugin
```

也可以先克隆、再用本地链接安装（便于本地修改调试）：

```sh
git clone https://github.com/rainypalace/dsh-reading-assistant-plugin.git
dsh plugin --profile web add link:../dsh-reading-assistant-plugin
```

`dsh plugin` 在 profile 目录里运行 pnpm，并自动把声明了 `dsh.bundle` 的依赖纳入 `dsh.profile.bundles` 层列表。本包没有 `prepare` 构建脚本，pnpm 无需额外 `allowBuilds` 配置。安装后**重启 dsh**（宿主路由与设置命名空间在启动时注册），刷新页面即可。

> 注意：行名（包名）是 `dsh-reading-mode`，与仓库名 `dsh-reading-assistant-plugin` 不同——`dsh plugin` 按安装后的真实包名 reconcile，卸载/禁用请用包名（见下）。

## 卸载 / 禁用

```sh
dsh plugin --profile web remove dsh-reading-mode
```

或者只禁用（保留包）：在自己的 `cordis.patch.yml` 里加：

```yaml
- id: reading-mode
  disabled: true
```

## 前置条件

- **视觉路由**（截图提问）：部署的 `llm` 提供方里至少有一个 `inputModalities` 含 `image` 的模型（例如 qianwen VL 系列），插件自动发现第一个可用者。没有则截图提问降级为纯文字提问。
- **主模型**：不要求视觉能力——截图永远由视觉模型识别成文字后再交给主模型。
- 客户端无需构建：`lib/client.js` 是手写 IIFE 工厂（`window.__ModuleLoader__.load`），由宿主 `/plugins/reading-mode/client.js` 路由直接服务。

## 包结构

```
lib/index.js        宿主插件（ESM；注入 webServer/attachments/agents/llm/settings）
lib/client.js       浏览器插件 bundle（IIFE 工厂，无构建步骤）
cordis.patch.yml    bundle patch 层（dsh.bundle.patch 声明）
assets/pdfjs/       pdf.js 5.4.624 静态资源（核心/worker/cMaps/字体/wasm，宿主路由服务）
assets/avatar*.webp 立绘素材（base64 已内嵌进 client.js，此处保留源产物）
tools/              开发辅助脚本（立绘处理/注入、冒烟与压力测试、部署），不随包发布
```

## 开发

- 改客户端：编辑 `lib/client.js` 后刷新页面即可（无需重启 dsh）；改宿主需重启。
- 部署到本地安装目录：见 `tools/` 与 Git 提交历史。
- 版本节奏见 Git 提交历史与 tag。

## License

MIT
