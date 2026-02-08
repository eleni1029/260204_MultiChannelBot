import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'

/**
 * 環境變數 → DB setting key 的映射
 * DB 有值優先；DB 為空時 fallback 到 .env
 */
const ENV_FALLBACKS: Record<string, string | undefined> = {
  'line.channelSecret': config.line.channelSecret,
  'line.channelAccessToken': config.line.channelAccessToken,
  'tunnel.cloudflareToken': config.tunnel.cloudflareToken,
  'tunnel.mode': config.tunnel.mode,
  'webhook.customDomain': config.tunnel.webhookDomain,
  'ai.provider': config.ai.provider,
  'ai.claude.apiKey': config.ai.claude.apiKey,
  'ai.gemini.apiKey': config.ai.gemini.apiKey,
  'ai.ollama.baseUrl': config.ai.ollama.baseUrl,
}

export async function getSettings(): Promise<Record<string, string>> {
  const settings = await prisma.setting.findMany()
  const result = settings.reduce(
    (acc, s) => {
      acc[s.key] = s.value
      return acc
    },
    {} as Record<string, string>
  )

  // DB 值為空時用 .env 補上
  for (const [key, envValue] of Object.entries(ENV_FALLBACKS)) {
    if ((!result[key] || result[key] === '') && envValue) {
      result[key] = envValue
    }
  }

  return result
}

export async function getSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } })
  if (setting?.value) return setting.value
  // fallback 到 .env
  return ENV_FALLBACKS[key] ?? null
}

export async function updateSettings(updates: Record<string, string>) {
  const operations = Object.entries(updates).map(([key, value]) =>
    prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })
  )
  await prisma.$transaction(operations)
}
