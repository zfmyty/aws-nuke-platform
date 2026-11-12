# AWS Nuke 管理平台

<p align="center">
  <img src="docs/images/logo.png" alt="AWS Nuke 管理平台" width="120" />
</p>

[![Version](https://img.shields.io/badge/version-v1.0.0-blue)](../../releases)
[![aws-nuke](https://img.shields.io/badge/aws--nuke-v3.68.3-orange)](https://github.com/ekristen/aws-nuke)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)]()
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 面向多账号场景的 [aws-nuke](https://github.com/ekristen/aws-nuke) 编排平台：统一托管凭证、生成清理配置、演练与执行全程留痕，并按角色隔离数据。

后端只依赖 Express 一个三方包，数据用文件级 JSON 存储，**零数据库依赖**；前端为 Vue 3 单页应用。解压后双击 `start.bat` 即可使用。

> **使用前请务必阅读 [DISCLAIMER.md](DISCLAIMER.md)。**
> 本项目定位为**内网自用工具**，用于已授权的 AWS 账号资源清理。它未经第三方安全审计，
> 不得直接暴露于公网或用于生产环境的无人值守操作。因使用本项目产生的任何直接或间接后果，
> 均由使用者自行承担；作者不提供担保、技术支持或赔偿责任。

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [首次部署](#首次部署)
- [执行一次清理](#执行一次清理)
- [多账号场景（Organizations）](#多账号场景organizations)
- [安全设计](#安全设计)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [目录结构与技术栈](#目录结构与技术栈)
- [参与贡献](#参与贡献)
- [详细文档](#详细文档)
- [免责声明](#免责声明)
- [许可](#许可)

---

## 功能特性

- **凭证托管** — 主账号 AK/SK 加密存储（AES-256-GCM），子账号通过 `sts:AssumeRole` 临时凭证进入，长期密钥不落盘
- **配置即冻结** — 每个账号的 aws-nuke YAML 生成一次即锁定，之后支持手工编辑或显式重新生成
- **双模式真实执行**
  - **直接执行**：`--no-prompt` 无人值守批量清理
  - **扫描后确认**：扫描完成后暂停并图形化展示可删除资源清单，输入账号别名确认才开始删除，限时超时自动中止
- **批量操作** — 账号页勾选多个账号，一键批量演练 / 批量真实删除
- **实时可观测** — SSE 实时日志流、执行摘要、任务记录管理（单条/批量删除）
- **环境自愈** — AWS CLI 装完无需重启即可识别（实时读注册表 PATH）；Node 缺失时自动下载便携版
- **服务状态灯** — 顶栏「服务在线/离线」基于真实健康检查，检查间隔管理员可配
- **权限分离** — 管理员 / 普通用户双角色，数据在服务端强制隔离

---

## 快速开始

### 方式一：使用发布包（推荐）

1. 到 [Releases](../../releases) 页面下载最新发布包并解压（如 `aws-nuke-platform-v1.0.0.zip`）
2. 双击 `check.bat` 确认环境
3. 双击 `start.bat`：
   - 弹出 UAC 询问 → 点「是」以管理员启动（可用一键安装 AWS CLI），点「否」为普通启动（其余功能不受影响）
   - 服务就绪后浏览器自动打开 `http://localhost:3000`
4. 使用初始管理员登录：

   ```
   用户名：admin
   密码  ：Admin@123456
   ```

   > 登录后请立即在「个人信息」修改密码。

> 发布包分两种：普通包（不含 `aws-nuke.exe`，首次启动在部署向导里下载）与 `-full` 全量包（内置二进制，约 300MB）。
> `aws-nuke.exe` 不入 git 仓库，只作为 Release 附件分发。

### 方式二：从源码运行

```bash
git clone https://github.com/zfmyty/aws-nuke-platform.git
cd aws-nuke-platform

npm run install:all      # 安装前后端依赖
npm run build            # 前端构建到 server/public
npm start                # http://localhost:3000
```

或开发模式：`npm run dev:server` + `npm run dev:web`（前端 5173，已代理 `/api` 到 3000）。

首次从源码运行还需放置 aws-nuke 二进制：到 [ekristen/aws-nuke Releases](https://github.com/ekristen/aws-nuke/releases)
下载 `aws-nuke-v3.68.3-windows-amd64.zip`，把其中的 `aws-nuke.exe` 放到 `runtime/bin/`。

### 运行环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10 / 11（Server 2019+） | 当前仅支持 Windows；PowerShell 5.1 及以上 |
| Node.js | ≥ 18 | 缺失时 `start.bat` 会询问并自动下载便携版到 `runtime/node` |
| AWS CLI | v2 | 用于鉴权，部署向导可一键安装 |
| aws-nuke | v3.68.3 | Windows AMD64 二进制 |

### 停止服务

| 方式 | 说明 |
| --- | --- |
| 窗口内按 `Ctrl+Enter` | 优雅退出：先终止 aws-nuke 子进程，再关闭 HTTP 服务 |
| 关闭服务窗口 | 效果等同，数据不会损坏 |
| 双击 `stop.bat` | 按端口强制结束进程树 |

---

## 首次部署

进入「平台运维 → 部署向导」，三步：

1. **aws-nuke 可执行文件** — 发布包已内置；从源码运行则放入 `runtime/bin/aws-nuke.exe`（或提供官方 zip 自动解压）
2. **AWS CLI v2** — 一键安装（需管理员权限），也可自行安装
3. **主账号凭证** — 按使用方式二选一：
   - **组织跨账号**（默认）：填主账号 IAM 用户的 AK/SK，用于 AssumeRole 进入成员账号；主账号自动并入黑名单保护
   - **单账号直连**：可跳过，直接在各账号里填自己的 AK/SK

---

## 执行一次清理

1. **提交账号** — 「账号管理 → 提交账号」或「扫描组织账号」批量导入；勾选要清理的区域
2. **演练** — 先跑一次 dry-run，任务中心实时查看将被删除的资源清单
3. **真实删除** — 输入 12 位账号 ID 二次确认后选择执行方式：
   - 直接执行：立即开始删除
   - 扫描后确认：扫完暂停，浏览资源清单并输入账号别名才开始删除（推荐首次使用）
4. **核对结果** — 任务详情查看摘要（扫描 / 可删除 / 已完成 / 失败）与完整日志

> 真实删除不可撤销。请务必先演练、核对过滤规则，并完成数据备份。

---

## 多账号场景（Organizations）

管理账号 + 成员账号结构下，平台用主账号 IAM 用户 `sts:AssumeRole` 扮演成员账号内的组织角色（默认 `OrganizationAccountAccessRole`），**不需要为每个子账号创建 IAM 用户**：

```
主账号 IAM 用户 (AK/SK)
        │  sts:AssumeRole
        ▼
子账号角色  arn:aws:iam::<子账号ID>:role/OrganizationAccountAccessRole
        │  临时凭证（自动轮转，不落盘）
        ▼
aws-nuke 以子账号身份扫描 / 删除资源
```

- 「扫描组织账号」可一次列出全部成员账号并批量接入
- 生成配置时自动追加 4 条过滤规则保护正在使用的认证角色，防止清理中断会话
- 中国区 / GovCloud 分区支持完整 ARN（`arn:aws-cn:...`）与 `--default-region`

本节的完整手册——IAM 策略与信任策略示例、与现有 `~/.aws` 文件的兼容方式、自动保护角色的配置片段、
失败报错对照表——见 [详细文档 · 组织账号场景](README-DETAIL.md#五、组织账号（AssumeRole）场景)。

---

## 安全设计

| 层面 | 机制 |
| --- | --- |
| 凭证 | AK/SK AES-256-GCM 加密；AssumeRole 临时凭证只在子进程内使用，不落库 |
| 口令 | scrypt + 随机盐 + 恒定时间比较 |
| 黑名单 | 命中账号任何角色都无法执行；主账号自动并入 |
| 确认 | 真实删除需精确输入账号 ID；可选扫描后别名确认；普通用户删除权可一键关闭 |
| 脱敏 | 任务参数与日志中的密钥统一替换为 `********` |
| 审计 | 登录、账号变更、任务触发/确认/删除等全部留痕，含操作人 IP |

> 面向内网运维场景，默认不启用 HTTPS；公网部署请置于反向代理之后并开启 TLS。
> 发现安全问题请勿开公开 Issue，按 [SECURITY.md](SECURITY.md) 的方式私下报告。

---

## 配置项

平台设置（管理员，全局生效）：

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| 账号黑名单 | 禁止执行的 12 位账号 ID，每行一个 | 空 |
| 默认排除资源类型 | 对全部账号生效，建议保留 `S3Object` | `S3Object` |
| 允许普通用户真实删除 | 关闭后普通用户只能演练 | 开 |
| 自动保护认证角色 | 组织账号自动追加 IAMRole 等过滤 | 开 |
| 跳过别名检查 | 跳过 prod/live 等敏感词别名校验 | 关 |
| 确认等待时长 | 扫描后确认模式的限时（分钟） | 5 |
| 任务中心刷新间隔 | 列表轮询频率（秒） | 12 |
| 服务状态检查间隔 | 顶栏指示灯健康检查频率（秒） | 10 |

环境变量（可选，全部定义在 `server/src/config/index.js`）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | HTTP 监听端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `NODE_ENV` | 运行模式 | `production` |
| `SEED_ADMIN_USER` / `SEED_ADMIN_PASS` | 首次启动创建的管理员账号 | `admin` / `Admin@123456` |
| `TOKEN_TTL` | 登录令牌有效期（秒） | `43200`（12 小时） |
| `NUKE_DATA_DIR` | 数据目录重定向 | `server/data` |
| `NUKE_JOB_TIMEOUT` | 单个任务最长运行时间（毫秒） | `3600000`（1 小时） |
| `NUKE_PROMPT_TIMEOUT` | 扫描后确认的等待时长（毫秒） | `300000`（5 分钟） |
| `AWS_NUKE_BIN` | aws-nuke 二进制路径 | `runtime/bin/aws-nuke.exe` |
| `AWS_CLI_PATH` | AWS CLI 在非标准目录时的 `aws.exe` 完整路径 | 自动探测 |

---

## 常见问题

**任务报 `NoCredentialProviders`？**
账号未配置 AK/SK 且 profile 不存在。先完成部署向导的主账号凭证，或为账号指定已有 profile。

**装完 AWS CLI 还是识别不到？**
无需重启平台——CLI 解析会实时读注册表 PATH（约 10 秒缓存）。CLI 装在非标准目录时用环境变量 `AWS_CLI_PATH` 指定。

**新增账号时区域为空？**
区域决定清理范围，属于使用者自身的判断，平台不做预填、不做预检；缺失时由 aws-nuke 在任务日志中报错，以其输出为准。

**真实删除按钮不可用？**
管理员关闭了普通用户删除权，或该账号命中黑名单。

**如何完全重置？**
停止服务后删除 `server/data`，重启会重新生成管理员与密钥。

**Linux / macOS 可用吗？**
当前仅提供 Windows 实现。启动脚本、便携版 Node 下载、AWS CLI 安装与进程管理均按 Windows 编写，
其他平台的移植需要另做一套实现，欢迎提交 PR。

更多问题（MFA 拒绝、二次 AssumeRole、profile 冲突等）见[详细文档](README-DETAIL.md#八常见问题)。

---

## 目录结构与技术栈

```
aws-nuke-platform/
├── start.bat / stop.bat / check.bat   # Windows 启动 / 停止 / 环境检测入口
├── scripts/                           # 真实逻辑：env / start / check / stop / pack
├── runtime/bin/                       # aws-nuke.exe（不入库，见 Releases）
├── server/                            # Express 后端（分层：routes → service → lib）
├── web/                               # Vue 3 + Vite 前端
└── server/public/                     # 前端构建产物（不入库）
```

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3 + Vite + Pinia + Vue Router，深色科技风，纯 SVG 图标 |
| 后端 | Node.js + Express，零三方依赖（除 express） |
| 存储 | 文件级 JSON（`server/data`），原子写入，零数据库 |
| 加密 | AES-256-GCM（凭证）/ scrypt（口令）/ HMAC-SHA256（令牌），全部手写于 `lib/` |
| 通信 | REST + SSE（任务日志实时推送） |

完整的模块清单、分层约定与每个文件的职责见 [详细文档 · 目录结构](README-DETAIL.md#二目录结构)。

---

## 参与贡献

欢迎提交 Issue 与 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中包含
开发环境搭建、代码风格、提交信息规范与 PR 流程。

- 报告 Bug：[新建 Issue](../../issues/new?template=bug_report.yml)
- 功能建议：[新建 Issue](../../issues/new?template=feature_request.yml)
- 安全问题：见 [SECURITY.md](SECURITY.md)，**请勿公开提交**

---

## 详细文档

深入的部署细节、组织场景配置、`~/.aws` 文件兼容说明与完整排错手册：

- [README-DETAIL.md](README-DETAIL.md) — 完整文档（目录结构、分层约定、接口概览、组织场景手册、打包发布）

---

## 免责声明

本项目为**个人自用工具**，以开源形式分享，仅面向**内网环境**与**已获授权的自有 AWS 账号**。

- 作者未对本项目作任何安全审计，**不保证**其在公网暴露、生产环境或无人值守场景下的安全性；
- 使用本项目即表示你**自行承担**全部风险与后果，包括但不限于资源被误删、费用损失、
  数据丢失、凭证泄露与业务中断；
- 软件按「现状」提供，**不附带任何明示或默示担保**，作者不承担任何直接或间接赔偿责任。

完整条款见 **[DISCLAIMER.md](DISCLAIMER.md)**，其中逐项列出了已知风险与常见误用场景。
该文件是使用本项目的前提，请在使用前完整阅读。

---

## 许可

本项目以 [MIT License](LICENSE) 开源发布，Copyright (c) 2026 zfmyty。

即：任何人可自由使用、复制、修改、合并、发布、分发、再许可与销售本项目的副本，
唯须在软件及所有副本中保留上述版权声明与许可文本。软件按「现状」提供，不含任何形式的担保。

本平台集成的 [aws-nuke](https://github.com/ekristen/aws-nuke) 由 ekristen/aws-nuke 依据 MIT 许可发布，
版权归其原作者所有；其余开源依赖遵循各自仓库的原始许可。完整第三方声明见
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。
