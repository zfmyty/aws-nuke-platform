/**
 * 读取本机 AWS CLI 配置文件（只读，绝不修改）：
 *   ~/.aws/credentials  -> [default] / [子账号名] 存 AK/SK
 *   ~/.aws/config       -> [default] / [profile 名称] 存 role_arn、source_profile、region
 *
 * 用途：
 *   1. 让「assume-role」模式可以复用用户已有的凭证 profile 作为基础凭证
 *   2. 识别某个 profile 是否本身就是「角色 profile」（config 里带 role_arn），
 *      避免把角色 profile 当作 base 凭证导致二次 AssumeRole
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 解析 INI：支持 [name] 与 [profile name] 两种写法 */
function parseIni(text) {
  const sections = {}
  let current = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[(.+)]$/)
    if (section) {
      let name = section[1].trim()
      if (name.startsWith('profile ')) name = name.slice('profile '.length).trim()
      current = name
      if (!sections[current]) sections[current] = {}
      continue
    }
    if (!current) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    sections[current][key] = value
  }
  return sections
}

export function awsFilePaths() {
  return {
    credentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials'),
    configFile: process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config'),
  }
}

/** 汇总 credentials 与 config，返回 profile 视图（不含密钥明文） */
export function listAwsProfiles() {
  const { credentialsFile, configFile } = awsFilePaths()
  const credentials = parseIni(readFileSafe(credentialsFile))
  const config = parseIni(readFileSafe(configFile))
  const names = [...new Set([...Object.keys(credentials), ...Object.keys(config)])].sort()

  return names.map((name) => {
    const creds = credentials[name] || {}
    const conf = config[name] || {}
    return {
      name,
      hasStaticKeys: Boolean(creds.aws_access_key_id && creds.aws_secret_access_key),
      hasSessionToken: Boolean(creds.aws_session_token),
      roleArn: conf.role_arn || '',
      sourceProfile: conf.source_profile || '',
      region: conf.region || '',
    }
  })
}

export function getAwsProfile(name) {
  if (!name) return null
  return listAwsProfiles().find((profile) => profile.name === name) || null
}
