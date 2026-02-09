export interface QuestionAnalysis {
  isQuestion: boolean
  confidence: number  // 0-100，判斷是否為問題的信心度
  summary: string
  sentiment: 'positive' | 'neutral' | 'negative'
  suggestedTags: string[]
  suggestedReply?: string
}

export interface ReplyEvaluation {
  relevanceScore: number // 0-100
  isCounterQuestion: boolean
  explanation: string
}

export interface TagSimilarity {
  similarTag: string | null
  shouldMerge: boolean
}

export interface CustomerSentimentAnalysis {
  sentiment: 'positive' | 'neutral' | 'negative' | 'at_risk'
  reason: string
}

export interface KnowledgeEntry {
  id: number
  question: string
  answer: string
  category?: string | null
  keywords?: string[]
}

export interface RAGSearchResult {
  matchedEntries: Array<{
    entry: KnowledgeEntry
    relevanceScore: number  // 0-100 語義相關度
  }>
  canAnswer: boolean        // 是否能回答這個問題
  confidence: number        // 整體信心度 0-100
}

export interface RAGAnswerResult {
  answer: string            // 生成的回答
  confidence: number        // 回答信心度 0-100
  sources: number[]         // 使用的知識條目 ID
}

/**
 * AI 生成回答的結果
 */
export interface GenerateAnswerResult {
  answer: string            // 生成的回答
  confidence: number        // 回答信心度 0-100
  sources: number[]         // 使用的知識條目 ID
  canAnswer: boolean        // 是否能基於知識庫回答
}

export interface ConversationQuestionStatus {
  question: string
  status: 'unanswered' | 'answered' | 'abandoned'
  answeredBy: string | null
}

export interface ConversationAnalysis {
  hasUnansweredQuestion: boolean
  question: string                        // 最新的未回答問題
  allQuestions: ConversationQuestionStatus[] // 所有識別到的問題及狀態
  confidence: number                      // 0-100
  summary: string                         // 對話摘要
  sentiment: 'positive' | 'neutral' | 'negative'
}

export interface AIProvider {
  /**
   * 通用文字生成（用於自定義 prompt）
   */
  generate(prompt: string): Promise<string>

  /**
   * RAG 語義搜尋 - 找出與查詢語義相關的知識條目
   */
  ragSearch(query: string, entries: KnowledgeEntry[]): Promise<RAGSearchResult>

  /**
   * RAG 生成回答 - 根據知識庫內容生成回答
   */
  ragAnswer(query: string, relevantEntries: KnowledgeEntry[]): Promise<RAGAnswerResult>

  /**
   * 基於知識庫生成回答（核心方法）
   * - 分析用戶問題
   * - 判斷知識庫中是否有相關資訊
   * - 如果有，生成基於知識庫的回答
   * - 如果沒有，返回 canAnswer: false
   */
  generateAnswer(query: string, knowledgeEntries: KnowledgeEntry[]): Promise<GenerateAnswerResult>

  /**
   * 分析訊息是否為提問
   */
  analyzeQuestion(content: string): Promise<QuestionAnalysis>

  /**
   * 評估回覆相關性
   */
  evaluateReply(question: string, reply: string): Promise<ReplyEvaluation>

  /**
   * 判斷標籤相似性
   */
  findSimilarTag(newTag: string, existingTags: string[]): Promise<TagSimilarity>

  /**
   * 分析客戶整體情緒
   */
  analyzeCustomerSentiment(recentMessages: string[]): Promise<CustomerSentimentAnalysis>

  /**
   * 分析對話上下文，判斷是否存在未回答的問題
   */
  analyzeConversation(messages: Array<{ sender: string, content: string, time: string }>): Promise<ConversationAnalysis>
}
