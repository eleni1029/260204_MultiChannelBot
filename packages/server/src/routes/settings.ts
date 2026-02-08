import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { authenticate } from '../middlewares/auth.js'
import { requirePermission } from '../middlewares/permission.js'
import { getSettings, updateSettings } from '../services/settings.service.js'
import { createLog } from '../services/log.service.js'
import { resetClient } from '../services/line.service.js'
import { checkFeishuConnection, resetFeishuToken } from '../services/feishu.service.js'

const updateSettingsSchema = z.record(z.string())

interface OAuthStatus {
  provider: string
  valid: boolean
  message: string
  refreshCommand?: string
}

/**
 * 檢查 Claude Code OAuth token 狀態
 * 檢查 ~/.claude.json 是否存在有效的認證資訊
 */
async function checkClaudeCodeOAuth(): Promise<OAuthStatus> {
  // 檢查 Claude Code 認證檔案
  const claudeConfigPath = join(homedir(), '.claude.json')

  if (!existsSync(claudeConfigPath)) {
    return {
      provider: 'claude-code-oauth',
      valid: false,
      message: '未設定 Claude Code OAuth 認證',
      refreshCommand: 'claude setup-token',
    }
  }

  // 檢查 CLI 是否可用
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({
          provider: 'claude-code-oauth',
          valid: false,
          message: '未安裝 Claude Code CLI',
          refreshCommand: 'npm install -g @anthropic-ai/claude-code && claude setup-token',
        })
      } else {
        resolve({
          provider: 'claude-code-oauth',
          valid: true,
          message: `Claude Code OAuth 認證已設定 (CLI v${stdout.trim().split('\n')[0]})`,
        })
      }
    })
  })
}

/**
 * 檢查 Gemini CLI OAuth 狀態
 * 檢查 ~/.gemini/oauth_creds.json 是否存在有效的認證資訊
 */
