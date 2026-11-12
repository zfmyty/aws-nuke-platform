# AWS Nuke 管理平台 · 详细文档

> 面向多账号场景的 [aws-nuke](https://github.com/ekristen/aws-nuke) 编排平台：统一托管凭证、生成清理配置、演练与执行全程留痕，并按角色隔离数据。

本文是 [README.md](README.md) 的深度版，覆盖目录结构、分层约定、接口清单、组织场景手册、打包发布与完整排错。

- 前端：Vue 3 + Vite（单页应用，深色科技风，纯 SVG 图标）
- 后端：Node.js + Express（分层模块化，仅依赖 express 一个三方包）
- 存储：文件级 JSON 文档库（`server/data`），零数据库依赖
- 运行时：aws-nuke v3.68.3 Windows 二进制（不入库，见 [Releases](../../releases)）

---

## 目录

- [一、功能一览](#一、功能一览)
- [二、目录结构](#二、目录结构)
- [三、快速开始](#三、快速开始)
- [四、一键部署流程](#四、一键部署流程)
- [五、组织账号（AssumeRole）场景](#五、组织账号（AssumeRole）场景)
- [六、安全设计](#六、安全设计)
- [七、接口概览](#七、接口概览)
- [八、常见问题](#八、常见问题)
- [九、许可](#九、许可)

## 一、功能一览

| 模块 | 能力 |
| --- | --- |
| 权限体系 | 管理员 / 普通用户双角色，JWT 鉴权，路由与接口双重校验 |
| 账号管理 | 三种接入方式：组织跨账号（AssumeRole）／账号 AK/SK 直连／本机 CLI Profile；批量勾选演练 / 真实删除 |
| 规则编排 | 区域选择、资源类型排除、保留资源过滤器（精确 / 包含 / 通配 / 正则） |
| 配置生成 | 按需生成 aws-nuke v3 YAML，支持 `explain-config` 离线校验 |
| 执行引擎 | 演练（dry-run）与真实删除（--no-dry-run）双模式：**直接执行** / **扫描后确认**——扫描完成后暂停并展示资源清单，输入账号别名确认才开始删除，超时自动中止 |
| 任务中心 | SSE 实时日志、执行摘要、记录单条/批量删除（含日志文件）、待确认状态；轮询间隔由管理员统一配置 |
| 安全防线 | 平台黑名单、账号 ID 二次确认 + 可选扫描后别名确认、AWS CLI 运行中免重启识别、审计日志 |
| 界面体验 | 顶栏服务在线/离线真实健康检测（间隔管理员可配）、Ctrl+Enter 优雅退出、别名检测结果服务端留档 |
| 一键部署 | 自动解压二进制、一键安装 AWS CLI、STS 校验凭证 |

### 角色权限矩阵

| 能力 | 管理员 admin | 普通用户 user |
| --- | --- | --- |
| 查看账号列表 | 全部用户提交的账号 | 仅自己提交的账号 |
| 编辑 / 删除账号 | 全部 | 仅自己的 |
| 触发演练 | 全部 | 仅自己的 |
| 触发真实删除 | 全部 | 受「允许普通用户真实删除」开关控制 |
| 用户管理 | 可增删改、禁用 | 不可见 |
| 部署向导 / 平台设置 / 审计日志 | 可见 | 不可见 |

> 数据隔离在服务端强制生效（`getAccountForUser` / `job.ownerId` 校验），前端隐藏菜单只是体验层。

---

## 二、目录结构

```
aws-nuke-platform/                  # 仓库根目录
├── package.json                    # 根脚本：安装、构建、运行、打包
├── start.bat / stop.bat / check.bat   # Windows 启动 / 停止 / 环境检测入口（仅做转调）
├── scripts/
│   ├── env.ps1                     # 环境检测与自动配置（Node 便携版下载、依赖检查）
│   ├── start.ps1                   # 启动逻辑：环境检查、端口探测、前台运行 node
│   ├── check.ps1                   # 环境检测：逐项报告前置条件与修复建议
│   ├── stop.ps1                    # 停止逻辑：按端口结束进程树并复查
│   └── pack.mjs                    # 发布打包脚本
├── runtime/bin/                    # 运行时二进制目录（aws-nuke.exe 不入库，仅留 .gitkeep）
│
├── server/                         # 后端
│   ├── package.json
│   ├── src/
│   │   ├── index.js                # 入口：初始化 → 自举二进制 → 监听
│   │   ├── app.js                  # 应用装配：中间件 → 路由 → 静态资源
│   │   ├── config/index.js         # 路径 / 端口 / 运行参数集中管理（全部环境变量在此）
│   │   ├── lib/                    # 与业务无关的基础能力
│   │   │   ├── store.js            # JSON 集合（原子写入）
│   │   │   ├── crypto.js           # scrypt 口令散列 + AES-256-GCM 加密
│   │   │   ├── token.js            # HMAC-SHA256 令牌
│   │   │   ├── shell.js            # 进程执行、二进制解析、CLI/aws-nuke 路径探测
│   │   │   ├── bootstrap.js        # 自动解压 aws-nuke
│   │   │   ├── awsConfig.js        # ~/.aws 读写（profile 列举、角色 profile 识别）
│   │   │   ├── http.js             # 外网请求统一出口（GET 文本 / 下载文件）
│   │   │   ├── proxy.js            # 代理探测：读注册表系统代理，有代理时走 curl
│   │   │   ├── errors.js           # 统一业务异常
│   │   │   └── logger.js           # 分级日志
│   │   ├── middleware/             # auth（鉴权 + 角色）、cors、error
│   │   ├── modules/                # 领域模块（路由 + 服务 + 规则）
│   │   │   ├── auth/               # 登录、令牌、改密
│   │   │   ├── users/              # 用户 CRUD
│   │   │   ├── accounts/           # AWS 账号与凭证
│   │   │   │   ├── assume.js       # runInAccount：按 authMode 解析凭证后执行 CLI
│   │   │   │   ├── discovery.js    # 组织账号列举（Organizations API）
│   │   │   │   └── alias.js        # IAM 别名查询 / 创建
│   │   │   ├── nuke/               # 配置生成（configBuilder）+ 冻结（configFile）+ 编排
│   │   │   ├── jobs/               # 任务运行器（进程 + SSE + 日志）
│   │   │   ├── system/             # 环境自检、安装 CLI、凭证校验、二进制更新
│   │   │   ├── settings/           # 全局设置单文档
│   │   │   ├── dashboard/          # 概览聚合
│   │   │   └── audit/              # 审计日志
│   │   └── scripts/                # 运维脚本（update-aws-nuke.mjs）
│   ├── data/                       # 运行期数据（自动生成，已 gitignore）
│   │   ├── db/*.json               # users / accounts / jobs / audit / settings / updates
│   │   ├── configs/*.yaml          # 生成给 aws-nuke 的配置（生成即冻结）
│   │   ├── logs/<jobId>.log        # 任务原始日志
│   │   ├── .master.key             # 加密主密钥
│   │   └── .token.secret           # 令牌签名密钥
│   └── public/                     # 前端构建产物（npm run build 生成，已 gitignore）
│
└── web/                            # 前端
    ├── vite.config.js              # 构建产物输出至 server/public
    ├── index.html
    ├── public/                     # 静态资源：bg.jpg（背景）/ logo.png / icon.png
    └── src/
        ├── main.js / App.vue
        ├── router/index.js         # 路由 + 登录/管理员守卫
        ├── api/                    # client（fetch 封装）+ 领域接口
        ├── stores/                 # Pinia：auth / system / toast
        ├── layouts/AppShell.vue    # 侧边导航 + 顶栏
        ├── components/             # AppIcon / AppModal / AppEmpty / RunDialog / ToastHost
        ├── views/                  # 12 个页面
        ├── styles/                 # tokens / base / components
        └── utils/format.js         # 时间、状态、徽章语义映射
```

### 分层约定

```
视图层 (views) → 接口层 (api) → 路由层 (modules/*/routes.js)
                                      ↓
                               服务层 (modules/*/service.js)
                                      ↓
                         基础能力 (lib: store / crypto / shell)
```

- **视图层不拼接 URL、不推断权限**，只消费 API 与 store。
- **路由层只做参数校验与响应封装**；业务规则集中在 service。
- **敏感字段只在 service 内解密**，出口统一掩码。
- 跨模块依赖单向：`nuke → accounts / settings / jobs`，无循环引用。

---

## 三、快速开始

### 获取代码

```bash
git clone https://github.com/zfmyty/aws-nuke-platform.git
cd aws-nuke-platform
```

### 开发模式

```bash
npm run install:all      # 安装前后端依赖
npm run dev:server       # 后端 http://localhost:3000
npm run dev:web          # 前端 http://localhost:5173（已代理 /api）
```

> 仓库不包含 `aws-nuke.exe`（320MB，不适合进版本库）。首次开发前请到
> [ekristen/aws-nuke Releases](https://github.com/ekristen/aws-nuke/releases) 下载
> `aws-nuke-v3.68.3-windows-amd64.zip`，把 `aws-nuke.exe` 放到 `runtime/bin/`；
> 也可以在页面「平台运维 → 部署向导」里一键下载。

### 生产模式（单端口）

```bash
npm run build            # 前端构建到 server/public
npm start                # 访问 http://localhost:3000
```

Windows 下也可以双击 `start.bat`。

### 启动与停止

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 环境自检 | 双击 `check.bat` | 只检查不启动：Node / npm / 依赖 / 前端产物 / 系统 tar / aws-nuke / 端口占用，逐项列出缺失项与修复建议 |
| 日常启动 | 双击 `start.bat` | 会先弹出 UAC 询问管理员权限：点「是」以管理员权限启动（可一键安装 AWS CLI），点「否」回退为普通启动，功能不受影响。弹出的那个 CMD 窗口**就是服务进程**，请求日志与任务日志实时打印在里面 |
| 正常停止 | 在窗口内按 `Ctrl+Enter` | 优雅退出：先终止正在执行的 aws-nuke 子进程，再关闭 HTTP 服务。Ctrl+C 已停用（不再出现 "Terminate batch job (Y/N)?"），启动后浏览器自动打开 |
| 直接停止 | 关闭那个 CMD 窗口 | 效果等同于杀掉进程，数据不会损坏（每次写入即落盘），但运行中的任务会中断 |
| 强制停止 | 双击 `stop.bat` | 按端口定位进程、连带子进程一起结束，并复查端口是否释放 |
| 换端口 | `start.bat -Port 3001`；停止用 `stop.bat 3001` | 默认 3000 |
| 不开浏览器 | `start.bat -NoBrowser` | 只想看控制台日志时使用 |

实现上 `start.bat` / `stop.bat` / `check.bat` 只是几行启动器，真正的逻辑在 `scripts/*.ps1`（UTF-8 BOM，避免中文在 GBK 控制台下乱码），改行为只改脚本即可。

### 运行环境与自动配置

`scripts/env.ps1` 负责前置条件检测与补齐，被 `start.ps1` 和 `check.ps1` 共用：

| 依赖 | 检测方式 | 缺失时 |
| --- | --- | --- |
| Node.js ≥ 18 | 先看 `runtime\node`（便携版），再查 PATH 与常见安装目录 | **询问后自动下载**官方便携版到 `runtime\node`，不改系统环境变量、不需要管理员权限 |
| npm | 跟随 Node 同目录的 `npm.cmd` | 随 Node 一并具备 |
| 后端依赖 | `server\node_modules\express` | 首次启动自动执行 `npm install` |
| 前端产物 | `server\public\index.html` | 无法自动生成，提示在开发机 `npm run build` |
| 系统 tar | `System32\tar.exe` | 可选，解压时自动退化为内置解压 |
| aws-nuke | `runtime\bin\aws-nuke.exe` | 启动平台后在「部署向导」一键下载 |

几个细节：

- **便携版 Node 的版本不写死**：先从官方 `SHASUMS256.txt` 解析当前 v22 的最新版本号，再拼下载地址；官方源失败时自动改用 npmmirror 镜像。
- **`$env:PATH` 只在当前窗口生效**，退出即恢复，不污染系统。
- **探测失败不等于未安装**：如果 `node.exe` 存在但 `node -v` 执行不了（权限受限、被杀软拦截），不会触发下载，只提示「版本探测失败」后继续启动——避免为了一个探测问题白下载 30MB。


**窗口为何常驻**：`start.ps1` 以**前台**方式运行 `node server\src\index.js`，脚本末尾有「按回车键关闭窗口」兜底，
因此窗口会停在「运行中」状态并持续输出日志；即使服务异常退出，窗口也会保留并显示退出码，便于排查。

**查看运行状况**：
- 窗口内日志：启动信息（Node 路径、数据目录、访问地址）、每个业务请求的日志、任务摘要
- 任务级日志：网页「任务中心」实时查看，原始文件在 `server/data/logs/<jobId>.log`
- 服务是否在线：`netstat -ano | findstr :3000` 或直接访问首页

> 数据安全：账号、任务、设置均为原子写入（临时文件 + rename），强杀进程不会写坏 JSON；只有"正在执行的 aws-nuke 任务"会被标记为「服务重启，任务被中断」。


### 初始账号

首次启动自动创建管理员：

```
用户名：admin
密码  ：Admin@123456
```

> 可通过环境变量 `SEED_ADMIN_USER` / `SEED_ADMIN_PASS` 覆盖；登录后请立即在「个人信息」修改密码。

### 打包发布

```bash
npm run pack                    # 生成 release/aws-nuke-platform-v1.0.0.zip（不含 exe）
npm run pack -- --with-binary   # 连同 aws-nuke.exe 一起打包（约 300MB，文件名带 -full 后缀）
```

发布包通过 [GitHub Releases](../../releases) 分发，`release/` 目录本身已 gitignore，不进版本库。
每次发版建议：`git tag v1.0.0 && git push --tags`，然后在 Releases 页把 zip 作为附件上传。

打包采用**白名单复制**：只会收集根目录的 `package.json` / `README.md` / 三个 `.bat`、`scripts/*.ps1`、
`server/src`、`server/public`（仅 `index.html` + `assets`）、`server/node_modules`、`runtime/bin` 占位与
`server/data/.gitkeep`。开发资产 `web/`、`测试文件/`、`相关文件/`、`.workbuddy/`、`release/` 天然不参与，
新增开发目录也不需要改脚本；反过来说，**要让新目录进包必须显式加进 `COPY_PLAN`/`ROOT_FILES`**。

生成 zip 前会执行一次自检，出现下列任一情况直接失败且不出包：

- 混入禁运目录（`测试文件`、`相关文件`、`.workbuddy`、`web`、`release`、`node_modules` 顶层）
- `server/data` 里除 `.gitkeep` 之外还有任何文件（数据库、密钥、日志）
- 未加 `--with-binary` 却包含 `aws-nuke.exe`
- 文本文件中出现 `AKIA...` 形态的密钥、非示例 12 位账号 ID、本机用户路径

确认是误报时可加 `--skip-audit` 跳过，但请先逐项核对报告内容。

目标机器解压后双击 `check.bat` 确认环境，再双击 `start.bat` 启动。后端依赖已内联无需联网；
若目标机器没有 Node.js，启动时会询问并自动下载官方便携版到 `runtime\node`（约 30MB，仅解压到项目内，不装系统）。

---

## 四、一键部署流程

进入「平台运维 → 部署向导」，三个步骤均有实时状态：

1. **aws-nuke 可执行文件** — 放置 `runtime/bin/aws-nuke.exe`；若项目根目录存在官方 zip，服务启动时会自动解压。
2. **AWS CLI v2** — 点击「一键安装」执行官方脚本 `irm https://awscli.amazonaws.com/v2/install.ps1 | iex`，日志实时回显（安装到系统目录需管理员权限）。
3. **主账号凭证与使用方式** — 先选使用方式，再决定这一步要不要填：
   - **组织跨账号**（默认）：填主账号 IAM 用户的 AK/SK，用于 `sts:AssumeRole` 进入成员账号；
     主账号会自动并入黑名单，任何角色都无法把它当清理目标。
   - **单账号直连**：直接用账号自身的 AK/SK（含 root 凭证）清理本账号，**这一步可跳过**；
     此时平台不保存主账号凭证，也**不会**把主账号自动并入黑名单（否则目标账号会被自身锁死），
     账号密钥在「账号管理 → 提交账号」中逐个填写。

   凭证填写方式与 `aws configure` 一致，**只需 Access Key / Secret**；区域等留空即沿用 CLI 默认值（高级选项可改）。后端实际执行：
   ```bash
   aws configure set aws_access_key_id <AK> --profile <profile>
   aws configure set aws_secret_access_key <SK> --profile <profile>
   # 仅当填了区域时才写入：aws configure set region <region> --profile <profile>
   aws sts get-caller-identity --profile <profile>
   ```
   校验通过后加密入库，同时把 profile 写入本机 `~/.aws/credentials`；若 STS 校验失败，会回滚刚写入的 profile，不污染原有配置。

> 单条账号的配置是否合法，可在「账号详情 → 配置预览 → 校验配置」里用 `aws-nuke explain-config` 离线解析，不必在部署向导里做。

### 配置文件的生成与冻结

每个账号的 aws-nuke YAML 存在 `server/data/configs/account-<账号ID>.yaml`，生命周期是**生成一次即冻结**：

- 账号创建时生成第一份；之后无论是改平台设置（黑名单、默认区域、主账号使用方式）还是改账号规则，**都不会自动改写它**；
- 执行演练/删除时使用的就是这份文件，所以演练结果与真实执行的范围始终一致；
- 要让新规则生效，进入「账号详情 → 配置」：
  - **编辑** — 直接改 YAML 后保存，标记为「手工编辑」，平台永不覆盖；
  - **重新生成** — 按当前账号规则与平台设置重写（会覆盖手工内容，有二次确认）；
- 配置与当前设置不一致时，页面会提示「配置可能已过期」，但不会偷偷替换。

组织跨账号账号的黑名单保护与这个开关无关：只要账号认证方式是「组织跨账号」，主账号 ID 一定会写进它的 `blocklist`，
不会因平台切换为「单账号直连」而被移除。

---

## 五、组织账号（AssumeRole）场景

当账号结构为 **管理账号（主账号）+ Organizations 成员账号（子账号）** 时，无需为每个子账号单独创建 IAM 用户，
也不应将子账号密钥交给平台。推荐做法是用主账号的一个 IAM 用户 `sts:AssumeRole` 扮演子账号内的组织角色。

```
主账号 IAM 用户 (AK/SK)
        │  sts:AssumeRole
        ▼
子账号角色  arn:aws:iam::<子账号ID>:role/OrganizationAccountAccessRole
        │  临时凭证（15min~12h，自动轮转，不落盘）
        ▼
aws-nuke 以子账号身份扫描 / 删除资源
```

### 权限前提

1. **主账号 IAM 用户**需要 `sts:AssumeRole` 权限。建议只授权到具体角色，例如：

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "sts:AssumeRole",
       "Resource": "arn:aws:iam::*:role/OrganizationAccountAccessRole"
     }]
   }
   ```

2. **子账号角色**的信任策略需允许主账号主体。Organizations 创建成员账号时自动生成的 `OrganizationAccountAccessRole` 默认信任管理账号 root（`arn:aws:iam::<主账号ID>:root`），因此只要上面的 IAM 用户有 AssumeRole 权限即可，**不需要改信任策略**。

3. 该角色默认附加 `AdministratorAccess`，满足 aws-nuke 的删除权限要求；若是自定义角色，需补齐对应资源的查询与删除权限。

4. 如果角色信任策略附加了 MFA 条件（`aws:MultiFactorAuthPresent`），命令行 AssumeRole 会失败。本平台不代填动态验证码，需为自动化用户单独放宽该条件。

### 平台操作步骤

1. **部署向导 → 主账号 IAM 用户凭证**：填入主账号 IAM 用户的 AK/SK，保存时平台会 `aws configure set` 写入本机 profile 并调用 STS 校验身份。
2. **平台设置 → 默认清理范围**：确认「组织默认角色名」为 `OrganizationAccountAccessRole`（可改为 `AWSControlTowerExecution` 等），以及 AssumeRole Session 名称。
3. **账号管理 → 提交账号**：认证方式选「组织跨账号」，填写子账号 ID 即可，角色 ARN 自动拼成 `arn:aws:iam::<子账号ID>:role/OrganizationAccountAccessRole`；中国区等特殊分区可直接填完整 ARN（`arn:aws-cn:...`）。
   - **基础凭证来源**可选：`平台主账号凭证`（用部署向导保存的 AK/SK）或某个本机 profile（如只放密钥的 `[master]`）。
4. **账号详情 → 测试连接**：平台会真实执行一次 `sts:AssumeRole` 并用临时凭证调用 `get-caller-identity`，
   返回实际身份是否为子账号、ARN 是否正确。
5. 确认无误后再演练 / 真实删除。

### 与现有 ~/.aws 文件的关系

平台不要求改变现有做法，下列文件结构均可直接使用：

| 文件 | 内容 | 平台中的对应设置 |
| --- | --- | --- |
| `~/.aws/credentials` → `[default]` | 主账号 AK/SK | 部署向导写入的 profile（默认 `nuke-operator`），或作为「基础凭证」的可选 profile |
| `~/.aws/config` → `[default]` 带 `role_arn` + `source_profile` | 角色 profile | 认证方式选「CLI Profile」，profile 名填 `default`，平台只传 `--profile default` |
| `~/.aws/config` → `[profile 子账号名]` 带 `role_arn` | 每个子账号一个角色 profile | 同上，profile 名填对应名称 |

关键区别：

- **角色 profile**（config 中含 `role_arn`）只能用于「CLI Profile」模式，**不可**作为「基础凭证」——
  否则会构成「先 assume 再 assume」的二次 AssumeRole，通常会被信任策略拒绝。平台在保存时会拦截并说明原因。
- 「基础凭证」需要的是**只放 AK/SK 的 profile**（如 `[master]`）。界面会列出本机全部 profile，并将角色 profile 标注为不可选。

> 提示：`[default]` 上挂 `role_arn` 虽可工作（SDK 会用 credentials 中同名静态密钥作为 source），
> 但会使该机器上**所有**默认 profile 的 AWS 命令都走 AssumeRole，容易影响其它工具。
> 多账号场景建议使用独立 profile 名，例如 `[profile nuke-111122223333]`。

### 自动保护认证角色（重要）

清理成员账号时，正在用于认证的 `OrganizationAccountAccessRole` **本身就位于目标账号内**。
若 aws-nuke 删除该角色或其策略附件，当前会话会立即失去权限，后续资源全部删除失败。

平台默认会在生成配置时自动追加 4 条过滤（可在「平台设置 → 自动保护认证角色」关闭）：

```yaml
accounts:
  "111122223333":
    filters:
      IAMRole:
        - "OrganizationAccountAccessRole"
      IAMRolePolicy:                  # 内联策略
        - property: RoleName
          type: exact
          value: "OrganizationAccountAccessRole"
      IAMRolePolicyAttachment:        # 托管策略附件
        - property: RoleName
          type: exact
          value: "OrganizationAccountAccessRole"
      IAMInstanceProfile:
        - "OrganizationAccountAccessRole"
```

效果等同于手写配置中的 `IAMRole` + `IAMRolePolicyAttachment → "角色名 -> AdministratorAccess"`，
但采用 `property: RoleName` 匹配，不依赖具体策略名（即使 `AdministratorAccess` 被替换为其它策略，保护依然生效）。

### 与 AK/SK 直连的区别

| 维度 | 组织跨账号（AssumeRole） | 账号 AK/SK 直连 |
| --- | --- | --- |
| 需要保存子账号密钥 | 不需要 | 需要（加密存储） |
| 凭证有效期 | 临时凭证，自动过期 | 长期，需人工轮转 |
| 撤销方式 | 改信任策略 / 回收 AssumeRole 权限，立即生效 | 删除子账号 IAM 用户密钥 |
| 审计 | CloudTrail 记录 `AssumedRole` 会话，含 Session 名称 | 记录为该 IAM 用户本人 |
| 适用场景 | Organizations 多账号批量清理 | 独立账号、无组织关系 |

### 常见失败原因

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `not authorized to perform: sts:AssumeRole` | IAM 用户缺少 AssumeRole 权限，或信任策略不含该主体 | 补充 IAM 策略 / 检查角色信任策略 |
| `InvalidClientTokenId` | 主账号 AK/SK 错误或已被禁用 | 在部署向导中重新保存凭证 |
| `The config profile () could not be found` | 平台未保存凭证且本机 profile 不存在 | 完成第 1 步配置主账号凭证 |
| `MultiFactorAuthPresent` 相关拒绝 | 角色强制 MFA | 为自动化用户放宽 MFA 条件 |
| `account X is not configured in the config file` | 角色 ARN 指向的账号与账号记录不一致 | 检查账号 ID 与角色 ARN |
| `is not authorized to perform: sts:AssumeRole`（目标为自己） | 将角色 profile 用作基础凭证，触发二次 AssumeRole | 基础凭证换用只放 AK/SK 的 profile，或改用「CLI Profile」模式 |
| `The config profile (X) could not be found` | profile 名不存在于 ~/.aws | 在账号编辑页从下拉列表中选择，或先执行 `aws configure --profile X` |

---

## 六、安全设计

- **凭证加密**：AK/SK 以 AES-256-GCM 加密存储，主密钥 `data/.master.key` 首次启动随机生成（0600）。
- **口令散列**：scrypt + 随机盐，恒定时间比较。
- **黑名单**：命中平台黑名单的账号，任何角色都无法执行（`assertNotBlocked`）。
- **二次确认**：真实删除必须精确输入 12 位账号 ID，且同时勾选模式。
- **普通用户删除权**：可在平台设置中一键关闭，关闭后普通用户只能演练。
- **参数脱敏**：任务参数与日志中的 `--secret-access-key` / `--session-token` 统一替换为 `********`。
- **审计留痕**：登录、账号变更、凭证配置、任务触发均写入 `audit.json`，含操作人 IP。

> 本平台面向内网运维场景，默认不启用 HTTPS。公网部署请置于反向代理之后并开启 TLS。

---

## 七、接口概览

所有接口挂在 `/api` 前缀下，除标注「公开」外均需登录（`Authorization: Bearer <token>`）；
「管理员」表示额外要求 `role=admin`，「属主/管理员」表示按资源归属校验。

### 认证与用户

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查（顶栏服务在线/离线检测） | 公开 |
| POST | `/api/auth/login` | 登录换取令牌 | 公开 |
| GET | `/api/auth/me` | 当前用户 | 登录 |
| POST | `/api/auth/password` | 修改密码 | 登录 |
| GET | `/api/users` | 用户列表 | 管理员 |
| POST | `/api/users` | 新建用户 | 管理员 |
| PATCH | `/api/users/:id` | 修改用户（角色 / 状态 / 密码） | 管理员 |
| DELETE | `/api/users/:id` | 删除用户 | 管理员 |
| GET | `/api/dashboard` | 概览聚合数据 | 登录 |

### 账号

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/accounts` | 账号列表（自动按角色过滤） | 登录 |
| POST | `/api/accounts` | 提交账号 | 登录 |
| GET | `/api/accounts/:id` | 账号详情 | 属主/管理员 |
| PATCH | `/api/accounts/:id` | 编辑账号 | 属主/管理员 |
| DELETE | `/api/accounts/:id` | 删除账号 | 属主/管理员 |
| GET | `/api/accounts/organization` | 列举 Organizations 成员账号 | 管理员 |
| POST | `/api/accounts/organization/import` | 批量导入成员账号 | 管理员 |
| GET | `/api/accounts/:id/config` | 读取账号配置（不存在时生成一次）及状态 | 属主/管理员 |
| PUT | `/api/accounts/:id/config` | 手工保存配置（标记为 manual，不再自动覆盖） | 属主/管理员 |
| POST | `/api/accounts/:id/config/regenerate` | 按当前规则与设置重新生成配置 | 属主/管理员 |
| POST | `/api/accounts/:id/verify` | 测试连接（真实 STS / AssumeRole 身份校验） | 属主/管理员 |
| GET | `/api/accounts/:id/alias` | 查询 AWS 别名（结果快照留档） | 属主/管理员 |
| POST | `/api/accounts/:id/alias` | 创建 AWS 别名 | 属主/管理员 |
| POST | `/api/accounts/:id/run` | 演练 / 真实删除（live 可选直接执行或扫描后确认） | 属主/管理员 |

### 任务

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/jobs` | 任务列表 | 登录（按角色过滤） |
| GET | `/api/jobs/:id` | 任务详情（含摘要与状态） | 属主/管理员 |
| GET | `/api/jobs/:id/log` | 拉取完整日志文本 | 属主/管理员 |
| GET | `/api/jobs/:id/stream` | SSE 实时日志 | 属主/管理员 |
| POST | `/api/jobs/:id/cancel` | 终止任务 | 属主/管理员 |
| POST | `/api/jobs/:id/prompt-confirm` | 扫描后确认：输入别名继续删除 | 属主/管理员 |
| DELETE | `/api/jobs/:id` | 删除单条任务记录（含日志文件） | 属主/管理员 |
| POST | `/api/jobs/batch-delete` | 批量删除任务记录 | 属主/管理员 |

### 系统与运维

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/system/status` | 环境自检（Node / CLI / aws-nuke / 前端产物） | 登录 |
| GET | `/api/system/policy` | 执行策略视图（含轮询/健康检查间隔） | 登录 |
| GET | `/api/system/profiles` | 列出本机 AWS profile（是否含密钥 / 是否角色 profile） | 登录 |
| GET | `/api/system/resource-types` | 可选资源类型清单（供排除规则下拉使用） | 登录 |
| POST | `/api/system/install-cli` | 安装 AWS CLI（长任务） | 管理员 |
| POST | `/api/system/credentials` | 配置并校验主账号凭证 | 管理员 |
| POST | `/api/system/credentials/verify` | 仅校验已存凭证（不覆盖） | 管理员 |
| DELETE | `/api/system/credentials` | 清除主账号凭证与 profile | 管理员 |
| GET | `/api/system/settings` | 读取平台设置 | 管理员 |
| PATCH | `/api/system/settings` | 修改平台设置 | 管理员 |
| POST | `/api/system/explain-config` | 用 `aws-nuke explain-config` 校验账号配置 | 管理员 |
| GET | `/api/system/audit` | 审计日志 | 管理员 |
| GET | `/api/system/aws-nuke/update` | 检查 aws-nuke 上游最新版本 | 管理员 |
| GET | `/api/system/aws-nuke/diagnose` | 二进制诊断（路径 / 版本 / 执行结果） | 管理员 |
| POST | `/api/system/aws-nuke/update` | 下载并替换 aws-nuke 二进制（长任务） | 管理员 |

> 长任务（安装 CLI、更新二进制、演练 / 删除）统一返回 `jobId`，进度通过
> `GET /api/jobs/:id/stream` 的 SSE 推送。

---

## 八、常见问题

**Q：任务报 `NoCredentialProviders`？**
该账号未配置 AK/SK，且指定的 CLI profile 不存在。请在「部署向导」配置主账号凭证，或为该账号选择已有 profile。

**Q：真实删除按钮不可用？**
管理员在「平台设置 → 执行权限」关闭了普通用户删除权，或该账号命中黑名单。

**Q：AWS CLI 安装失败？**
安装脚本需写入 `C:\Program Files`，请以管理员身份启动服务；也可手动安装后重新检测。

**Q：装完 AWS CLI 平台还是识别不到？**
无需重启平台：AWS CLI 的解析会实时读取注册表中的系统/用户 PATH（约 10 秒缓存），
装完稍等片刻即可被识别。仅当 CLI 安装在非标准目录时，用环境变量 `AWS_CLI_PATH` 指定 aws.exe 的完整路径。

**Q：如何完全重置？**
停止服务后删除 `server/data` 目录，重启会重新生成管理员与密钥。

**Q：能清理多少个区域？**
在账号规则中选择 `all` 即覆盖所有已启用区域（aws-nuke 会自动追加 `global`）。

**Q：新增账号时区域为空，是正常的吗？**
是。区域决定清理范围，属于使用者的判断，平台**不做预填**——预填单一区域容易被误解为只清理该区域。
提交账号时按需勾选扫描区域；导入组织账号时填写的区域会同时作为该账号的扫描区域，留空则导入后在编辑页补齐。
平台同样不做区域预检：配置是冻结且可手工编辑的，任何以「账号规则 / 平台设置」为准的预检都会误判手工配置；
区域缺失时由 aws-nuke 在任务日志中直接报错，以其输出为准。

**Q：账号里的「默认区域」和「扫描区域」是什么关系？**
扫描区域（config 的 `regions`）才决定清理哪些地区。
「默认区域」是可选项，只用于建立 AWS SDK 鉴权会话（`aws-nuke --default-region`，官方含义是
"the default aws region to use when setting up the aws auth session"），**与扫描范围无关**；
平台只在账号填了该字段时才会把它传给 aws-nuke。中国区（`aws-cn`）与 GovCloud 账号建议填写，
否则 aws-nuke 可能按全球分区端点建立会话导致鉴权失败；商业区账号留空即可正常执行。

---

## 九、许可与免责

本项目以 MIT License 开源发布（完整文本见 [LICENSE](LICENSE)），Copyright (c) 2026 [zfmyty](https://github.com/zfmyty)。

第三方组件（aws-nuke、Express、Vue、Vite 及各自传递依赖）遵循其原始许可条款，本平台未对源码作任何修改。
完整声明见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。

**使用限制与风险承担条款**见 [DISCLAIMER.md](DISCLAIMER.md)：本平台为个人自用工具，未经安全审计，
仅面向内网环境与已获授权的自有 AWS 账号；公网暴露不在支持范围内，产生的后果由使用者自行承担。
