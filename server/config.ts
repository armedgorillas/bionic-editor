import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR 
  ? path.resolve(process.env.WORKSPACE_DIR) 
  : path.resolve(process.cwd(), 'workspace');

export let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export let GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export let OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';

export function updateConfigKeys(keys: { geminiApiKey?: string; openaiApiKey?: string; anthropicApiKey?: string }) {
  if (keys.geminiApiKey) GEMINI_API_KEY = keys.geminiApiKey;
  if (keys.openaiApiKey) OPENAI_API_KEY = keys.openaiApiKey;
  if (keys.anthropicApiKey) ANTHROPIC_API_KEY = keys.anthropicApiKey;
}
