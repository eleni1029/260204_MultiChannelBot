import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'

const prisma = new PrismaClient()

const PERMISSIONS = {
  // 客戶
  'customer.view': '查看客戶',
  'customer.create': '新增客戶',
  'customer.edit': '編輯客戶',
  'customer.delete': '刪除客戶',

  // 群聊
  'group.view': '查看群聊',
  'group.edit': '編輯群聊',

  // 人員
  'member.view': '查看人員',
  'member.edit': '編輯人員（標記角色）',

  // 訊息
  'message.view': '查看訊息',

  // 問題
  'issue.view': '查看問題',
  'issue.edit': '編輯問題',

  // 分析
  'analysis.run': '執行分析',

  // 知識庫
  'knowledge.view': '查看知識庫',
  'knowledge.create': '新增知識庫',
  'knowledge.edit': '編輯知識庫',
  'knowledge.delete': '刪除知識庫',

  // 用戶
  'user.view': '查看用戶',
  'user.create': '新增用戶',
  'user.edit': '編輯用戶',
  'user.delete': '刪除用戶',

  // 角色
  'role.view': '查看角色',
  'role.create': '新增角色',
  'role.edit': '編輯角色',
  'role.delete': '刪除角色',

  // 設定
  'setting.view': '查看設定',
  'setting.edit': '編輯設定',

  // 日誌
  'log.view': '查看日誌',
}

async function main() {
  console.log('Seeding database...')

  // 建立預設角色
  const superAdmin = await prisma.role.upsert({
    where: { name: '超級管理員' },
    update: {},
    create: {
      name: '超級管理員',
      description: '擁有所有權限',
      permissions: Object.keys(PERMISSIONS),
      isSystem: true,
    },
  })
  console.log('Created role: 超級管理員')

  const admin = await prisma.role.upsert({
    where: { name: '管理員' },
    update: {},
    create: {
      name: '管理員',
      description: '除角色管理外的所有權限',
      permissions: Object.keys(PERMISSIONS).filter((p) => !p.startsWith('role.')),
      isSystem: true,
    },
  })
  console.log('Created role: 管理員')

  const agent = await prisma.role.upsert({
    where: { name: '客服' },
    update: {},
    create: {
      name: '客服',
      description: '查看與處理客戶問題',
      permissions: [
        'customer.view',
        'group.view',
        'member.view',
        'message.view',
        'issue.view',
        'issue.edit',
      ],
      isSystem: true,
    },
  })
  console.log('Created role: 客服')

  // 建立預設管理員帳號
  const passwordHash = await bcrypt.hash('admin123', 10)
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@example.com',
      passwordHash,
      displayName: '系統管理員',
      roleId: superAdmin.id,
    },
  })
  console.log('Created user: admin')

  // 建立預設系統設定
  // AI Provider 優先級: gemini-oauth > claude-code-oauth > claude > gemini > ollama
  const defaultSettings = [
    { key: 'ai.provider', value: 'gemini-oauth', description: 'AI Provider (gemini-oauth/claude-code-oauth/claude/gemini/ollama)' },
    { key: 'ai.claude.apiKey', value: '', description: 'Claude API Key' },
    { key: 'ai.claude.model', value: 'claude-sonnet-4-5-20250929', description: 'Claude Model' },
    { key: 'ai.gemini.apiKey', value: '', description: 'Gemini API Key' },
    { key: 'ai.gemini.model', value: 'gemini-2.5-pro', description: 'Gemini Model' },
    { key: 'ai.gemini.projectId', value: '', description: 'GCP Project ID (for Vertex AI)' },
    { key: 'ai.gemini.location', value: 'us-central1', description: 'GCP Location (for Vertex AI)' },
    { key: 'ai.ollama.baseUrl', value: 'http://localhost:11434', description: 'Ollama Base URL' },
    { key: 'ai.ollama.model', value: 'llama3', description: 'Ollama Model' },
    { key: 'issue.timeoutMinutes', value: '15', description: '問題超時時間（分鐘）' },
    { key: 'issue.replyThreshold', value: '60', description: '回覆相關性閾值' },
    { key: 'line.channelSecret', value: '', description: 'LINE Channel Secret' },
    { key: 'line.channelAccessToken', value: '', description: 'LINE Channel Access Token' },
    { key: 'bot.autoReply', value: 'false', description: '是否啟用自動回覆' },
    { key: 'bot.notFoundReply', value: '抱歉，我目前無法回答這個問題。請稍候，會有專人為您服務。', description: '無法回答時的回覆內容' },
    { key: 'bot.name', value: '', description: 'Bot 名稱（多個名稱用逗號分隔，提及名稱時會強制回覆）' },
    { key: 'bot.confidenceThreshold', value: '50', description: '自動回覆信心度閾值（0-100）' },
    { key: 'webhook.customDomain', value: '', description: '自訂固定域名（例如 https://bot.example.com）' },
    { key: 'tunnel.mode', value: 'fixed', description: 'Tunnel 模式 (quick/fixed)' },
    { key: 'tunnel.cloudflareToken', value: '', description: 'Cloudflare Tunnel Token（Fixed 模式使用）' },
  ]

  for (const setting of defaultSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    })
  }
  console.log('Created default settings')

  console.log('Seeding completed!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
