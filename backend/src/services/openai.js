import OpenAI from "openai";
import { env, requireEnv } from "../config/env.js";

const FALLBACK_ANSWER = "I don't have that information in the uploaded business documents.";

let openai;

export function getOpenAI() {
  requireEnv(["openaiApiKey"]);

  if (!openai) {
    openai = new OpenAI({
      apiKey: env.openaiApiKey
    });
  }

  return openai;
}

export async function createEmbedding(input) {
  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input
  });

  return response.data[0].embedding;
}

export async function createChatAnswer({ question, context }) {
  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "You answer website visitor questions using only the provided PDF context.",
          "You may answer brief greetings or courtesy messages naturally.",
          "If the answer is not clearly present in the context, reply exactly:",
          FALLBACK_ANSWER,
          "Keep answers concise and helpful."
        ].join(" ")
      },
      {
        role: "user",
        content: `PDF context:\n${context}\n\nQuestion:\n${question}`
      }
    ]
  });

  return {
    answer: response.choices[0]?.message?.content?.trim() || FALLBACK_ANSWER,
    tokenUsage: response.usage?.total_tokens || 0
  };
}
