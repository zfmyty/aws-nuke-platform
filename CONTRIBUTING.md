# 参与贡献

AWS Nuke 管理平台是**会真实删除 AWS 资源**的运维工具，因此对贡献的审查会相对严格——
尤其是涉及「删除范围」「权限判断」「凭证处理」的改动。

---

## 先读这些

- [README.md](README.md) — 项目定位与快速开始
- [README-DETAIL.md](README-DETAIL.md) — 目录结构、分层约定、接口清单
- [SECURITY.md](SECURITY.md) — 安全问题如何报告（**请勿开公开 Issue，也不要在 Issue 里写漏洞细节**）
- [DISCLAIMER.md](DISCLAIMER.md) — 使用限制与风险承担条款（贡献代码前也应了解）

---

## 开发环境

| 依赖 | 版本 |
| --- | --- |
| Windows | 10 / 11（当前仅支持 Windows） |
| Node.js | ≥ 18 |
| AWS CLI | v2 |
| aws-nuke | v3.68.3（Windows AMD64） |

```bash
git clone https://github.com/zfmyty/aws-nuke-platform.git
cd aws-nuke-platform
npm run install:all
```

仓库**不包含** `aws-nuke.exe`（320MB，不进版本库）。开发前请到
[ekristen/aws-nuke Releases](https://github.com/ekristen/aws-nuke/releases) 下载
`aws-nuke-v3.68.3-windows-amd64.zip`，把 `aws-nuke.exe` 放到 `runtime/bin/`。

开发模式：

```bash
npm run dev:server   # 后端 3000
npm run dev:web      # 前端 5173（已代理 /api）
```

---

## 代码约定

### 分层

```
views → api → routes → service → lib
```

- **视图层**不拼 URL、不推断权限，只消费 API 与 store
- **路由层**只做参数校验与响应封装，业务规则放 service
- **敏感字段只在 service 内解密**，出口统一掩码
- 新增业务 = 在 `server/src/modules/<domain>/` 下加 `routes.js` + `service.js`，再到 `app.js` 挂载

### 最小依赖原则

后端**只允许 express 一个三方包**。需要的能力（加密、令牌、JSON 存储、进程管理、HTTP）自己写在 `server/src/lib/` 里。
提 PR 引入新依赖时请在 PR 描述里说明为什么现有 `lib/` 无法满足。

### 前端

- 图标一律用 `components/AppIcon.vue` 里的 SVG，**不要用 emoji**
- 颜色取自 `styles/tokens.css`，不要写死色值
- 深色主题为唯一主题

### 长任务

长任务（安装 CLI、更新二进制、演练/删除）必须走 `modules/jobs/runner.js` 的 `startJob`，
不要在路由里直接 `spawn`。

### 安全红线

以下改动会被重点审查：

| 涉及 | 要求 |
| --- | --- |
| 凭证读写 | 只能在 service 内解密；日志、任务参数、接口响应一律掩码 |
| 黑名单 | 必须经过 `resolveBlocklist(settings, account)`，不得直接读 `settings.blocklist` |
| 真实删除 | 必须有 12 位账号 ID 二次确认；不得绕过 `assertNotBlocked` |
| 外网请求 | 必须走 `lib/http.js`（`httpGetText` / `httpDownload`），不要直接用 `fetch` |
| 配置文件 | `ensureConfigFile()` 只在文件不存在时生成，**绝不覆盖**用户手工保存的内容 |

---

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <subject>
```

| type | 含义 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `docs` | 仅文档 |
| `refactor` | 重构（不改变行为） |
| `style` | 格式调整（不改变逻辑） |
| `perf` | 性能优化 |
| `chore` | 构建、依赖、脚本 |

示例：

```
feat(accounts): 支持中国区 AssumeRole ARN 自动补全 aws-cn 分区
fix(nuke): 修复手工编辑配置被重新生成覆盖的问题
docs(readme): 补充组织账号权限前提说明
```

提交前请自查：

- [ ] 没有提交 `server/data`、`release/`、`runtime/bin/*.exe`、`node_modules`
- [ ] 没有硬编码真实账号 ID、AK/SK、本机绝对路径
- [ ] 前端改动执行过 `npm run build` 且无报错
- [ ] 涉及 UI 的改动附上截图

---

## Pull Request

1. Fork 仓库，从 `main` 拉出特性分支：`git checkout -b feat/your-feature`
2. 改动尽量聚焦单一主题，避免「顺手重构」混进功能 PR
3. 填写 PR 模板（会自动加载），说明**改了什么、为什么改、怎么验证**
4. 涉及真实 AWS 行为的改动，请描述测试用的账号类型与是否只跑了演练

### 不会被接受的 PR

- 引入 emoji 作为 UI 元素
- 未经说明引入新的后端三方依赖
- 移除或弱化二次确认、黑名单、凭证掩码等安全机制
- 提交个人数据、真实账号信息、`aws-nuke.exe` 二进制
- 大范围格式化（纯空格/换行）导致的 diff 噪音

---

## 报告问题

- **Bug**：[新建 Issue](https://github.com/zfmyty/aws-nuke-platform/issues/new?template=bug_report.yml)
- **功能建议**：[新建 Issue](https://github.com/zfmyty/aws-nuke-platform/issues/new?template=feature_request.yml)
- **安全漏洞**：见 [SECURITY.md](SECURITY.md)

提问前请先搜索已有 Issue，并附上：

- 平台版本、Windows 版本、Node 版本
- 任务中心里的**脱敏后**日志片段
- 复现步骤与预期结果

> 贴日志前务必确认其中不含 AK/SK、Session Token、真实账号 ID。

---

## 许可

提交贡献即视为同意以本项目的 [MIT License](LICENSE) 授权该贡献。
