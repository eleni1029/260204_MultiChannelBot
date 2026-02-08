import { FastifyInstance } from 'fastify'
import { tunnelService } from '../services/tunnel.service.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { getSetting } from '../services/settings.service.js'
import type { TunnelMode } from '../services/tunnel.service.js'

export async function tunnelRoutes(fastify: FastifyInstance) {
  // 獲取 tunnel 狀態
  fastify.get('/status', async () => {
    const status = tunnelService.getStatus()
    const webhookUrl = await tunnelService.getWebhookUrl()

    // 讀取設定（支援 .env fallback）
    const [customDomain, mode, token, lastQuickUrl] = await Promise.all([
      getSetting('webhook.customDomain'),
      getSetting('tunnel.mode'),
      getSetting('tunnel.cloudflareToken'),
      getSetting('tunnel.lastQuickUrl'),
    ])

    const customWebhookUrls = customDomain
      ? {
          line: `${customDomain}/api/webhook/line`,
          feishu: `${customDomain}/api/webhook/feishu`,
        }
      : null

    return {
      success: true,
      data: {
        ...status,
        webhookUrl,
        customDomain: customDomain || '',
        customWebhookUrls,
        mode: mode || 'fixed',
        hasToken: !!token,
        lastQuickUrl: lastQuickUrl || null,
      },
    }
  })

  // 設定自訂固定域名
  fastify.put('/custom-domain', async (request, reply) => {
    const { domain } = request.body as { domain: string }

    // 允許清空
    if (domain === '') {
      await prisma.setting.upsert({
        where: { key: 'webhook.customDomain' },
        update: { value: '' },
        create: { key: 'webhook.customDomain', value: '', description: '自訂固定域名（例如 https://bot.example.com）' },
      })
      return {
        success: true,
        data: { customDomain: '', customWebhookUrls: null },
      }
    }

    // 驗證格式
    if (!domain.startsWith('https://')) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_DOMAIN', message: '域名必須以 https:// 開頭' },
      })
    }
    if (domain.endsWith('/')) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_DOMAIN', message: '域名結尾不可以有 /' },
      })
    }

    await prisma.setting.upsert({
      where: { key: 'webhook.customDomain' },
      update: { value: domain },
      create: { key: 'webhook.customDomain', value: domain, description: '自訂固定域名（例如 https://bot.example.com）' },
    })

    const customWebhookUrls = {
      line: `${domain}/api/webhook/line`,
      feishu: `${domain}/api/webhook/feishu`,
    }

    return {
      success: true,
      data: { customDomain: domain, customWebhookUrls },
    }
  })

  // 切換 tunnel 模式
  fastify.put('/mode', async (request) => {
    const { mode, token } = request.body as { mode: TunnelMode; token?: string }

    // 儲存模式設定
    await prisma.setting.upsert({
      where: { key: 'tunnel.mode' },
      update: { value: mode },
      create: { key: 'tunnel.mode', value: mode, description: 'Tunnel 模式 (quick/fixed)' },
    })

    // 如果有提供 token，儲存 token
    if (token !== undefined) {
      await prisma.setting.upsert({
        where: { key: 'tunnel.cloudflareToken' },
        update: { value: token },
        create: { key: 'tunnel.cloudflareToken', value: token, description: 'Cloudflare Tunnel Token（Fixed 模式使用）' },
      })
    }

    // 停止當前隧道並同步模式
    await tunnelService.stop()
    tunnelService.setMode(mode)

    // 自動啟動新模式的隧道（支援 .env fallback）
    const tokenValue = token || (await getSetting('tunnel.cloudflareToken')) || ''
    const result = await tunnelService.startByMode(mode, config.port, tokenValue)

    return {
      success: true,
      data: { mode, started: result.success, url: result.url, error: result.error },
    }
  })

  // 啟動 tunnel
  fastify.post('/start', async () => {
    // 讀取模式和 token（支援 .env fallback）
    const mode = ((await getSetting('tunnel.mode')) || 'fixed') as TunnelMode
    const token = (await getSetting('tunnel.cloudflareToken')) || ''

    const result = await tunnelService.startByMode(mode, config.port, token)

    if (result.success) {
      const webhookUrl = await tunnelService.getWebhookUrl()
      return {
        success: true,
        data: {
          success: true,
          url: result.url,
          webhookUrl,
          mode,
        },
      }
    }

    return {
      success: true,
      data: {
        success: false,
        error: result.error,
        mode,
      },
    }
  })

  // 停止 tunnel
  fastify.post('/stop', async () => {
    const result = await tunnelService.stop()
    return {
      success: true,
      data: result,
    }
  })

  // 重啟 tunnel（獲取新 URL）
  fastify.post('/restart', async () => {
    const result = await tunnelService.restart(config.port)

    if (result.success) {
      const webhookUrl = await tunnelService.getWebhookUrl()
      return {
        success: true,
        data: {
          success: true,
          url: result.url,
          webhookUrl,
        },
      }
    }

    return {
      success: true,
      data: {
        success: false,
        error: result.error,
      },
    }
  })

  // 檢查 webhook 是否有效
  fastify.get('/health', async () => {
    const result = await tunnelService.checkHealth(config.port)
    return {
      success: true,
      data: result,
    }
  })
}
