import { z } from 'zod'
import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load .env file from packages/server directory
dotenvConfig({ path: resolve(__dirname, '../../.env') })

// Convert relative GOOGLE_APPLICATION_CREDENTIALS path to absolute
if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.startsWith('.')) {
  const absolutePath = resolve(__dirname, '../../', process.env.GOOGLE_APPLICATION_CREDENTIALS)
  if (existsSync(absolutePath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = absolutePath
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().default('default-jwt-secret-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LINE_CHANNEL_SECRET: z.string().optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),
  TUNNEL_MODE: z.enum(['quick', 'fixed']).optional(),
  WEBHOOK_DOMAIN: z.string().optional(),
  AI_PROVIDER: z.enum(['gemini-oauth', 'claude-code-oauth', 'claude', 'gemini', 'ollama']).default('gemini-oauth'),
  CLAUDE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GCP_PROJECT_ID: z.string().optional(),
  GCP_LOCATION: z.string().default('us-central1'),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
})

const env = envSchema.parse(process.env)

export const config = {
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  port: env.PORT,
  host: env.HOST,
  line: {
    channelSecret: env.LINE_CHANNEL_SECRET,
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
  },
  tunnel: {
    cloudflareToken: env.CLOUDFLARE_TUNNEL_TOKEN,
    mode: env.TUNNEL_MODE,
    webhookDomain: env.WEBHOOK_DOMAIN,
  },
  ai: {
    provider: env.AI_PROVIDER,
    claude: {
      apiKey: env.CLAUDE_API_KEY,
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY,
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL,
    },
  },
}
