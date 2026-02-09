import { spawn } from 'child_process'
import type {
  AIProvider,
  QuestionAnalysis,
  ReplyEvaluation,
  TagSimilarity,
  CustomerSentimentAnalysis,
  KnowledgeEntry,
  RAGSearchResult,
  RAGAnswerResult,
  GenerateAnswerResult,
  ConversationAnalysis,
} from './provider.js'

/**
 * Claude Code OAuth Provider
 * 使用 Claude CLI 調用 API，使用 OAuth 認證（Max 訂閱額度）
 *
 * 優化：
 * - 使用 haiku 模型加快響應速度
 * - 減少 prompt 長度
 * - 設置合理超時
 */
export class ClaudeCodeOAuthProvider implements AIProvider {
  constructor(private model: string = 'claude-3-5-haiku-latest') {}

  private async callClaude(prompt: string, timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format', 'text',
        '--max-turns', '1',
        '--model', this.model,
        prompt,
      ]

      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''
      let finished = false

      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true
          child.kill('SIGTERM')
          reject(new Error(`Claude CLI timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)

        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
        }
      })

      child.on('error', (err) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`))
      })
    })
  }

  private extractJSON(text: string): string {
    // 嘗試從回應中提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return jsonMatch[0]
    }
    throw new Error('No JSON found in response')
  }

  async generate(prompt: string): Promise<string> {
    return this.callClaude(prompt)
  }

  async ragSearch(query: string, entries: KnowledgeEntry[]): Promise<RAGSearchResult> {
    if (entries.length === 0) {
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }

    const entriesContext = entries.slice(0, 50).map((e, i) =>
      `[${i + 1}] ID:${e.id}\n標題: ${e.question}\n內容: ${e.answer.substring(0, 300)}${e.answer.length > 300 ? '...' : ''}`
    ).join('\n\n---\n\n')

    const prompt = `你是一個智能知識庫檢索系統。請分析用戶的問題，並從知識庫中找出所有語義相關的條目。

用戶問題：${query}

知識庫條目：
${entriesContext}

請以 JSON 格式回覆：
{
  "matchedEntries": [{"index": number, "relevanceScore": number}],
  "canAnswer": boolean,
  "confidence": number
}

注意：語義相關即可，不需要完全匹配關鍵字。只回覆 JSON。`

    try {
      const result = await this.callClaude(prompt)
      const parsed = JSON.parse(this.extractJSON(result))

      const matchedEntries = (parsed.matchedEntries || [])
        .filter((m: { index: number; relevanceScore: number }) => m.relevanceScore >= 30)
        .map((m: { index: number; relevanceScore: number }) => ({
          entry: entries[m.index - 1],
          relevanceScore: m.relevanceScore,
        }))
        .filter((m: { entry: KnowledgeEntry | undefined }) => m.entry)

      return {
        matchedEntries,
        canAnswer: parsed.canAnswer || false,
        confidence: parsed.confidence || 0,
      }
    } catch {
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }
  }

  async ragAnswer(query: string, relevantEntries: KnowledgeEntry[]): Promise<RAGAnswerResult> {
    if (relevantEntries.length === 0) {
      return { answer: '抱歉，我目前無法回答這個問題。', confidence: 0, sources: [] }
    }

    const context = relevantEntries.map((e, i) => `【知識 ${i + 1}】\n${e.answer}`).join('\n\n')

    const prompt = `根據以下知識內容回答用戶問題。

用戶問題：${query}

相關知識：
${context}

請以 JSON 格式回覆：
{"answer": string, "confidence": number, "usedKnowledge": number[]}

只回覆 JSON。`

    try {
      const result = await this.callClaude(prompt)
      const parsed = JSON.parse(this.extractJSON(result))
      const sources = (parsed.usedKnowledge || [])
        .map((idx: number) => relevantEntries[idx - 1]?.id)
        .filter((id: number | undefined): id is number => id !== undefined)
      return { answer: parsed.answer, confidence: parsed.confidence || 0, sources }
    } catch {
      return { answer: '抱歉，處理您的問題時發生錯誤。', confidence: 0, sources: [] }
    }
  }

  async generateAnswer(query: string, knowledgeEntries: KnowledgeEntry[]): Promise<GenerateAnswerResult> {
    if (knowledgeEntries.length === 0) {
      return { answer: '', confidence: 0, sources: [], canAnswer: false }
    }

    // 限制內容長度，每條最多 2000 字，最多 5 條
    const limitedEntries = knowledgeEntries.slice(0, 5)
    const context = limitedEntries.map((e, i) =>
      `【${i + 1}】${e.question}\n${e.answer.substring(0, 2000)}${e.answer.length > 2000 ? '...' : ''}`
    ).join('\n\n')

    const prompt = `你是一個專業的客服助手。根據知識庫內容回答用戶問題。

重要規則：
1. 只能使用知識庫中的內容來回答
2. 如果知識庫中沒有相關內容，設 canAnswer 為 false
3. 回答要簡潔、專業、有條理
4. 如果問題涉及多個步驟，請列出步驟
5. 必須直接回答問題，給出具體的解答內容
6. 絕對不要反問用戶、不要列出問題清單讓用戶選擇
7. 如果問題太模糊無法具體回答，設 canAnswer 為 false
8. 不要把知識庫的標題/問題列表當作回答內容

用戶問題：${query}

知識庫內容：
${context}

請以 JSON 格式回覆：
{
  "canAnswer": boolean,
  "answer": "詳細回答",
  "confidence": 0-100,
  "usedKnowledge": [使用的知識編號]
}`

    try {
      const result = await this.callClaude(prompt, 30000) // 30 秒超時
      const parsed = JSON.parse(this.extractJSON(result))
      const sources = (parsed.usedKnowledge || [])
        .map((idx: number) => limitedEntries[idx - 1]?.id)
        .filter((id: number | undefined): id is number => id !== undefined)
      return {
        answer: parsed.answer || '',
        confidence: parsed.confidence || 0,
        sources,
        canAnswer: parsed.canAnswer || false,
      }
    } catch (err) {
      throw new Error(`Claude API failed: ${err}`)
    }
  }

  async analyzeQuestion(content: string): Promise<QuestionAnalysis> {
    const prompt = `分析以下訊息是否為提問，以 JSON 格式回覆：
{
  "isQuestion": boolean,      // 是否為提問（需要回答的問題）
  "confidence": number,       // 0-100，判斷這是問題的信心度
  "summary": string,          // 問題摘要（若為提問）
  "sentiment": "positive" | "neutral" | "negative",
  "suggestedTags": string[],  // 建議的分類標籤（1-3個）
  "suggestedReply": string    // 建議回覆（若為提問）
}

判斷標準：
- 直接提問（如：怎麼做？如何設定？）→ isQuestion: true, confidence: 90-100
- 間接提問、請求幫助（如：我想知道...、可以告訴我...）→ isQuestion: true, confidence: 70-90
- 模糊可能是問題（如：課程證書設定）→ isQuestion: true, confidence: 50-70
- 陳述句、打招呼、閒聊 → isQuestion: false, confidence 表示「不是問題」的信心度

只回覆 JSON，不要其他文字。

訊息內容：
${content}`

    const response = await this.callClaude(prompt)
    return JSON.parse(this.extractJSON(response))
  }

  async evaluateReply(question: string, reply: string): Promise<ReplyEvaluation> {
    const prompt = `評估以下回覆是否相關於問題，以 JSON 格式回覆：
{
  "relevanceScore": number,     // 0-100 相關性分數
  "isCounterQuestion": boolean, // 是否為反問
  "explanation": string         // 評估說明
}

只回覆 JSON，不要其他文字。

問題：
${question}

回覆：
${reply}`

    const response = await this.callClaude(prompt)
    return JSON.parse(this.extractJSON(response))
  }

  async findSimilarTag(newTag: string, existingTags: string[]): Promise<TagSimilarity> {
    if (existingTags.length === 0) {
      return { similarTag: null, shouldMerge: false }
    }

    const prompt = `判斷新標籤是否與現有標籤相似，以 JSON 格式回覆：
{
  "similarTag": string | null,  // 最相似的現有標籤，無則為 null
  "shouldMerge": boolean        // 是否應該合併使用現有標籤
}

只回覆 JSON，不要其他文字。

新標籤：${newTag}
現有標籤：${existingTags.join(', ')}`

    const response = await this.callClaude(prompt)
    return JSON.parse(this.extractJSON(response))
  }

  private buildConversationAnalysisPrompt(messages: Array<{ sender: string, content: string, time: string }>): string {
    const formatted = messages.map(m => `[${m.time}] ${m.sender}: ${m.content}`).join('\n')
    return `分析以下對話記錄，判斷是否存在未回答的問題。請按照以下步驟逐一分析，以 JSON 格式回覆：

步驟：
1. 從對話記錄中識別出所有被提出的問題
2. 對每個問題，檢查後續對話中是否有人已經回答（其他成員的回覆、提問者自行解決、或提問者表示不需要了）
3. 排除已回答、已解決、或提問者已放棄的問題
4. 判斷是否仍有未回答的問題，如有多個未回答問題，取最新的一個

回覆格式：
{
  "hasUnansweredQuestion": boolean,
  "question": string,
  "allQuestions": [
    {
      "question": string,
      "status": "unanswered" | "answered" | "abandoned",
      "answeredBy": string | null
    }
  ],
  "confidence": number,  // 0-100 的整數，例如 85 表示高信心
  "summary": string,
  "sentiment": "positive" | "neutral" | "negative"
}

判斷標準：
- 直接提問（怎麼做？如何？為什麼？）視為問題
- 間接請求幫助（我想知道...、可以告訴我...、幫我...）視為問題
- 如果有人回覆了該問題的相關答案 → status: "answered"
- 如果提問者轉移話題、說「沒事了」「好的謝謝」等 → status: "abandoned"
- 如果問題後續沒有任何相關回覆 → status: "unanswered"
- 閒聊、打招呼、陳述句不算問題

只回覆 JSON，不要其他文字。

對話記錄（由舊到新）：
${formatted}`
  }

  async analyzeConversation(messages: Array<{ sender: string, content: string, time: string }>): Promise<ConversationAnalysis> {
    const prompt = this.buildConversationAnalysisPrompt(messages)
    const response = await this.callClaude(prompt)
    return JSON.parse(this.extractJSON(response))
  }

  async analyzeCustomerSentiment(recentMessages: string[]): Promise<CustomerSentimentAnalysis> {
    const prompt = `分析以下客戶近期訊息的整體情緒，以 JSON 格式回覆：
{
  "sentiment": "positive" | "neutral" | "negative" | "at_risk",
  "reason": string  // 判斷原因
}

at_risk 表示客戶可能有流失風險。只回覆 JSON，不要其他文字。

近期訊息：
${recentMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`

    const response = await this.callClaude(prompt)
    return JSON.parse(this.extractJSON(response))
  }
}
