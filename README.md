# 智桥-zhiqiao

让网页上的 AI（ChatGPT / Claude）通过 MCP 协议操作这台电脑。

智桥在本机跑一个 **MCP（Model Context Protocol）服务**，监听 `127.0.0.1:8765`，可选地通过 Cloudflare 临时隧道暴露到公网，让网页版 AI 客户端能读写你指定的文件夹、执行命令。

- 不依赖任何第三方账号
- 没有会员限制
- 权限范围是硬边界：路径穿越、符号链接逃逸都会被拦
- 支持两种连接方式：OAuth 2.1 流程（ChatGPT）和自定义 Header（Claude）

## 一、它是什么

一个 Electron 桌面应用。主进程负责：

| 模块 | 职责 |
|---|---|
| `electron/main.js` | 窗口、托盘、IPC |
| `electron/preload.cjs` | contextBridge 桥，只暴露窄接口 |
| `src/service.js` | HTTP 服务器 + cloudflared 隧道管理 |
| `src/mcp.js` | MCP 协议层（JSON-RPC over streamable HTTP） |
| `src/oauth.js` | 最小 OAuth 2.1 授权服务器（PKCE） |
| `src/tools.js` | AI 可调用的 10 个工具 |
| `src/pathsafe.js` | 路径白名单校验（防 `../`、防符号链接逃逸） |
| `src/config.js` | 配置读写，存于 Electron userData |
| `ui/` | 控制面板界面 |

## 二、AI 能调用的工具

`read_file` / `write_file` / `list_dir` / `search_files` / `file_info` /
`run_command` / `system_info` / `make_dir` / `move_path` / `delete_path`

所有文件工具都经过 `pathsafe.assertAllowed`，只能访问「权限范围」里列出的文件夹。

## 三、连接 AI

启动程序后点「开启隧道」，拿到公网地址。

**方式 A：客户端要求 OAuth（ChatGPT）**

1. URL 填 `https://xxxx.trycloudflare.com/mcp`
2. 身份验证选 OAuth
3. 浏览器打开授权页后，粘贴「连接 AI」页的访问令牌
4. 完成

**方式 B：客户端支持自定义 Header（Claude 等）**

```json
{
  "mcpServers": {
    "my-computer": {
      "type": "http",
      "url": "https://xxxx.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer 你的令牌" }
    }
  }
}
```

## 四、本地开发

```bash
npm install
npm start
```

需要 Electron 38.2.1。启动后本机地址为 `http://127.0.0.1:8765/mcp`。

## 五、构建安装包

构建产物需要先拉取 cloudflared 二进制：

```bash
npm run fetch:cloudflared     # 下载到 resources/
```

Windows（在 Windows 上运行）：

```bash
npm run pack:win              # 产物在 dist/
```

macOS（在 macOS 上运行，得到 .app）：

```bash
npm run pack:mac              # 产物在 dist/
```

> cloudflared 体积较大（约 68MB），不随仓库分发，构建时自动下载。
> 未做 Apple 开发者签名，macOS 首次打开需按「系统设置 → 隐私与安全性 → 仍要打开」放行，或执行 `xattr -cr /Applications/智桥-zhiqiao.app`。

## 六、配置文件

- 位置：`%APPDATA%\zhiqiao\config\config.json`（Windows）/ `~/Library/Application Support/zhiqiao/config/config.json`（macOS）
- 令牌在首次启动时随机生成（`crypto.randomBytes(24).toString('base64url')`）
- 卸载：删除程序文件夹即可，不写注册表

## 七、安全须知

- 公网地址没有额外保护：**地址 + 令牌** 泄露就等于开门，不用时关闭隧道或退出程序
- 「允许运行命令」风险最高，内置了危险命令黑名单（`format`、`diskpart`、`rm -rf /` 等）
- `run_command` 有 60 秒超时和 200KB 输出上限
- OAuth 授权码 5 分钟过期，令牌可随时重新生成

## 八、开源协议

MIT License，见 [LICENSE](LICENSE)。
