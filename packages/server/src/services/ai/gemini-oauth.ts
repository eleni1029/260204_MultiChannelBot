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
import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'

/**
 * Gemini CLI OAuth Credentials 結構
 */
interface GeminiCliCredentials {
  access_token?: string
  refresh_token?: string
  expiry_date?: number
  token_type?: string
}

/**
 * Gemini CLI OAuth Provider
 * 讀取 Gemini CLI 已存儲的 OAuth credentials
 *
 * 使用方式：
 * 1. 先在終端機執行 `gemini` 命令完成 Google 帳號登入
 * 2. Gemini CLI 會將 tokens 存儲在 ~/.gemini/oauth_creds.json
 * 3. 本 Provider 會讀取這些 credentials 來呼叫 Gemini API
 */
export class GeminiOAuthProvider implements AIProvider {
  private model: string
  private cachedCredentials: GeminiCliCredentials | null = null
  private credentialsLastRead: number = 0
  private cachedProjectId: string | null = null

  // Gemini CLI 使用的 OAuth Client（公開的，見 google-auth-library 說明）
  private static readonly OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
  private static readonly OAUTH_CLIENT_SECRET = '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'
  private static readonly CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal'

  constructor(model: string = 'gemini-2.0-flash') {
    this.model = model
  }

  /**
   * 取得 Gemini CLI OAuth credentials 路徑
   */
  private getCredentialsPath(): string {
    return path.join(homedir(), '.gemini', 'oauth_creds.json')
  }

  /**
   * 讀取 Gemini CLI 的 OAuth credentials
   */
  private async loadCredentials(): Promise<GeminiCliCredentials | null> {
    try {
      const credPath = this.getCredentialsPath()
      const content = await fs.readFile(credPath, 'utf-8')
      return JSON.parse(content) as GeminiCliCredentials
    } catch {
      return null
    }
  }

