import Anthropic from '@anthropic-ai/sdk'
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

export class ClaudeProvider implements AIProvider {
  private client: Anthropic

  constructor(
    apiKey: string,
    private model: string
  ) {
    if (apiKey.startsWith('sk-ant-oat')) {
      throw new Error('Claude OAuth token (sk-ant-oat*) 不支援直接 API 調用。請使用一般 API Key (sk-ant-api*) 或改用其他 AI Provider。')
    }
    this.client = new Anthropic({ apiKey })
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })
    const textBlock = response.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return textBlock.text
  }

  private extractJSON(text: string): string {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? match[0] : text
  }

  async ragSearch(query: string, entries: KnowledgeEntry[]): Promise<RAGSearchResult> {
    if (entries.length === 0) {
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }

    const entriesContext = entries.slice(0, 50).map((e, i) =>
      `[${i + 1}] 標題: ${e.question}\n內容: ${e.answer.substring(0, 300)}`
    ).join('\n\n')

    const result = await this.generate(`你是知識庫檢索系統。找出與問題語義相關的條目。

問題：${query}

知識庫：
${entriesContext}

JSON回覆：{"matchedEntries": [{"index": number, "relevanceScore": number}], "canAnswer": boolean, "confidence": number}`)

    try {
      const parsed = JSON.parse(this.extractJSON(result))
      const matchedEntries = (parsed.matchedEntries || [])
        .filter((m: { relevanceScore: number }) => m.relevanceScore >= 30)
        .map((m: { index: number; relevanceScore: number }) => ({ entry: entries[m.index - 1], relevanceScore: m.relevanceScore }))
        .filter((m: { entry: KnowledgeEntry | undefined }) => m.entry)
      return { matchedEntries, canAnswer: parsed.canAnswer || false, confidence: parsed.confidence || 0 }
    } catch {
      return { matchedEntries: [], canAnswer: false, confidence: 0 }
    }
  }

  async ragAnswer(query: string, relevantEntries: KnowledgeEntry[]): Promise<RAGAnswerResult> {
    if (relevantEntries.length === 0) {
      return { answer: '抱歉，我目前無法回答這個問題。', confidence: 0, sources: [] }
    }

    const context = relevantEntries.map((e, i) => `【${i + 1}】${e.answer}`).join('\n\n')
    const result = await this.generate(`根據知識回答問題。

問題：${query}
知識：${context}

JSON回覆：{"answer": string, "confidence": number, "usedKnowledge": number[]}`)

    try {
      const parsed = JSON.parse(this.extractJSON(result))
      const sources = (parsed.usedKnowledge || []).map((idx: number) => relevantEntries[idx - 1]?.id).filter(Boolean)
      return { answer: parsed.answer, confidence: parsed.confidence || 0, sources }
    } catch {
      return { answer: '抱歉，處理問題時發生錯誤。', confidence: 0, sources: [] }
    }
  }

  async generateAnswer(query: string, knowledgeEntries: KnowledgeEntry[]): Promise<GenerateAnswerResult> {
    if (knowledgeEntries.length === 0) {
      return { answer: '', confidence: 0, sources: [], canAnswer: false }
    }

    const context = knowledgeEntries.map((e, i) =>
      `【${i + 1}】標題: ${e.question}\n內容: ${e.answer}`
    ).join('\n\n---\n\n')

    const result = await this.generate(`你是智能客服助手。根據知識庫回答用戶問題。

用戶問題：${query}

知識庫：
${context}

要求：
- 只使用知識庫資訊，不編造
- 必須直接回答問題，給出具體的解答內容
- 絕對不要反問用戶、不要列出問題清單讓用戶選擇
- 如果問題太模糊無法具體回答，或知識庫中沒有對應答案，canAnswer 設為 false
- 不要把知識庫的標題/問題列表當作回答內容

JSON回覆：{"canAnswer": boolean, "answer": string, "confidence": number, "usedKnowledge": number[]}`)

    try {
      const parsed = JSON.parse(this.extractJSON(result))
      const sources = (parsed.usedKnowledge || []).map((idx: number) => knowledgeEntries[idx - 1]?.id).filter(Boolean)
      return {
        answer: parsed.answer || '',
        confidence: parsed.confidence || 0,
        sources,
        canAnswer: parsed.canAnswer || false,
      }
    } catch {
      throw new Error('Failed to parse AI response')
    }
  }

  async analyzeQuestion(content: string): Promise<QuestionAnalysis> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `分析以下訊息是否為提問，以 JSON 格式回覆：
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
${content}`,
        },
      ],
    })

    const text = response.content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return JSON.parse(text.text)
  }

  async evaluateReply(question: string, reply: string): Promise<ReplyEvaluation> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `評估以下回覆是否相關於問題，以 JSON 格式回覆：
{
  "relevanceScore": number,     // 0-100 相關性分數
  "isCounterQuestion": boolean, // 是否為反問
  "explanation": string         // 評估說明
}

只回覆 JSON，不要其他文字。

問題：
${question}

回覆：
${reply}`,
        },
      ],
    })

    const text = response.content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return JSON.parse(text.text)
  }

  async findSimilarTag(newTag: string, existingTags: string[]): Promise<TagSimilarity> {
    if (existingTags.length === 0) {
      return { similarTag: null, shouldMerge: false }
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `判斷新標籤是否與現有標籤相似，以 JSON 格式回覆：
{
  "similarTag": string | null,  // 最相似的現有標籤，無則為 null
  "shouldMerge": boolean        // 是否應該合併使用現有標籤
}

只回覆 JSON，不要其他文字。

新標籤：${newTag}
現有標籤：${existingTags.join(', ')}`,
        },
      ],
    })

    const text = response.content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return JSON.parse(text.text)
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
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return JSON.parse(this.extractJSON(text.text))
  }

  async analyzeCustomerSentiment(recentMessages: string[]): Promise<CustomerSentimentAnalysis> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `分析以下客戶近期訊息的整體情緒，以 JSON 格式回覆：
{
  "sentiment": "positive" | "neutral" | "negative" | "at_risk",
  "reason": string  // 判斷原因
}

at_risk 表示客戶可能有流失風險。只回覆 JSON，不要其他文字。

近期訊息：
${recentMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
        },
      ],
    })

    const text = response.content.find(block => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('Unexpected response type')
    }
    return JSON.parse(text.text)
  }
}
