/**
 * 发布打包：把运行所需文件收拢到 release/ 并生成 zip。
 * 用法：
 *   node scripts/pack.mjs                 # 不含 aws-nuke.exe（体积小，部署时放入 runtime/bin 即可）
 *   node scripts/pack.mjs --with-binary   # 连同 aws-nuke.exe 一起打包
 *   node scripts/pack.mjs --skip-audit    # 跳过打包后自检（仅在你确认误报时使用）
 *
 * 排除原则：**白名单复制**。只复制下面 COPY_PLAN 里列出的路径，
 * 项目根目录下的开发资产（web/、测试文件/、相关文件/、.workbuddy/、release/）一律不参与，
 * 因此新增开发目录时无需改脚本；但反过来说，**要让新目录进包必须显式加进 COPY_PLAN**。
 *
 * 打包结束会做一次自检（auditStage）：数据目录被污染、混入禁运目录、出现密钥或个人路径、
 * 出现非示例账号 ID，都会直接失败并且不生成 zip，避免把不该发的东西发出去。
 *
 * 说明：此处使用手写递归复制而非 fs.cpSync，以兼容部分 Node 构建；
 *       压缩优先用系统 bsdtar，失败则回退 PowerShell Compress-Archive。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const withBinary = process.argv.includes('--with-binary')
const skipAudit = process.argv.includes('--skip-audit')

const releaseRoot = path.join(root, 'release')
/** 测试标记：--tag=test 生成 aws-nuke-platform-v1.0.0-test.zip，不影响 package.json 版本号 */
const tagArg = process.argv.find((arg) => arg.startsWith('--tag='))
const tag = tagArg ? tagArg.split('=')[1].replace(/[^a-zA-Z0-9.-]/g, '').replace(/^\.+/, '') : ''

/** 内置二进制时，探测 aws-nuke 版本号作为包名后缀（探测失败退化为 -awsnuke） */
function detectNukeVersion() {
  try {
    const out = execFileSync(path.join(root, 'runtime', 'bin', 'aws-nuke.exe'), ['version'], {
      encoding: 'utf8',
      timeout: 15000,
    })
    const match = String(out).match(/v?(\d+\.\d+\.\d+)/)
    return match ? `-awsnuke-v${match[1]}` : '-awsnuke'
  } catch {
    return '-awsnuke'
  }
}

const stageName = `aws-nuke-platform-v${pkg.version}${tag ? `-${tag}` : ''}${
  withBinary ? detectNukeVersion() : ''
}`
const stage = path.join(releaseRoot, stageName)

/** 根目录下随包分发的单文件（白名单） */
const ROOT_FILES = ['package.json', 'README.md', 'README-DETAIL.md', 'LICENSE', 'THIRD-PARTY-LICENSES.md', 'DISCLAIMER.md', 'start.bat', 'stop.bat', 'check.bat']

/** 绝不允许出现在发布包里的根级目录 —— 仅是兜底，正常流程根本不会复制它们 */
const FORBIDDEN_ROOTS = ['测试文件', '相关文件', '.workbuddy', '.git', 'release', 'web', 'node_modules']

/** 任何层级都跳过的垃圾文件 */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const JUNK_EXT = ['.log', '.tmp', '.bak', '.swp', '.orig']

/** node_modules 里与运行无关的重目录 */
const DEP_SKIP = ['.cache', '.bin', 'doc', 'man']

/** 允许出现的账号 ID：AWS 官方文档示例值 + 平台生成的占位值 */
const ALLOWED_ACCOUNT_IDS = new Set([
  '123456789012',
  '111122223333',
  '444455556666',
  '000000000000',
])

function isJunk(name) {
  if (JUNK_NAMES.has(name)) return true
  if (name.startsWith('.env')) return true
  const lower = name.toLowerCase()
  return JUNK_EXT.some((ext) => lower.endsWith(ext))
}

function copyDir(from, to, skip = () => false) {
  const src = path.join(root, from)
  if (!fs.existsSync(src)) return false
  walk(src, path.join(stage, to), skip)
  return true
}

function walk(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (skip(entry.name, from)) continue
    if (isJunk(entry.name)) continue
    // 跳过符号链接（npm 会为包自身建立自引用链接，复制会形成环路）
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(from, to, skip)
    else fs.copyFileSync(from, to)
  }
}

function sizeOf(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    total += entry.isDirectory() ? sizeOf(target) : fs.statSync(target).size
  }
  return total
}

function listFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(target))
    else out.push(target)
  }
  return out
}

/**
 * 打包后自检：任何一项不通过都不生成 zip。
 * 目的是把「不该发的东西」拦在发布前，而不是发出去再解释。
 */
