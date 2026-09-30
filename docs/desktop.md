# Windows 桌面版使用与复现

QianwenChat v0.13.0 面向 Windows x64。安装包内置 Electron 和 Node.js，安装后的用户无需安装 Node.js、克隆仓库或启动开发服务器。调用千问模型需要联网，并由当前 Windows 用户配置自己的 API Key。

## 安装与配置

本地交付文件位于项目的 `release/` 目录：

- `release/QianwenChat-Setup-0.13.0-x64.exe`：安装程序。
- `release/QianwenChat-Setup-0.13.0-x64.exe.sha256`：安装文件的 SHA-256 校验值。

本版安装包**未做代码签名**，Windows 可能显示未知发布者提示。请核对文件来源和校验值；校验值用于核对文件一致性，不代表发布者签名。在项目根目录打开 PowerShell，可查看并比对：

```powershell
Get-FileHash -LiteralPath '.\release\QianwenChat-Setup-0.13.0-x64.exe' -Algorithm SHA256
Get-Content -LiteralPath '.\release\QianwenChat-Setup-0.13.0-x64.exe.sha256'
```

双击安装程序，按当前普通用户执行一键安装，不需要以管理员身份运行。安装后从桌面或开始菜单的“千问桌面助手”启动。

在 Windows“环境变量”中新增用户变量或系统变量：名称为 `Qianwen_api_key`，值为自己的千问 API Key。应用读取启动进程继承的环境变量；新增或修改后，需要完全退出应用再启动。若从开始菜单启动仍提示未配置，可注销并重新登录 Windows，让启动程序获得新的环境。菜单“帮助 → 配置说明”显示是否检测到配置，不展示密钥。

安装包不会附带开发者的 API Key。已有的 `QWEN_MODEL`、`QWEN_VISION_MODEL`、`QWEN_ASR_MODEL` 等模型设置仍由启动环境读取，详细参数见 [README](../README.md)。

## 日常使用

桌面窗口提供流式对话、停止生成、计算器、本地资料检索、深度思考、联网来源、图片和文档问答、录音转写及回复朗读。模型或语音接口不可用时会显示错误，不会替换成模拟回答。文档解析和语音能力的格式、大小及功能边界与 [网页说明](../README.md) 相同。

应用只监听固定本机地址 `127.0.0.1:18439`。所有页面资源和 API 都要求由桌面主进程附加的临时访问令牌，普通浏览器直接访问该地址会返回 `403`，这是预期行为。令牌每次启动重新生成，不是 API Key，也不需要用户配置。若端口已被其他程序占用，应用会提示启动失败；关闭占用端口的程序后重试。

网页来源链接在系统浏览器打开；已上传图片在应用的图片预览窗口打开。录音需要 Windows 允许桌面应用访问麦克风。关闭主窗口或选择“应用 → 退出”会退出应用，并取消正在进行的模型、语音或文档处理。

## 数据、备份与账号

默认数据目录为 `%APPDATA%\QianwenChat`，可从菜单“应用 → 打开数据目录”定位：

| 路径 | 内容 |
| --- | --- |
| `browser/` | 桌面浏览器持久化数据，包括会话、草稿、偏好和登录 Cookie |
| `service-data/accounts.sqlite` | 本地账号、密码散列、登录会话与手动上传的账号同步副本 |
| `service-data/uploads/` | 按上传身份隔离的图片、文档原件和解析记录 |
| `logs/desktop.log` | 桌面启动和退出诊断记录，使用受控错误码 |

备份完整桌面数据时，先从“应用 → 退出”完全关闭应用，再复制**整个 `QianwenChat` 数据目录**。不要在运行时只复制 SQLite 主文件，也不要将不同备份中的数据库、附件和浏览器数据混合。恢复时同样先退出，再将完整备份还原到对应目录。

升级默认沿用该目录；卸载默认保留用户数据。安装目录和用户数据目录相互独立，重新安装不会主动清空原有会话、账号或附件。

桌面版和网页开发服务使用独立的账号数据库、附件目录与浏览器存储。同名用户名不会自动成为同一个账号；网页的登录状态和会话不会自动出现在桌面版。应用内“本地备份”的 JSON 导入导出可迁移会话、草稿、工具结果、来源及附件引用，**不搬运图片或文档原件**。迁移至另一服务后，需要重新上传相关附件。

账号中的上传、下载是对当前桌面本地服务的显式同步操作，并未接入跨设备云同步。关闭窗口前未手动上传的会话仍由桌面浏览器保存，不等同于账号服务中已有同步副本。

## 从源码构建

开发和打包使用 Windows x64、Node.js 24 或更高版本及 npm。在项目根目录先执行 `npm ci`，再按需要使用：

| 命令 | 用途 |
| --- | --- |
| `npm run desktop:build` | 类型检查并构建网页、桌面主进程、独立后端和图标 |
| `npm run desktop:start` | 构建后，使用仓库安装的 Electron 启动桌面应用 |
| `npm run desktop:pack` | 构建可直接运行的 `release/win-unpacked/QianwenChat.exe` 目录 |
| `npm run desktop:dist` | 构建 Windows x64 安装包，检查资源并写出 `.sha256` |
| `npm run test:desktop` | 运行独立数据目录下的桌面自动化检查 |
| `npm run test:live:desktop` | 对指定桌面程序运行真实模型验收，会消耗模型额度 |

`desktop:build` 的产物位于 `dist/` 和 `desktop-dist/`。安装包包含独立的后端 bundle、知识库、文档解析进程及其运行依赖；模型密钥和用户数据不属于打包输入。`desktop:dist` 在构建环境配置了 `Qianwen_api_key` 时，还会检查打包资源是否含该密钥的原始值；未配置时明确报告跳过这项扫描。

本地打包命令不自动发布安装包。安装产物和测试用户数据不提交到 Git。

首次构建需要下载 Electron 运行时和 NSIS 打包工具。网络无法直连 GitHub 时，可在当前终端配置自己的可用代理；Electron 下载也支持 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，仍按 npm 包内的校验值验证运行时文件。构建先安装并验证 Electron，再从本地运行时目录打包。

## 桌面自动化复现

测试前退出正在运行的桌面应用，释放 `18439` 端口。测试默认使用独立的数据目录，并以串行方式运行，避免改动日常使用的会话与账号。测试中的模型接口采用受控响应；真实千问调用需要另做联网验收，不能由这些测试代替。

默认测试仓库构建结果：

```powershell
npm run desktop:build
npm run test:desktop
```

测试实际安装后的程序时，将 `QWEN_DESKTOP_EXECUTABLE` 指向已安装 `QianwenChat.exe` 的**绝对路径**，例如：

```powershell
$env:QWEN_DESKTOP_EXECUTABLE = 'C:\实际安装目录\QianwenChat.exe'
npm run test:desktop
Remove-Item Env:QWEN_DESKTOP_EXECUTABLE
```

`QWEN_DESKTOP_EXECUTABLE` 只选择自动化测试的启动程序，不改变普通应用的安装位置。测试截图和运行输出保存在项目 `.local/desktop-e2e/` 下。

`QWEN_DESKTOP_USER_DATA` 用于自动化或需要单独数据空间的启动场景，值必须是可写的**绝对目录路径**。未设置时使用 `%APPDATA%\QianwenChat`；桌面测试会自行设置隔离目录，不需要把它指向日常数据。更换该变量相当于切换整个数据空间，不会自动迁移已有账号、附件和会话。网页服务的 `QWEN_DATA_DIR` 不决定桌面应用的数据目录。