async function checkGeminiOAuth(): Promise<OAuthStatus> {
  const geminiOAuthPath = join(homedir(), '.gemini', 'oauth_creds.json')

  if (!existsSync(geminiOAuthPath)) {
    return {
      provider: 'gemini-oauth',
      valid: false,
      message: '未設定 Gemini CLI OAuth 認證',
      refreshCommand: 'gemini',
    }
  }

  try {
    const creds = JSON.parse(readFileSync(geminiOAuthPath, 'utf-8'))

    // 檢查是否有 refresh_token（表示有效的認證）
    if (creds.refresh_token) {
      // 檢查 access_token 是否過期
      const expiryDate = creds.expiry_date || 0
      const isExpired = expiryDate < Date.now()

      if (isExpired && !creds.refresh_token) {
        return {
          provider: 'gemini-oauth',
          valid: false,
          message: 'Gemini CLI OAuth 已過期',
          refreshCommand: 'gemini',
        }
      }

      return {
        provider: 'gemini-oauth',
        valid: true,
        message: 'Gemini CLI OAuth 已認證',
      }
    }

    return {
      provider: 'gemini-oauth',
      valid: false,
      message: 'Gemini CLI OAuth credentials 不完整',
      refreshCommand: 'gemini',
    }
  } catch {
    return {
      provider: 'gemini-oauth',
      valid: false,
      message: 'Gemini CLI OAuth credentials 讀取失敗',
      refreshCommand: 'gemini',
    }
  }
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // 取得所有設定
  app.get(
    '/',
    { preHandler: [authenticate, requirePermission('setting.view')] },
    async () => {
      const settings = await getSettings()

      // 隱藏敏感資訊
      const masked = { ...settings }
      const sensitiveKeys = [
        'ai.claude.apiKey', 'ai.gemini.apiKey',
        'line.channelSecret', 'line.channelAccessToken',
        'feishu.appSecret', 'feishu.verificationToken', 'feishu.encryptKey'
      ]
      for (const key of sensitiveKeys) {
        if (masked[key]) {
          masked[key] = masked[key].slice(0, 8) + '********'
        }
      }

      return { success: true, data: masked }
    }
  )

  // 批次更新設定
  app.put(
    '/',
    { preHandler: [authenticate, requirePermission('setting.edit')] },
    async (request) => {
      const updates = updateSettingsSchema.parse(request.body)

      await updateSettings(updates)

      // 如果更新了 LINE 設定，重置客戶端
      if (updates['line.channelAccessToken'] || updates['line.channelSecret']) {
        resetClient()
      }

      // 如果更新了飛書設定，重置 token
      if (updates['feishu.appId'] || updates['feishu.appSecret']) {
        resetFeishuToken()
      }

      await createLog({
        entityType: 'setting',
        action: 'update',
        details: Object.keys(updates).reduce(
          (acc, key) => {
            const value = updates[key]
            acc[key] = key.includes('apiKey') || key.includes('Secret') || key.includes('Token')
              ? '***'
              : value ?? ''
            return acc
          },
          {} as Record<string, string>
        ),
        userId: request.user.id,
        ipAddress: request.ip,
      })

      return { success: true, data: null }
    }
  )

  // 檢查 OAuth 狀態
  app.get(
    '/oauth/status',
    { preHandler: [authenticate, requirePermission('setting.view')] },
    async () => {
      const settings = await getSettings()
      const currentProvider = settings['ai.provider'] || 'gemini-oauth'

      const results: OAuthStatus[] = []

      // 檢查 Gemini CLI OAuth
      const geminiStatus = await checkGeminiOAuth()
      results.push(geminiStatus)

      // 檢查 Claude Code OAuth
      const claudeStatus = await checkClaudeCodeOAuth()
      results.push(claudeStatus)

      return {
        success: true,
        data: {
          currentProvider,
          providers: results,
        },
      }
    }
  )

  // 檢查特定 provider 的 OAuth 狀態
  app.get<{ Params: { provider: string } }>(
    '/oauth/status/:provider',
    { preHandler: [authenticate, requirePermission('setting.view')] },
    async (request) => {
      const { provider } = request.params

      let status: OAuthStatus

      switch (provider) {
        case 'gemini-oauth':
          status = await checkGeminiOAuth()
          break
        case 'claude-code-oauth':
          status = await checkClaudeCodeOAuth()
          break
        default:
          return {
            success: false,
            error: { code: 'INVALID_PROVIDER', message: `不支援的 OAuth provider: ${provider}` },
          }
      }

      return { success: true, data: status }
    }
  )

  // 檢查 LINE 連接狀態
  app.get(
    '/channels/line/status',
    { preHandler: [authenticate, requirePermission('setting.view')] },
    async () => {
      const settings = await getSettings()
      const hasSecret = !!(settings['line.channelSecret'] && settings['line.channelSecret'].length >= 20)
      const hasToken = !!(settings['line.channelAccessToken'] && settings['line.channelAccessToken'].length > 0)

      if (!hasSecret && !hasToken) {
        return {
          success: true,
          data: { connected: false, message: 'LINE Channel Secret 和 Access Token 均未設定，無法收發訊息' },
        }
      }
      if (!hasSecret) {
        return {
          success: true,
          data: { connected: false, message: 'LINE Channel Secret 未設定，無法驗證 Webhook 請求' },
        }
      }
      if (!hasToken) {
        return {
          success: true,
          data: { connected: false, message: 'LINE Channel Access Token 未設定，無法回覆訊息' },
        }
      }
      return {
        success: true,
        data: { connected: true, message: 'LINE 設定完成' },
      }
    }
  )

  // 檢查飛書連接狀態
  app.get(
    '/channels/feishu/status',
    { preHandler: [authenticate, requirePermission('setting.view')] },
    async () => {
      const status = await checkFeishuConnection()
      return { success: true, data: status }
    }
  )
}