function auditStage() {
  const problems = []
  const rel = (p) => path.relative(stage, p).replace(/\\/g, '/')

  // 1) 必备文件
  const required = [
    'start.bat',
    'stop.bat',
    'check.bat',
    'package.json',
    'scripts/env.ps1',
    'scripts/start.ps1',
    'scripts/stop.ps1',
    'scripts/check.ps1',
    'server/package.json',
    'server/src/index.js',
    'server/public/index.html',
  ]
  for (const item of required) {
    if (!fs.existsSync(path.join(stage, item))) problems.push(`缺少必备文件：${item}`)
  }

  // 2) 禁运目录
  for (const name of FORBIDDEN_ROOTS) {
    if (fs.existsSync(path.join(stage, name))) problems.push(`混入禁运目录：${name}/`)
  }

  // 3) 运行期数据目录必须干净（只留 .gitkeep）
  const dataDir = path.join(stage, 'server', 'data')
  if (fs.existsSync(dataDir)) {
    for (const name of fs.readdirSync(dataDir)) {
      if (name !== '.gitkeep') problems.push(`server/data 被污染：${name}（数据库/密钥/日志不得随包分发）`)
    }
  } else {
    problems.push('缺少 server/data/.gitkeep')
  }

  // 4) 二进制按需
  const exe = path.join(stage, 'runtime', 'bin', 'aws-nuke.exe')
  if (!withBinary && fs.existsSync(exe)) problems.push('未指定 --with-binary，但包内含有 aws-nuke.exe')

  // 5) 敏感内容扫描（只扫文本类文件）
  //    跳过 server/node_modules：第三方依赖的 CHANGELOG 里本来就有大量长数字串（赞助者 ID 等），
  //    一律扫描会持续误报；依赖是版本化产物，不由本项目编写。
  const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.bat', '.txt', '.html', '.css', '.yaml', '.yml', '.pem', '.env'])
  const USER_PATH_RE = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/"'\s]+)/g
  const ALLOWED_USER_NAMES = new Set(['Public', 'Default', 'Default User', 'All Users', '<你>', 'username', 'YourName'])
  const VENDOR_PREFIX = 'server/node_modules/'

  for (const file of listFiles(stage)) {
    const relative = rel(file)
    if (relative.startsWith(VENDOR_PREFIX)) continue
    const ext = path.extname(file).toLowerCase()
    if (!TEXT_EXT.has(ext)) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }

    if (/AKIA[0-9A-Z]{16}/.test(text)) problems.push(`疑似 AWS Access Key：${relative}`)

    for (const match of text.matchAll(USER_PATH_RE)) {
      const name = match[1]
      if (!ALLOWED_USER_NAMES.has(name)) problems.push(`含本机用户路径（${name}）：${relative}`)
    }

    for (const match of text.matchAll(/(?<!\d)(\d{12})(?!\d)/g)) {
      if (!ALLOWED_ACCOUNT_IDS.has(match[1])) problems.push(`出现非示例账号 ID（${match[1]}）：${relative}`)
    }
  }

  if (!problems.length) return true

  const unique = [...new Set(problems)]
  console.error('\n打包自检未通过，已保留暂存目录以便排查：')
  for (const item of unique.slice(0, 40)) console.error(`  - ${item}`)
  if (unique.length > 40) console.error(`  ... 另有 ${unique.length - 40} 项`)
  console.error('\n确认是误报后可加 --skip-audit 跳过自检，但请先逐项核对上面列出的内容。')
  return false
}

