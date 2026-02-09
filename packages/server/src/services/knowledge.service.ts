import { prisma } from '../lib/prisma.js'
import { generateAnswerWithFallback } from './ai/index.js'
import { searchByVector, embedKnowledgeEntry, getEmbeddingStats } from './embedding.service.js'

// 信心度閾值配置
const CONFIDENCE_THRESHOLD = 50  // 低於此閾值不回答
const VECTOR_SIMILARITY_THRESHOLD = 0.4  // 向量相似度閾值

interface AnswerResult {
  answer: string           // AI 生成的回答
  confidence: number       // 信心度 0-100
  sources: number[]        // 使用的知識條目 ID
  canAnswer: boolean       // 是否能回答
  isGenerated: boolean     // 是否由 AI 生成
}

interface SearchResult {
  entry: {
    id: number
    question: string
    answer: string
    category: string | null
    keywords: string[]
  }
  confidence: number
}

/**
 * 基於知識庫回答用戶問題
 *
 * 流程：
 * 1. 根據群組設定過濾知識庫分類
 * 2. 優先使用向量語義搜索檢索相關內容
 * 3. 如果向量搜索失敗，降級到關鍵字匹配
 * 4. 將相關內容提供給 AI 生成回答
 *
 * @param query 用戶問題
 * @param groupId 群組 ID（可選），用於根據群組設定過濾知識庫
 */
export async function answerQuestion(query: string, groupId?: number): Promise<AnswerResult> {
  // 如果有 groupId，先取得群組的知識庫分類設定
  let allowedCategories: string[] | null = null

  if (groupId) {
    const group = await prisma.lineGroup.findUnique({
      where: { id: groupId },
      select: { knowledgeCategories: true, autoReplyEnabled: true },
    })

    // 如果群組關閉了自動回覆，直接返回
    if (group && !group.autoReplyEnabled) {
      return {
        answer: '',
        confidence: 0,
        sources: [],
        canAnswer: false,
        isGenerated: false,
      }
    }

    // 如果群組有設定知識庫分類，使用該設定
    if (group && group.knowledgeCategories.length > 0) {
      allowedCategories = group.knowledgeCategories
    }
  }

  try {
    // Step 1: 優先使用向量語義搜索
    let vectorResults: Array<{ id: number; question: string; answer: string; category: string | null; similarity: number }> = []
    let useVectorSearch = false

    try {
      // 檢查是否有 embedding 數據
      const stats = await getEmbeddingStats()
      if (stats.embedded > 0) {
        vectorResults = await searchByVector(query, {
          limit: 5,
          threshold: VECTOR_SIMILARITY_THRESHOLD,
          categories: allowedCategories || undefined,
        })
        useVectorSearch = vectorResults.length > 0

        console.log('Vector search results:', {
          query,
          resultsCount: vectorResults.length,
          topSimilarity: vectorResults[0]?.similarity,
          results: vectorResults.map(r => ({
            id: r.id,
            question: r.question.substring(0, 30),
            similarity: r.similarity.toFixed(3),
          })),
        })
      }
    } catch (vectorErr) {
      console.warn('Vector search failed, falling back to keyword search:', vectorErr)
    }

    // Step 2: 如果向量搜索沒有結果，降級到關鍵字匹配
    let entriesToUse: Array<{ id: number; question: string; answer: string; category: string | null; keywords?: string[] }>

    if (useVectorSearch && vectorResults.length > 0) {
      entriesToUse = vectorResults.map(r => ({
        id: r.id,
        question: r.question,
        answer: r.answer,
        category: r.category,
      }))
    } else {
      // 降級到關鍵字搜索
      const where: { isActive: boolean; category?: { in: string[] } } = { isActive: true }
      if (allowedCategories) {
        where.category = { in: allowedCategories }
      }

      const entries = await prisma.knowledgeEntry.findMany({
        where,
        select: {
          id: true,
          question: true,
          answer: true,
          category: true,
          keywords: true,
        },
      })

      if (entries.length === 0) {
        return {
          answer: '',
          confidence: 0,
          sources: [],
          canAnswer: false,
          isGenerated: false,
        }
      }

      const relevantEntries = findRelevantEntries(query, entries)

      console.log('Keyword search results:', {
        query,
        totalEntries: entries.length,
        relevantCount: relevantEntries.length,
      })

      entriesToUse = relevantEntries.length > 0
        ? relevantEntries.slice(0, 5)
        : entries.slice(0, 5)
    }

    // Step 3: 使用 AI 基於知識庫生成回答
    const result = await generateAnswerWithFallback(query, entriesToUse)

    // 安全檢查：偵測 AI 是否回了「問題清單」而非答案
    // 如果回答中問號數量 >= 3，很可能是在列舉問題反問用戶
    if (result.canAnswer && result.answer) {
      const questionMarkCount = (result.answer.match(/？|\?/g) || []).length
      const bulletCount = (result.answer.match(/•|·/g) || []).length
      if (questionMarkCount >= 3 || bulletCount >= 5) {
        console.warn('AI answer rejected: looks like a question list', {
          questionMarkCount,
          bulletCount,
          answerPreview: result.answer.substring(0, 200),
        })
        result.canAnswer = false
        result.confidence = 0
      }
    }

    console.log('AI Answer Result:', {
      canAnswer: result.canAnswer,
      confidence: result.confidence,
      sources: result.sources,
      searchMethod: useVectorSearch ? 'vector' : 'keyword',
      answerPreview: result.answer.substring(0, 100),
    })

    // 更新使用統計
    if (result.canAnswer && result.sources.length > 0) {
      for (const entryId of result.sources) {
        await prisma.knowledgeEntry.update({
          where: { id: entryId },
          data: {
            usageCount: { increment: 1 },
            lastUsedAt: new Date(),
          },
        }).catch(() => {}) // 忽略更新錯誤
      }
    }

    return { ...result, isGenerated: true }

  } catch (err) {
    console.error('AI answer generation failed:', err)

    // AI 失敗時不要亂回答，直接返回無法回答
    return {
      answer: '',
      confidence: 0,
      sources: [],
      canAnswer: false,
      isGenerated: false,
    }
  }
}

