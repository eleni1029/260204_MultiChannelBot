import * as line from '@line/bot-sdk'
import { getSettings } from './settings.service.js'

let clientInstance: line.messagingApi.MessagingApiClient | null = null

export async function getLineClient() {
  if (!clientInstance) {
    const settings = await getSettings()
    const accessToken = settings['line.channelAccessToken']
    if (!accessToken) {
      throw new Error('LINE Channel Access Token not configured')
    }
    clientInstance = new line.messagingApi.MessagingApiClient({
      channelAccessToken: accessToken,
    })
  }
  return clientInstance
}

export async function getGroupMemberProfile(groupId: string, userId: string) {
  const client = await getLineClient()
  try {
    return await client.getGroupMemberProfile(groupId, userId)
  } catch {
    return null
  }
}

export async function validateSignature(body: string, signature: string): Promise<boolean> {
  const settings = await getSettings()
  const channelSecret = settings['line.channelSecret']
  if (!channelSecret || channelSecret.length < 20) {
    throw new Error('LINE Channel Secret not configured or invalid')
  }
  return line.validateSignature(body, channelSecret, signature)
}

export function resetClient() {
  clientInstance = null
}

/**
 * 回覆訊息
 */
export async function replyMessage(replyToken: string, text: string) {
  const client = await getLineClient()
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  })
}

/**
 * 主動推送訊息
 */
export async function pushMessage(to: string, text: string) {
  const client = await getLineClient()
  return client.pushMessage({
    to,
    messages: [{ type: 'text', text }],
  })
}

/**
 * 取得群組摘要（包含名稱）
 */
export async function getGroupSummary(groupId: string) {
  const client = await getLineClient()
  try {
    return await client.getGroupSummary(groupId)
  } catch {
    return null
  }
}

/**
 * 取得用戶個人資料
 */
export async function getUserProfile(userId: string) {
  const client = await getLineClient()
  try {
    return await client.getProfile(userId)
  } catch {
    return null
  }
}
