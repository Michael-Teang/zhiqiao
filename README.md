# 智桥-zhiqiao

**让 ChatGPT / Claude 等网页版 AI，通过 MCP 协议直接操作你的电脑。**

本机运行一个 MCP 服务，AI 就能在你划定的文件夹范围内读写文件、搜索内容、执行命令；需要远程使用时，一键通过 Cloudflare 临时隧道暴露到公网，手机、平板、公司电脑上的 AI 都能连。

---

## 软件介绍

### 这是什么

智桥-zhiqiao 是一个 Windows / macOS 桌面软件，它在你电脑上架起一座桥：

```
网页 AI（ChatGPT / Claude）
        │  MCP 协议（HTTPS）
        ▼
Cloudflare 隧道（可选，公网）──► 127.0.0.1:8765
        │
        ▼
你的电脑（指定文件夹 + 可选命令执行）
```

装上它之后，你在网页上对 AI 说「把下载文件夹里的报告整理成表格」，AI 就真的能读到你电脑里的文件并执行操作——不再只是聊文字。

### 给谁用

- 想让 ChatGPT / Claude 干实活的人：整理文件、批量重命名、跑脚本、查系统信息
- 不想把文件上传到第三方网盘的隐私敏感用户：数据全程只在你自己的电脑上
- 需要临时远程操作自己电脑的人：开隧道拿公网地址，手机浏览器里的 AI 也能连

### 核心特性

- **零依赖、零账号**：不注册任何服务，不登录任何平台，装完即用
- **两种连接方式**：OAuth 2.1 授权流程（ChatGPT 要求）和自定义 Header（Claude 等），可同时用
- **硬边界权限**：AI 只能访问你指定的文件夹，路径穿越（`../`）和符号链接逃逸都会被拦截
- **命令黑名单**：`format`、`diskpart`、`rm -rf /` 等危险命令默认拒绝
- **固定公网地址**：地址与本机 SSH 密钥绑定，重启电脑/程序、断线重连都不变；只有点「更换地址」才会换
- **多种隧道模式**：固定地址（默认，免费）、cloudflared 临时地址、自有 Cloudflare 域名
- **连接审批**：新设备请求连接需要在 3 分钟内于「连接记录」中批准，超时自动失效
- **设备记录**：显示连接过的设备、IP、请求次数，可按设备断开/重新允许
- **AI 记忆库**：`memory_save` 保存上下文摘要，下一个 AI 用 `memory_search` 读取
- **工具包**：文件增强、系统运维、桌面辅助、记忆四组内置工具
- **令牌可控**：访问令牌随时重新生成，旧连接立即失效
- **绿色卸载**：不写注册表，删除文件夹即卸载

### 内置工具包

| 工具 | 作用 |
|---|---|
| `read_file` | 读文本文件（拒绝返回二进制） |
| `write_file` | 写文件，可追加 |
| `list_dir` | 列目录，可递归 3 层 |
| `search_files` | 正则搜索文件内容 |
| `file_info` | 查文件类型 / 大小 / 时间戳 |
| `run_command` | 执行 shell 命令（可关闭） |
| `system_info` | 主机名 / 平台 / CPU / 内存 |
| `make_dir` | 建目录 |
| `move_path` | 移动 / 重命名 |
| `delete_path` | 删除文件或目录 |

---

## 快速开始

### 下载安装包

最新版本见 [Releases](https://github.com/Michael-Teang/zhiqiao/releases)：

| 平台 | 安装包 |
|---|---|
| Windows 10/11 x64 | `zhiqiao-1.3.0-win64.zip`（绿色版，解压即用） |
| macOS Apple 芯片 (M1–M4) | `zhiqiao-1.3.0-mac-arm64.zip` |
| macOS Intel | `zhiqiao-1.3.0-mac-x64.zip` |

### 三步连上 AI

1. 打开智桥-zhiqiao，首次启动会自动连接固定地址（约 5–15 秒）
2. 出现公网地址后点「复制完整配置」
3. 粘贴到 ChatGPT / Claude 的 MCP 连接器里

固定地址会一直保留：重启电脑、重启程序、断线重连都不会变。

**Windows**：解压后双击 `智桥-zhiqiao.exe`。
**macOS**：解压后拖进「应用程序」。首次打开被 Gatekeeper 拦截时：系统设置 → 隐私与安全性 → 仍要打开；或终端执行 `xattr -cr /Applications/智桥-zhiqiao.app`。

### 连接方式 A：OAuth（ChatGPT）

1. URL 填 `https://你的固定地址/mcp`
2. 身份验证选 **OAuth**
3. 浏览器打开授权页后，粘贴「连接 AI」页的访问令牌
4. 完成，不需要手动填 Header

### 连接方式 B：自定义 Header（Claude 等）

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

---

## 安全模型

| 层 | 机制 |
|---|---|
| 路径边界 | `pathsafe.js` 对每个路径做 realpath 校验，只允许白名单根目录内 |
| 认证 | 全站 Bearer token + OAuth 2.1（PKCE、5 分钟授权码） |
| 命令管控 | 可关闭执行、60 秒超时、200KB 输出上限、危险模式黑名单 |
| 数据出口 | 只有 Cloudflare 隧道（cloudflared）和本机 `127.0.0.1:8765` |
| 令牌 | 首次启动随机生成 24 字节 base64url，可随时轮换 |

⚠️ 公网地址 + 令牌 = 开门。不用时关闭隧道或退出程序。

---

## 目录结构

```
├─ electron/
│  ├─ main.js         窗口 / 托盘 / IPC / 生命周期
│  └─ preload.cjs     contextBridge 窄接口
├─ src/
│  ├─ service.js      HTTP 服务器 + cloudflared 隧道管理
│  ├─ mcp.js          MCP 协议层（JSON-RPC over streamable HTTP）
│  ├─ oauth.js        OAuth 2.1 授权服务器（动态注册 + PKCE）
│  ├─ tools.js        内置工具包实现
│  ├─ pathsafe.js     路径白名单校验
│  └─ config.js       配置读写（Electron userData）
├─ ui/                控制面板（原生 HTML/CSS/JS，无框架）
├─ scripts/
│  ├─ fetch-cloudflared.cjs   构建前下载 cloudflared
│  ├─ pack-win.cjs            Windows 打包
│  └─ pack-mac.sh             macOS 打包
├─ docs/              用户说明书
└─ .github/workflows/ 打 tag 自动构建发布
```

## 本地开发

```bash
npm install
npm start          # 需要 Electron 38.2.1
```

本机地址：`http://127.0.0.1:8765/mcp`

## 构建

```bash
npm run fetch:cloudflared   # 下载 cloudflared 到 resources/
npm run pack:win            # Windows（在 Windows 上跑）
npm run pack:mac            # macOS（在 macOS 上跑）
```

打 tag `v*` 会触发 GitHub Actions 自动构建三平台安装包并发布到 Release。

## 配置文件

- Windows：`%APPDATA%\zhiqiao\config\config.json`
- macOS：`~/Library/Application Support/zhiqiao/config/config.json`

## 开源协议

[MIT License](LICENSE) © 2026 zhiqiao