/**
 * 提取文本摘要
 * 嘗試提取開頭有意義的段落
 */
function extractSummary(text: string, maxLength: number): string {
  // 移除頁碼標記如 "-- 1 of 11 --"
  let cleaned = text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')

  // 移除連續的空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  // 如果文本短於最大長度，直接返回
  if (cleaned.length <= maxLength) {
    return cleaned.trim()
  }

  // 嘗試在句號、問號、驚嘆號處截斷
  const truncated = cleaned.substring(0, maxLength)
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('？'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('.')
  )

  if (lastSentenceEnd > maxLength * 0.5) {
    return cleaned.substring(0, lastSentenceEnd + 1).trim()
  }

  // 否則在最後一個換行處截斷
  const lastNewline = truncated.lastIndexOf('\n')
  if (lastNewline > maxLength * 0.5) {
    return cleaned.substring(0, lastNewline).trim() + '...'
  }

  return truncated.trim() + '...'
}

/**
 * 本地關鍵字檢索相關知識條目
 */
function findRelevantEntries(
  query: string,
  entries: Array<{
    id: number
    question: string
    answer: string
    category: string | null
    keywords: string[]
  }>,
  maxResults: number = 10
) {
  const queryTokens = tokenize(query)

  // 計算每個條目的相關性分數
  const scoredEntries = entries.map(entry => {
    const { score } = calculateMatchScore(queryTokens, entry)
    return { ...entry, score }
  })

  // 按分數排序，過濾出有匹配的條目
  return scoredEntries
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
}

// 保留舊的 searchKnowledge 函數以保持向後兼容
export async function searchKnowledge(query: string, groupId?: number) {
  const result = await answerQuestion(query, groupId)

  if (!result.canAnswer) {
    return null
  }

  // 取得主要來源條目
  let primaryEntry = null
  if (result.sources.length > 0) {
    primaryEntry = await prisma.knowledgeEntry.findUnique({
      where: { id: result.sources[0] },
      select: {
        id: true,
        question: true,
        answer: true,
        category: true,
        keywords: true,
      },
    })
  }

  return {
    entry: primaryEntry || {
      id: 0,
      question: query,
      answer: result.answer,
      category: null,
      keywords: [],
    },
    confidence: result.confidence,
    generatedAnswer: result.answer,
    isGenerated: result.isGenerated,  // 標記是否由 AI 生成
  }
}