function main() {
  if (!fs.existsSync(path.join(root, 'server', 'public', 'index.html'))) {
    console.error('未找到前端构建产物，请先执行 npm run build')
    process.exit(1)
  }

  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })

  // ---- 根级单文件 ----
  for (const name of ROOT_FILES) {
    const from = path.join(root, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, name))
    else console.warn(`警告：根目录缺少 ${name}`)
  }

  // ---- 启动/检测脚本（打包脚本本身不随发布包分发）----
  const scriptStage = path.join(stage, 'scripts')
  fs.mkdirSync(scriptStage, { recursive: true })
  const scriptDir = path.join(root, 'scripts')
  const ps1Files = fs.readdirSync(scriptDir).filter((name) => name.toLowerCase().endsWith('.ps1'))
  for (const name of ps1Files) {
    fs.copyFileSync(path.join(scriptDir, name), path.join(scriptStage, name))
  }
  if (!ps1Files.includes('env.ps1')) {
    console.warn('警告：scripts/env.ps1 缺失，发布包启动时会因缺少环境模块而失败')
  }

  // ---- 后端源码 ----
  copyDir('server/src', 'server/src')
  fs.copyFileSync(path.join(root, 'server/package.json'), path.join(stage, 'server/package.json'))
  if (fs.existsSync(path.join(root, 'server/package-lock.json'))) {
    fs.copyFileSync(path.join(root, 'server/package-lock.json'), path.join(stage, 'server/package-lock.json'))
  }

  // ---- 前端产物：只取 index.html 与 assets/，不整目录复制，避免夹带调试文件 ----
  fs.mkdirSync(path.join(stage, 'server', 'public'), { recursive: true })
  fs.copyFileSync(path.join(root, 'server/public/index.html'), path.join(stage, 'server/public/index.html'))
  if (!copyDir('server/public/assets', 'server/public/assets')) {
    console.warn('警告：未找到 server/public/assets，前端页面将无法加载')
  }
  // public 根目录的静态资源（favicon、登录壁纸、界面 logo），新增时需同步加入此清单
  for (const name of ['icon.png', 'bg.jpg', 'logo.png']) {
    const from = path.join(root, 'server', 'public', name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, 'server', 'public', name))
  }

  // ---- 后端依赖仅 express，直接内联以支持离线部署（跳过体积大的缓存类目录）----
  const depsCopied = copyDir('server/node_modules', 'server/node_modules', (name) =>
    DEP_SKIP.includes(name),
  )
  if (!depsCopied) console.warn('未找到 server/node_modules，目标机器需执行 npm install')

  // ---- 运行时目录 ----
  fs.mkdirSync(path.join(stage, 'runtime', 'bin'), { recursive: true })
  // MIT 合规：上游版权声明与许可文本必须随副本一同分发
  const nukeLicense = path.join(root, 'runtime', 'bin', 'LICENSE')
  if (fs.existsSync(nukeLicense)) {
    fs.copyFileSync(nukeLicense, path.join(stage, 'runtime', 'bin', 'LICENSE'))
  } else {
    console.error('缺少 runtime/bin/LICENSE（aws-nuke 的 MIT 许可文本），按许可要求不能跳过，打包中止')
    process.exit(1)
  }
  if (withBinary) {
    fs.copyFileSync(path.join(root, 'runtime/bin/aws-nuke.exe'), path.join(stage, 'runtime/bin/aws-nuke.exe'))
    const zip = fs.readdirSync(root).find((name) => /^aws-nuke-.*windows-amd64\.zip$/i.test(name))
    if (zip) fs.copyFileSync(path.join(root, zip), path.join(stage, zip))
  } else {
    fs.writeFileSync(
      path.join(stage, 'runtime', 'bin', 'PUT-AWS-NUKE-EXE-HERE.txt'),
      [
        '把 aws-nuke-v3.68.3-windows-amd64.zip 中的 aws-nuke.exe 放到本目录；',
        '也可以把安装包 zip 直接放在项目根目录，服务首次启动会自动解压。',
        '',
        '下载地址: https://github.com/ekristen/aws-nuke/releases',
      ].join('\r\n'),
      'utf8',
    )
  }

  // ---- 运行期数据目录占位 ----
  fs.mkdirSync(path.join(stage, 'server', 'data'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'server', 'data', '.gitkeep'), '', 'utf8')

  // ---- 自检：不通过就不出 zip ----
  if (!skipAudit && !auditStage()) {
    console.error(`\n暂存目录：${stage}`)
    process.exit(1)
  }

  const size = (sizeOf(stage) / 1024 / 1024).toFixed(1)
  const zipPath = path.join(releaseRoot, `${stageName}${withBinary ? '-full' : ''}.zip`)
  fs.rmSync(zipPath, { force: true })

  // 优先使用 Windows 自带 bsdtar（zip 内路径分隔符规范）；失败则回退 PowerShell
  const bsdtar = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe`
  let zipped = false
  if (fs.existsSync(bsdtar)) {
    try {
      execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', releaseRoot, stageName], { stdio: 'inherit' })
      zipped = true
    } catch {
      zipped = false
    }
  }
  if (!zipped) {
    const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    execFileSync(
      ps,
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'inherit' },
    )
  }

  console.log(`\n发布目录: ${stage} (${size} MB)`)
  console.log(`压缩包  : ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`)
  console.log(
    withBinary
      ? '自检    : 通过（内置 aws-nuke 二进制；无禁运目录、数据目录干净、无密钥与个人路径、无真实账号 ID）'
      : '自检    : 通过（无禁运目录、数据目录干净、无密钥与个人路径、无真实账号 ID）',
  )
}

main()