  /**
   * 使用 refresh token 取得新的 access token
   */
  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: GeminiOAuthProvider.OAUTH_CLIENT_ID,
        client_secret: GeminiOAuthProvider.OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`無法刷新 access token: ${error}`)
    }

    const data = await response.json() as { access_token: string; expires_in: number }

    // 更新本地 credentials 檔案
    const credentials = await this.loadCredentials()
    if (credentials) {
      credentials.access_token = data.access_token
      credentials.expiry_date = Date.now() + (data.expires_in * 1000)
      await fs.writeFile(
        this.getCredentialsPath(),
        JSON.stringify(credentials, null, 2),
        { mode: 0o600 }
      )
      this.cachedCredentials = credentials
    }

    return data.access_token
  }

  /**
   * 取得有效的 access token
   */
  private async getValidAccessToken(): Promise<string> {
    // 每 30 秒重新讀取 credentials 檔案
    const now = Date.now()
    if (!this.cachedCredentials || now - this.credentialsLastRead > 30000) {
      this.cachedCredentials = await this.loadCredentials()
      this.credentialsLastRead = now
    }

    if (!this.cachedCredentials) {
      throw new Error(
        '找不到 Gemini CLI OAuth credentials。\n' +
        '請先在終端機執行 `gemini` 命令完成 Google 帳號登入。'
      )
    }

    // 檢查 access token 是否過期（提前 5 分鐘刷新）
    const expiryDate = this.cachedCredentials.expiry_date || 0
    if (expiryDate - now < 5 * 60 * 1000) {
      if (!this.cachedCredentials.refresh_token) {
        throw new Error(
          'Gemini CLI OAuth credentials 已過期且無 refresh token。\n' +
          '請在終端機執行 `gemini` 命令重新登入。'
        )
      }
      return this.refreshAccessToken(this.cachedCredentials.refresh_token)
    }

    if (!this.cachedCredentials.access_token) {
      throw new Error('Gemini CLI OAuth credentials 格式錯誤')
    }

    return this.cachedCredentials.access_token
  }

  /**
   * 取得 Code Assist 項目 ID
   */
  private async getProjectId(accessToken: string): Promise<string> {
    if (this.cachedProjectId) {
      return this.cachedProjectId
    }

    const loadUrl = `${GeminiOAuthProvider.CODE_ASSIST_ENDPOINT}:loadCodeAssist`
    const response = await fetch(loadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({})
    })

    if (!response.ok) {
      throw new Error('無法取得 Code Assist 項目資訊')
    }

    interface LoadCodeAssistResponse {
      cloudaicompanionProject?: string
    }
    const data = await response.json() as LoadCodeAssistResponse
    this.cachedProjectId = data.cloudaicompanionProject || 'gemini-cli-prod'
    return this.cachedProjectId
  }

  /**
   * 呼叫 Gemini API（使用 Code Assist REST API）
   */
  private async callGemini(prompt: string): Promise<string> {
    const accessToken = await this.getValidAccessToken()
    const projectId = await this.getProjectId(accessToken)

    // 使用 Code Assist generateContent API
    const url = `${GeminiOAuthProvider.CODE_ASSIST_ENDPOINT}:generateContent`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        project: projectId,
        request: {
          contents: [{
            role: 'user',
            parts: [{ text: prompt }]
          }]
        }
      })
    })

    if (!response.ok) {
      const error = await response.text()

      // 如果是 401/403，可能需要重新登入
      if (response.status === 401 || response.status === 403) {
        this.cachedCredentials = null // 清除快取，下次會重新讀取
        this.cachedProjectId = null
        throw new Error(
          'Gemini API 授權失敗。請在終端機執行 `gemini` 命令重新登入。\n' +
          `詳細錯誤: ${error}`
        )
      }

      throw new Error(`Gemini API 錯誤: ${response.status} - ${error}`)
    }

    interface CodeAssistResponse {
      response?: {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>
          }
        }>
      }
    }
    const data = await response.json() as CodeAssistResponse

    if (!data.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Gemini API 回應格式錯誤')
    }

    return data.response.candidates[0].content.parts[0].text
  }

  private extractJSON(text: string): string {
    // 移除 markdown code block 標記
    const cleaned = text.replace(/```json\n?|\n?```/g, '')
    // 嘗試提取 JSON
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return jsonMatch[0]
    }
    return cleaned
  }

  async generate(prompt: string): Promise<string> {
    return this.callGemini(prompt)
  }

  async ragSearch(query: string, entries: KnowledgeEntry[]): Promise<RAGSearchResult> {
    if (entries.length === 0) {
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }

    // 將知識庫條目格式化為上下文
    const entriesContext = entries.slice(0, 50).map((e, i) =>
      `[${i + 1}] ID:${e.id}\n標題: ${e.question}\n內容: ${e.answer.substring(0, 300)}${e.answer.length > 300 ? '...' : ''}\n關鍵字: ${e.keywords?.join(', ') || '無'}`
    ).join('\n\n---\n\n')

    const prompt = `你是一個智能知識庫檢索系統。請分析用戶的問題，並從知識庫中找出所有語義相關的條目。

## 用戶問題
${query}

## 知識庫條目
${entriesContext}

## 任務
1. 理解用戶問題的意圖和語義
2. 找出所有可能相關的知識條目（即使用詞不完全相同，但語義相關也算）
3. 評估每個相關條目的相關程度
4. 判斷這些知識是否足以回答用戶問題

## 回覆格式（JSON）
{
  "matchedEntries": [
    {"index": number, "relevanceScore": number}  // index 是條目編號（1開始），relevanceScore 是 0-100 的相關度
  ],
  "canAnswer": boolean,     // 知識庫中是否有足夠資訊回答這個問題
  "confidence": number,     // 整體信心度 0-100
  "reasoning": string       // 簡短說明判斷理由
}

注意：
- 語義相關即可，不需要完全匹配關鍵字
- 例如「如何建課」和「建立課程」是同一個意思
- 例如「怎麼聯絡客服」和「客服電話」是相關的
- 只回覆 JSON，不要其他文字`

    try {
      const result = await this.callGemini(prompt)
      const parsed = JSON.parse(this.extractJSON(result))

      // 轉換結果格式
      const matchedEntries = (parsed.matchedEntries || [])
        .filter((m: { index: number; relevanceScore: number }) => m.relevanceScore >= 30)
        .map((m: { index: number; relevanceScore: number }) => ({
          entry: entries[m.index - 1],
          relevanceScore: m.relevanceScore,
        }))
        .filter((m: { entry: KnowledgeEntry | undefined }) => m.entry)
        .sort((a: { relevanceScore: number }, b: { relevanceScore: number }) => b.relevanceScore - a.relevanceScore)

      return {
        matchedEntries,
        canAnswer: parsed.canAnswer || false,
        confidence: parsed.confidence || 0,
      }
    } catch (err) {
      console.error('RAG search failed:', err)
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }
  }

  async ragAnswer(query: string, relevantEntries: KnowledgeEntry[]): Promise<RAGAnswerResult> {
    if (relevantEntries.length === 0) {
      return {
        answer: '抱歉，我目前無法回答這個問題。請稍候，會有專人為您服務。',
        confidence: 0,
        sources: [],
      }
    }

    // 構建知識上下文
    const context = relevantEntries.map((e, i) =>
      `【知識 ${i + 1}】\n${e.answer}`
    ).join('\n\n')

    const prompt = `你是一個專業的客服助手。請根據提供的知識庫內容，回答用戶的問題。

## 用戶問題
${query}

## 相關知識
${context}

## 任務
根據上述知識內容，生成一個準確、有幫助的回答。

## 要求
1. 只使用提供的知識內容來回答，不要編造資訊
2. 回答要簡潔明瞭，適合聊天對話
3. 如果知識內容不足以完整回答，可以提供部分資訊並說明
4. 使用友善、專業的語氣

## 回覆格式（JSON）
{
  "answer": string,         // 給用戶的回答
  "confidence": number,     // 回答的信心度 0-100
  "usedKnowledge": number[] // 使用了哪些知識（編號，1開始）
}

只回覆 JSON，不要其他文字。`

    try {
      const result = await this.callGemini(prompt)
      const parsed = JSON.parse(this.extractJSON(result))

      // 轉換使用的知識編號為實際 ID
      const sources = (parsed.usedKnowledge || [])
        .map((idx: number) => relevantEntries[idx - 1]?.id)
        .filter((id: number | undefined): id is number => id !== undefined)

      return {
        answer: parsed.answer || '抱歉，我無法生成回答。',
        confidence: parsed.confidence || 0,
        sources,
      }
    } catch (err) {
      console.error('RAG answer generation failed:', err)
      return {
        answer: '抱歉，處理您的問題時發生錯誤。請稍候再試。',
        confidence: 0,
        sources: [],
      }
    }
  }

  async generateAnswer(query: string, knowledgeEntries: KnowledgeEntry[]): Promise<GenerateAnswerResult> {
    if (knowledgeEntries.length === 0) {
      return {
        answer: '',
        confidence: 0,
        sources: [],
        canAnswer: false,
      }
    }

    // 限制內容長度，每條最多 2000 字，最多 3 條（確保包含完整步驟）
    const limitedEntries = knowledgeEntries.slice(0, 3)
    const context = limitedEntries.map((e, i) =>
      `【${i + 1}】${e.question}\n${e.answer.substring(0, 2000)}${e.answer.length > 2000 ? '...' : ''}`
    ).join('\n\n')

    const prompt = `你是智能客服。根據知識庫回答用戶問題。

問題：${query}

知識庫：
${context}

要求：
- 只用知識庫資訊，不編造
- 回答簡潔，適合 LINE 聊天
- 必須直接回答問題，給出具體的解答內容
- 絕對不要反問用戶、不要列出問題清單讓用戶選擇
- 如果問題太模糊無法具體回答，或知識庫中沒有對應答案，canAnswer 設為 false
- 不要把知識庫的標題/問題列表當作回答內容

JSON回覆：{"canAnswer":bool,"answer":"回答","confidence":0-100,"usedKnowledge":[編號]}
只回覆JSON。`

    try {
      const result = await this.callGemini(prompt)
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
      console.error('generateAnswer failed:', err)
      throw err
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

    const result = await this.callGemini(prompt)
    return JSON.parse(this.extractJSON(result))
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

    const result = await this.callGemini(prompt)
    return JSON.parse(this.extractJSON(result))
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

    const result = await this.callGemini(prompt)
    return JSON.parse(this.extractJSON(result))
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
    const result = await this.callGemini(prompt)
    return JSON.parse(this.extractJSON(result))
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

    const result = await this.callGemini(prompt)
    return JSON.parse(this.extractJSON(result))
  }
}