// 常見的停用詞（問句詞、語氣詞等）
const STOP_WORDS = new Set([
  '怎麼', '如何', '什麼', '哪裡', '為什麼', '怎樣', '哪個', '哪些',
  '是什麼', '怎麼辦', '可以', '能不能', '有沒有', '是否',
  '請問', '想問', '請教', '想知道',
  '的', '了', '嗎', '呢', '吧', '啊', '呀', '嘛',
])

/**
 * 中文分詞（簡單版本）
 * 將查詢拆分為有意義的詞彙
 */
function tokenize(text: string): string[] {
  // 移除標點符號並轉小寫
  const cleaned = text.toLowerCase().replace(/[？?！!。，,、：:；;（）()「」『』""'']/g, ' ')

  // 按空格分詞
  const words = cleaned.split(/\s+/).filter(w => w.length > 0)

  // 對於中文，使用滑動窗口提取 2-4 字的片段
  const tokens = new Set<string>()

  for (const word of words) {
    // 不添加整個詞如果是停用詞
    if (!STOP_WORDS.has(word)) {
      tokens.add(word)
    }

    // 如果是純中文或混合，提取子片段
    if (/[\u4e00-\u9fa5]/.test(word)) {
      // 2字片段
      for (let i = 0; i < word.length - 1; i++) {
        const segment = word.slice(i, i + 2)
        if (!STOP_WORDS.has(segment)) {
          tokens.add(segment)
        }
      }
      // 3字片段
      for (let i = 0; i < word.length - 2; i++) {
        const segment = word.slice(i, i + 3)
        if (!STOP_WORDS.has(segment)) {
          tokens.add(segment)
        }
      }
      // 4字片段
      for (let i = 0; i < word.length - 3; i++) {
        const segment = word.slice(i, i + 4)
        if (!STOP_WORDS.has(segment)) {
          tokens.add(segment)
        }
      }
    }
  }

  return Array.from(tokens)
}

/**
 * 計算匹配分數
 * 改進版：考慮匹配次數、詞長度權重、位置等因素
 */
function calculateMatchScore(
  queryTokens: string[],
  entry: { question: string; answer: string; keywords: string[] }
): { score: number; matchType: 'question' | 'keyword' | 'answer' | 'none'; matchedTokens: string[] } {
  const questionLower = entry.question.toLowerCase()
  const answerLower = entry.answer.toLowerCase()
  const keywordsLower = entry.keywords.map(k => k.toLowerCase())

  let questionScore = 0
  let keywordScore = 0
  let answerScore = 0
  const matchedTokens: string[] = []

  for (const token of queryTokens) {
    if (token.length < 2) continue // 跳過太短的詞

    // 問題匹配（權重最高）
    if (questionLower.includes(token)) {
      questionScore += token.length * 4
      matchedTokens.push(`Q:${token}`)
    }

    // 關鍵字匹配（權重次高）
    if (keywordsLower.some(kw => kw.includes(token) || token.includes(kw))) {
      keywordScore += token.length * 3
      matchedTokens.push(`K:${token}`)
    }

    // 答案匹配 - 計算出現次數，但設上限
    const answerMatches = (answerLower.match(new RegExp(token, 'g')) || []).length
    if (answerMatches > 0) {
      // 出現次數越多，分數越高（上限 5 次）
      const occurrenceBonus = Math.min(answerMatches, 5)
      answerScore += token.length * occurrenceBonus
      matchedTokens.push(`A:${token}x${answerMatches}`)
    }
  }

  // 確定最佳匹配類型
  const maxScore = Math.max(questionScore, keywordScore, answerScore)

  if (maxScore === 0) {
    return { score: 0, matchType: 'none', matchedTokens: [] }
  }

  let matchType: 'question' | 'keyword' | 'answer' = 'answer'
  if (questionScore === maxScore) {
    matchType = 'question'
  } else if (keywordScore === maxScore) {
    matchType = 'keyword'
  }

  // 總分
  const totalScore = questionScore + keywordScore + answerScore

  return { score: totalScore, matchType, matchedTokens }
}

/**
 * 後備關鍵字匹配（當 AI 不可用時）
 * 使用改進的分詞和評分機制
 */
