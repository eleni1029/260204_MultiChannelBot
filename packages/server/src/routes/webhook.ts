import { FastifyPluginAsync } from 'fastify'
import { WebhookEvent, MessageEvent, TextEventMessage } from '@line/bot-sdk'
import { prisma } from '../lib/prisma.js'
import { validateSignature, getGroupMemberProfile, replyMessage } from '../services/line.service.js'
import { MessageType, IssueStatus, Sentiment } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { searchKnowledge, logAutoReply } from '../services/knowledge.service.js'
import { getSettings } from '../services/settings.service.js'
import { getAIProvider } from '../services/ai/index.js'

/**
 * 從訊息中提取自我介紹的名稱
 * 支援模式：我是xxx, 我叫xxx, 我的名字是xxx, 我姓xxx, 叫我xxx
 */
function extractNameFromMessage(content: string): string | null {
  // 常見的自我介紹模式
  const patterns = [
    /我(?:是|叫|的名字是|姓)\s*([^\s,，。！!？?、\n]{1,10})/,
    /(?:叫我|稱呼我|請叫我)\s*([^\s,，。！!？?、\n]{1,10})/,
    /(?:我的名字|我名字|名字)\s*(?:是|叫)?\s*([^\s,，。！!？?、\n]{1,10})/,
  ]

  for (const pattern of patterns) {
    const match = content.match(pattern)
    if (match && match[1]) {
      const name = match[1].trim()
      // 過濾掉太短或不合理的名稱
      if (name.length >= 1 && name.length <= 10) {
        // 排除一些常見的非名稱詞彙
        const excludeWords = ['誰', '什麼', '哪裡', '怎麼', '為什麼', '老師', '學生', '客戶', '用戶']
        if (!excludeWords.includes(name)) {
          return name
        }
      }
    }
  }
  return null
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // 使用 raw body 進行 LINE 簽名驗證
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    ;(req as any).rawBody = body
    try {
      const json = JSON.parse(body.toString())
      done(null, json)
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // LINE Webhook
  app.post('/line', async (request, reply) => {
    const signature = request.headers['x-line-signature'] as string

    logger.info({ signature: signature ? 'present' : 'missing' }, 'Webhook received')

    if (!signature) {
      return reply.status(400).send({ error: 'Missing signature' })
    }

    try {
      const body = (request as any).rawBody.toString()
      const isValid = await validateSignature(body, signature)

      if (!isValid) {
        logger.warn('Invalid signature')
        return reply.status(403).send({ error: 'Invalid signature' })
      }
      logger.info('Signature valid')
    } catch (err) {
      logger.error(err, 'Signature validation error')
      // 允許在未配置時跳過驗證（開發模式）
    }

    const { events } = request.body as { events: WebhookEvent[] }
    logger.info({ eventCount: events.length }, 'Processing events')

    for (const event of events) {
      try {
        logger.info({ eventType: event.type, sourceType: event.source.type }, 'Handling event')
        await handleEvent(event)
      } catch (err) {
        logger.error(err, 'Error handling webhook event')
      }
    }

    return { success: true }
  })
}

async function handleEvent(event: WebhookEvent) {
  switch (event.type) {
    case 'message':
      await handleMessageEvent(event)
      break
    case 'join':
      await handleJoinEvent(event)
      break
    case 'leave':
      await handleLeaveEvent(event)
      break
    case 'memberJoined':
      await handleMemberJoinedEvent(event)
      break
    case 'memberLeft':
      await handleMemberLeftEvent(event)
      break
  }
}

async function handleMessageEvent(event: MessageEvent) {
  const sourceType = event.source.type
  const userId = event.source.userId

  if (!userId) {
    return
  }

  // 處理群組或 1:1 私聊
  let groupId: string
  let isPrivateChat = false

  if (sourceType === 'group') {
    groupId = event.source.groupId!
  } else if (sourceType === 'room') {
    groupId = event.source.roomId!
  } else {
    // 1:1 私聊，使用 oderId 作為虛擬群組 ID
    groupId = `user_${userId}`
    isPrivateChat = true
  }

  // 確保群組存在
  let group = await prisma.lineGroup.findUnique({
    where: { lineGroupId: groupId },
  })

  if (!group) {
    group = await prisma.lineGroup.create({
      data: {
        lineGroupId: groupId,
        displayName: isPrivateChat ? '私聊' : undefined,
      },
    })
  }

  // 確保成員存在
  let member = await prisma.member.findUnique({
    where: { lineUserId: userId },
  })

  if (!member) {
    let profile = null
    if (!isPrivateChat) {
      profile = await getGroupMemberProfile(groupId, userId)
    }
    member = await prisma.member.create({
      data: {
        lineUserId: userId,
        displayName: profile?.displayName,
        pictureUrl: profile?.pictureUrl,
      },
    })
  }

  // 確保群組成員關聯
  await prisma.groupMember.upsert({
    where: {
      groupId_memberId: {
        groupId: group.id,
        memberId: member.id,
      },
    },
    update: {},
    create: {
      groupId: group.id,
      memberId: member.id,
    },
  })

  // 建立訊息記錄
  const message = event.message
  let content: string | null = null
  let mediaUrl: string | null = null
  let messageType: MessageType = MessageType.OTHER

  switch (message.type) {
    case 'text':
      content = (message as TextEventMessage).text
      messageType = MessageType.TEXT
      break
    case 'image':
      messageType = MessageType.IMAGE
      break
    case 'video':
      messageType = MessageType.VIDEO
      break
    case 'audio':
      messageType = MessageType.AUDIO
      break
    case 'file':
      messageType = MessageType.FILE
      break
    case 'sticker':
      messageType = MessageType.STICKER
      break
    case 'location':
      messageType = MessageType.LOCATION
      break
  }

  // 防止重複訊息（LINE 可能重送）
  const existing = await prisma.message.findUnique({
    where: { lineMessageId: message.id },
  })
  if (existing) {
    logger.info({ lineMessageId: message.id }, 'Duplicate message, skipping')
    return
  }

  const savedMessage = await prisma.message.create({
    data: {
      lineMessageId: message.id,
      messageType,
      content,
      mediaUrl,
      rawPayload: JSON.parse(JSON.stringify(event)),
      createdAt: new Date(event.timestamp),
      groupId: group.id,
      memberId: member.id,
    },
  })

  // 如果是文字訊息，嘗試從自我介紹中提取名稱
  if (content && messageType === MessageType.TEXT) {
    // 只有當成員沒有名稱時才嘗試提取
    if (!member.displayName) {
      const extractedName = extractNameFromMessage(content)
      if (extractedName) {
        await prisma.member.update({
          where: { id: member.id },
          data: { displayName: extractedName },
        })
        logger.info({ memberId: member.id, extractedName }, 'Extracted member name from self-introduction')
      }
    }

    // 自動回覆功能
    await handleAutoReply(event, savedMessage.id, group.id, member.id, content, isPrivateChat)
  }
}

/**
 * 檢查訊息是否提及 Bot 名稱
 */
function checkBotNameMentioned(content: string, botName: string | null): boolean {
  if (!botName || botName.trim() === '') {
    return false
  }

  // 支援多個名稱（用逗號分隔）
  const names = botName.split(',').map(n => n.trim()).filter(n => n.length > 0)
  const contentLower = content.toLowerCase()

  for (const name of names) {
    if (contentLower.includes(name.toLowerCase())) {
      return true
    }
  }

  return false
}

/**
 * 取得群組/私聊最近的對話記錄（含 bot 自動回覆）
 * 將用戶訊息與 bot 回覆合併排序，讓 AI 能看到完整對話上下文
 */
async function fetchRecentMessages(groupId: number, limit: number = 10) {
  // 取得用戶訊息
  const messages = await prisma.message.findMany({
    where: {
      groupId,
      messageType: MessageType.TEXT,
      content: { not: null },
    },
    include: {
      member: { select: { displayName: true, lineUserId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  // 取得同時間段內 bot 的自動回覆記錄（有回答的）
  const oldestMessage = messages[messages.length - 1]
  const botReplies = oldestMessage ? await prisma.autoReplyLog.findMany({
    where: {
      groupId,
      matched: true,
      answer: { not: null },
      createdAt: { gte: oldestMessage.createdAt },
    },
    orderBy: { createdAt: 'asc' },
  }) : []

  // 合併用戶訊息與 bot 回覆，按時間排序
  const combined: Array<{
    sender: string | null
    content: string
    createdAt: Date
    isBot: boolean
  }> = []

  for (const msg of messages) {
    combined.push({
      sender: msg.member?.displayName || msg.member?.lineUserId || null,
      content: msg.content || '',
      createdAt: msg.createdAt,
      isBot: false,
    })
  }

  const settings = await getSettings()
  const botDisplayName = settings['bot.name']?.split(',')[0]?.trim() || '系統助手'

  for (const reply of botReplies) {
    if (reply.answer) {
      combined.push({
        sender: botDisplayName,
        content: reply.answer,
        createdAt: reply.createdAt,
        isBot: true,
      })
    }
  }

  // 按時間排序（由舊到新），取最近 limit 條
  combined.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return combined.slice(-limit)
}

/**
 * 使用 AI 分析對話上下文，判斷是否存在未回答的問題
 * 取代舊的 analyzeQuestionWithAI，改為回溯最近 10 則訊息綜合判斷
 * 回傳所有未回答的問題列表，供後續整合回覆
 */
async function analyzeConversationWithAI(groupId: number): Promise<{
  hasUnansweredQuestion: boolean
  unansweredQuestions: string[]
  confidence: number
  summary: string
  sentiment: 'positive' | 'neutral' | 'negative'
}> {
  try {
    const recentMessages = await fetchRecentMessages(groupId, 10)

    if (recentMessages.length === 0) {
      return {
        hasUnansweredQuestion: false,
        unansweredQuestions: [],
        confidence: 0,
        summary: '',
        sentiment: 'neutral',
      }
    }

    const formatted = recentMessages.map(m => ({
      sender: m.sender || '未知用戶',
      content: m.content || '',
      time: m.createdAt.toISOString().replace('T', ' ').substring(0, 19),
    }))

    const ai = await getAIProvider()
    const analysis = await ai.analyzeConversation(formatted)

    // 從 allQuestions 中提取所有未回答的問題
    const unansweredQuestions = (analysis.allQuestions || [])
      .filter(q => q.status === 'unanswered')
      .map(q => q.question)

    // 如果 allQuestions 沒有提供但 hasUnansweredQuestion 為 true，fallback 用 question 欄位
    if (analysis.hasUnansweredQuestion && unansweredQuestions.length === 0 && analysis.question) {
      unansweredQuestions.push(analysis.question)
    }

    // 正規化 confidence：AI 有時回傳 0~1 小數，有時回傳 0~100 整數
    let confidence = analysis.confidence || 0
    if (confidence > 0 && confidence <= 1) {
      confidence = Math.round(confidence * 100)
    }

    logger.info({
      hasUnansweredQuestion: analysis.hasUnansweredQuestion,
      unansweredQuestions,
      confidence,
      rawConfidence: analysis.confidence,
      allQuestions: analysis.allQuestions,
    }, 'Conversation analysis result')

    return {
      hasUnansweredQuestion: analysis.hasUnansweredQuestion,
      unansweredQuestions,
      confidence,
      summary: analysis.summary || '',
      sentiment: analysis.sentiment || 'neutral',
    }
  } catch (err) {
    logger.error(err, 'AI conversation analysis failed')
    // AI 失敗時，保守地假設可能有未回答問題
    return {
      hasUnansweredQuestion: true,
      unansweredQuestions: [],
      confidence: 50,
      summary: '',
      sentiment: 'neutral',
    }
  }
}

/**
 * 為問題創建 Issue 進行追蹤
 */
async function createIssueForQuestion(params: {
  messageId: number
  groupId: number
  customerId: number | null
  summary: string
  sentiment: 'positive' | 'neutral' | 'negative'
  autoReplied: boolean
  autoReplyAnswer?: string
  confidence?: number
}): Promise<number> {
  const settings = await getSettings()
  const timeoutMinutes = parseInt(settings['issue.timeoutMinutes'] || '15', 10)
  const timeoutAt = new Date(Date.now() + timeoutMinutes * 60 * 1000)

  const sentimentMap: Record<string, Sentiment> = {
    positive: Sentiment.POSITIVE,
    neutral: Sentiment.NEUTRAL,
    negative: Sentiment.NEGATIVE,
  }

  const issue = await prisma.issue.create({
    data: {
      questionSummary: params.summary,
      status: params.autoReplied ? IssueStatus.REPLIED : IssueStatus.PENDING,
      isQuestion: true,
      sentiment: sentimentMap[params.sentiment] || Sentiment.NEUTRAL,
      suggestedReply: params.autoReplyAnswer,
      timeoutAt,
      groupId: params.groupId,
      customerId: params.customerId,
      triggerMessageId: params.messageId,
      // 如果自動回覆了，記錄回覆時間
      ...(params.autoReplied && {
        repliedAt: new Date(),
      }),
    },
  })

  logger.info({ issueId: issue.id, autoReplied: params.autoReplied }, 'Issue created for question')
  return issue.id
}

/**
 * 處理自動回覆
 *
 * 新邏輯：
 * 1. 檢測訊息是否為問題
 * 2. 如果是問題，創建 Issue 進行追蹤（無論是否能回答）
 * 3. 搜尋知識庫
 * 4. 回覆邏輯：
 *    - 信心度 >= 50：回覆答案
 *    - 信心度 < 50 但提及 Bot 名稱：仍然嘗試回覆
 *    - 信心度 < 50 且未提及 Bot 名稱：不回覆，僅追蹤問題
 */
async function handleAutoReply(
  event: MessageEvent,
  messageId: number,
  groupId: number,
  memberId: number,
  question: string,
  isPrivateChat: boolean
) {
  try {
    const settings = await getSettings()
    const autoReplyEnabled = settings['bot.autoReply'] === 'true'
    const botName = settings['bot.name'] || null
    const confidenceThreshold = parseInt(settings['bot.confidenceThreshold'] || '50', 10)

    // 取得群組資訊（用於獲取 customerId）
    const group = await prisma.lineGroup.findUnique({
      where: { id: groupId },
      select: { customerId: true, autoReplyEnabled: true },
    })

    // 檢查群組是否啟用自動回覆
    if (group && !group.autoReplyEnabled) {
      logger.info({ groupId }, 'Auto reply disabled for this group')
      return
    }

    // Step 1: 檢查是否提及 Bot 名稱（關鍵字）
    const botNameMentioned = checkBotNameMentioned(question, botName)

    // Step 2: 決定是否需要處理這條訊息
    // - 有關鍵字（Bot 名稱）或私聊：強制處理
    // - 其他：用 AI 分析對話上下文，判斷是否有未回答問題
    let shouldProcess = botNameMentioned || isPrivateChat
    let isQuestion = false
    let questionConfidence = 0
    let questionSummary = question
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral'
    let extractedQuestion = question // 用於知識庫搜尋的問題文字

    // 儲存所有未回答的問題（用於多問題整合回覆）
    let unansweredQuestions: string[] = []

    if (!botNameMentioned && !isPrivateChat) {
      // 沒有提及 Bot 名稱且非私聊，分析對話上下文
      const analysis = await analyzeConversationWithAI(groupId)
      isQuestion = analysis.hasUnansweredQuestion
      questionConfidence = analysis.confidence || 0
      questionSummary = analysis.summary || question
      sentiment = analysis.sentiment
      unansweredQuestions = analysis.unansweredQuestions

      // 如果 AI 識別出未回答的問題，使用第一個問題作為主要搜尋文字
      if (unansweredQuestions.length > 0 && unansweredQuestions[0]) {
        extractedQuestion = unansweredQuestions[0]
      }

      // 只有當對話中有未回答問題且信心度達標時才處理
      shouldProcess = isQuestion && questionConfidence >= confidenceThreshold
    } else {
      // 提及 Bot 名稱或私聊，視為問題
      isQuestion = true
      questionConfidence = 100
    }

    logger.info({
      botNameMentioned,
      isQuestion,
      questionConfidence,
      confidenceThreshold,
      shouldProcess,
      autoReplyEnabled,
      unansweredQuestions: unansweredQuestions.length > 0 ? unansweredQuestions : undefined,
    }, 'Message analysis result')

    // 如果自動回覆功能關閉
    if (!autoReplyEnabled) {
      // 即使自動回覆關閉，如果是問題仍需追蹤
      if (isQuestion && questionConfidence >= confidenceThreshold) {
        await createIssueForQuestion({
          messageId,
          groupId,
          customerId: group?.customerId || null,
          summary: questionSummary,
          sentiment,
          autoReplied: false,
        })
      }
      return
    }

    // 不需要處理的訊息，直接返回
    if (!shouldProcess) {
      logger.info({ questionConfidence, confidenceThreshold }, 'Message not processed (low confidence or not a question)')
      return
    }

    // Step 3: 搜尋知識庫
    // 如果有多個未回答問題，逐一搜尋並收集答案（最多處理 3 個，取最新的）
    const questionsToSearch = unansweredQuestions.length > 1
      ? unansweredQuestions.slice(-3)  // 取最後（最新）3 個
      : [extractedQuestion]

    const searchResults = await Promise.all(
      questionsToSearch.map(q => searchKnowledge(q, groupId).then(r => ({ question: q, result: r })))
    )

    // 對每個問題分類：能回答 / 不能回答
    const notFoundReply = settings['bot.notFoundReply'] || '抱歉，我目前無法回答這個問題。請稍候，會有專人為您服務。'
    const answeredParts: Array<{ question: string, answer: string, knowledgeId: number | null, confidence: number }> = []
    const unansweredParts: string[] = []

    for (const sr of searchResults) {
      const conf = sr.result?.confidence || 0
      if (sr.result && conf >= confidenceThreshold) {
        answeredParts.push({
          question: sr.question,
          answer: sr.result.generatedAnswer || sr.result.entry.answer,
          knowledgeId: sr.result.entry.id,
          confidence: conf,
        })
      } else {
        unansweredParts.push(sr.question)
      }
    }

    const bestConfidence = Math.max(...searchResults.map(sr => sr.result?.confidence || 0), 0)
    const hasAnyAnswer = answeredParts.length > 0

    logger.info({
      questionsSearched: questionsToSearch.length,
      answeredCount: answeredParts.length,
      unansweredCount: unansweredParts.length,
      bestConfidence,
      confidenceThreshold,
      botNameMentioned,
    }, 'Knowledge search result')

    // Step 4: 決定是否回覆
    // - 有能回答的問題 → 回覆（能答的答，不能答的提示）
    // - 沒有能回答的 + 提及 Bot 名稱或私聊 → 回覆找不到
    // - 沒有能回答的 + 一般群組 → 不回覆
    const shouldReply = hasAnyAnswer || botNameMentioned || isPrivateChat
    let didReply = false
    let replyAnswer: string | null = null

    logger.info({
      isQuestion,
      botNameMentioned,
      shouldReply,
      hasAnyAnswer,
      bestConfidence,
      confidenceThreshold,
    }, 'Reply decision')

    if (shouldReply) {
      const replyToken = event.replyToken
      if (replyToken) {
        if (hasAnyAnswer) {
          // 組合回覆：能回答的給答案，不能回答的給提示
          const totalQuestions = answeredParts.length + unansweredParts.length
          const isMultiQuestion = totalQuestions > 1

          if (isMultiQuestion) {
            // 多個問題：逐一列出
            const parts: string[] = []
            let idx = 1
            for (const ap of answeredParts) {
              parts.push(`【問題${idx}】${ap.question}\n${ap.answer}`)
              idx++
            }
            for (const uq of unansweredParts) {
              parts.push(`【問題${idx}】${uq}\n${notFoundReply}`)
              idx++
            }
            replyAnswer = parts.join('\n\n')
          } else {
            // 單一問題且有答案
            replyAnswer = answeredParts[0]!.answer
          }

          await replyMessage(replyToken, replyAnswer)
          didReply = true

          await logAutoReply({
            messageId,
            groupId,
            memberId,
            question: questionsToSearch.join(' | '),
            answer: replyAnswer,
            knowledgeId: answeredParts[0]!.knowledgeId,
            matched: true,
            confidence: bestConfidence,
          })

          logger.info({
            answeredCount: answeredParts.length,
            unansweredCount: unansweredParts.length,
            totalQuestions,
            bestConfidence,
          }, 'Auto reply sent (knowledge match)')
        } else if (botNameMentioned || isPrivateChat) {
          // 提及名稱或私聊但全部問題都沒有匹配
          await replyMessage(replyToken, notFoundReply)
          replyAnswer = notFoundReply
          didReply = true

          await logAutoReply({
            messageId,
            groupId,
            memberId,
            question,
            answer: notFoundReply,
            knowledgeId: null,
            matched: false,
            confidence: 0,
          })

          logger.info({ botNameMentioned, isPrivateChat }, 'Auto reply sent (forced reply, no match)')
        }
      }
    } else {
      // 判定為問題但知識庫沒有好的匹配，不回覆，僅記錄
      await logAutoReply({
        messageId,
        groupId,
        memberId,
        question,
        answer: null,
        knowledgeId: null,
        matched: false,
        confidence: bestConfidence,
      })

      logger.info({ bestConfidence, questionConfidence }, 'Question detected but no good knowledge match, not replying')
    }

    // Step 5: 如果是問題，創建 Issue 進行追蹤
    if (isQuestion && questionConfidence >= confidenceThreshold) {
      await createIssueForQuestion({
        messageId,
        groupId,
        customerId: group?.customerId || null,
        summary: questionSummary,
        sentiment,
        autoReplied: didReply,
        autoReplyAnswer: replyAnswer || undefined,
        confidence: questionConfidence,
      })
    }

  } catch (err) {
    logger.error(err, 'Auto reply error')
  }
}

async function handleJoinEvent(event: WebhookEvent) {
  if (event.type !== 'join' || event.source.type !== 'group') return

  const groupId = event.source.groupId
  if (!groupId) return

  await prisma.lineGroup.upsert({
    where: { lineGroupId: groupId },
    update: {},
    create: { lineGroupId: groupId },
  })
}

async function handleLeaveEvent(event: WebhookEvent) {
  if (event.type !== 'leave' || event.source.type !== 'group') return

  const groupId = event.source.groupId
  if (!groupId) return

  await prisma.lineGroup.update({
    where: { lineGroupId: groupId },
    data: { status: 'ARCHIVED' },
  })
}

async function handleMemberJoinedEvent(event: WebhookEvent) {
  if (event.type !== 'memberJoined' || event.source.type !== 'group') return

  const groupId = event.source.groupId
  if (!groupId) return

  const group = await prisma.lineGroup.findUnique({
    where: { lineGroupId: groupId },
  })

  if (!group) return

  for (const joined of event.joined.members) {
    const userId = joined.userId
    const profile = await getGroupMemberProfile(groupId, userId)

    const member = await prisma.member.upsert({
      where: { lineUserId: userId },
      update: {
        displayName: profile?.displayName,
        pictureUrl: profile?.pictureUrl,
      },
      create: {
        lineUserId: userId,
        displayName: profile?.displayName,
        pictureUrl: profile?.pictureUrl,
      },
    })

    await prisma.groupMember.upsert({
      where: {
        groupId_memberId: {
          groupId: group.id,
          memberId: member.id,
        },
      },
      update: {},
      create: {
        groupId: group.id,
        memberId: member.id,
      },
    })
  }
}

async function handleMemberLeftEvent(event: WebhookEvent) {
  if (event.type !== 'memberLeft' || event.source.type !== 'group') return

  const groupId = event.source.groupId
  if (!groupId) return

  const group = await prisma.lineGroup.findUnique({
    where: { lineGroupId: groupId },
  })

  if (!group) return

  for (const left of event.left.members) {
    const member = await prisma.member.findUnique({
      where: { lineUserId: left.userId },
    })

    if (member) {
      await prisma.groupMember.delete({
        where: {
          groupId_memberId: {
            groupId: group.id,
            memberId: member.id,
          },
        },
      }).catch(() => {})
    }
  }
}