async function fallbackKeywordSearch(
  query: string,
  entries: Array<{
    id: number
    question: string
    answer: string
    category: string | null
    keywords: string[]
  }>
): Promise<SearchResult | null> {
  if (entries.length === 0) {
    return null
  }

  const queryTokens = tokenize(query)

  console.log('Fallback search tokens:', queryTokens)

  // 計算每個條目的匹配分數
  const scoredEntries = entries.map(entry => {
    const { score, matchType, matchedTokens } = calculateMatchScore(queryTokens, entry)
    return { entry, score, matchType, matchedTokens }
  })

  // 按分數排序
  scoredEntries.sort((a, b) => b.score - a.score)

  // 取得最高分的條目
  const best = scoredEntries[0]
  if (!best) {
    return null
  }

  // 設定最低分數閾值
  // 一個 2 字詞在答案中出現 1 次 = 2 分，出現 3 次 = 6 分
  // 一個 2 字詞在問題中匹配 = 8 分
  const MIN_SCORE_THRESHOLD = 4

  if (best.score < MIN_SCORE_THRESHOLD) {
    console.log('Fallback search: No match found, best score:', best.score, 'tokens:', best.matchedTokens)
    return null
  }

  console.log('Fallback search found:', {
    question: best.entry.question.substring(0, 50),
    score: best.score,
    matchType: best.matchType,
    matchedTokens: best.matchedTokens,
  })

  // 更新使用統計
  await prisma.knowledgeEntry.update({
    where: { id: best.entry.id },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  })

  // 根據匹配類型決定信心度
  let confidence: number
  switch (best.matchType) {
    case 'question':
      confidence = Math.min(90, 50 + best.score)
      break
    case 'keyword':
      confidence = Math.min(80, 40 + best.score)
      break
    case 'answer':
      confidence = Math.min(70, 30 + best.score)
      break
    default:
      confidence = 50
  }

  return {
    entry: best.entry,
    confidence,
  }
}

/**
 * 記錄自動回覆
 */
export async function logAutoReply(params: {
  messageId?: number
  groupId: number
  memberId: number
  question: string
  answer: string | null
  knowledgeId: number | null
  matched: boolean
  confidence: number | null
}) {
  return prisma.autoReplyLog.create({
    data: params,
  })
}

/**
 * 批量導入知識庫
 */
export async function importKnowledgeEntries(
  entries: Array<{
    question: string
    answer: string
    category?: string
    keywords?: string[]
  }>,
  userId?: number
) {
  const results = {
    created: 0,
    updated: 0,
    errors: [] as string[],
  }

  for (const entry of entries) {
    try {
      // 檢查是否已存在相同問題
      const existing = await prisma.knowledgeEntry.findFirst({
        where: { question: entry.question },
      })

      if (existing) {
        // 更新現有條目
        await prisma.knowledgeEntry.update({
          where: { id: existing.id },
          data: {
            answer: entry.answer,
            category: entry.category || existing.category,
            keywords: entry.keywords || existing.keywords,
            isSyncedToAI: false, // 標記為需要重新同步
          },
        })
        results.updated++
        continue
      }

      await prisma.knowledgeEntry.create({
        data: {
          question: entry.question,
          answer: entry.answer,
          category: entry.category,
          keywords: entry.keywords || [],
          createdById: userId,
        },
      })
      results.created++
    } catch (err) {
      results.errors.push(`Failed to import "${entry.question}": ${err}`)
    }
  }

  return results
}

/**
 * 同步知識庫給 AI（生成向量 Embedding）
 */
export async function syncKnowledgeToAI(ids?: number[]) {
  const where = ids ? { id: { in: ids } } : { isSyncedToAI: false }

  const entries = await prisma.knowledgeEntry.findMany({
    where: { ...where, isActive: true },
    select: { id: true },
  })

  let synced = 0
  let failed = 0

  // 為每個條目生成 embedding
  for (const entry of entries) {
    try {
      const success = await embedKnowledgeEntry(entry.id)
      if (success) {
        await prisma.knowledgeEntry.update({
          where: { id: entry.id },
          data: { isSyncedToAI: true },
        })
        synced++
      } else {
        failed++
      }
    } catch (err) {
      console.error(`Failed to embed entry ${entry.id}:`, err)
      failed++
    }

    // 避免 rate limiting
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return { synced, failed }
}

// 導出 embedding 相關函數供外部使用
export { getEmbeddingStats } from './embedding.service.js'
