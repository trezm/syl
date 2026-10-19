import {
  GoogleGenAI,
  FinishReason,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { toolDefinitions } from "../tools.js";
import { executeTool, type SaveAnnotationEntry } from "../tool-executor.js";
import {
  MAX_ITERATIONS,
  MAX_OUTPUT_TOKENS,
  type ProviderRunOptions,
  type JsonCompletionOptions,
} from "../types.js";

const functionDeclarations: FunctionDeclaration[] = toolDefinitions.map(
  (t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: {
      type: "object",
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  })
);

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }
  return new GoogleGenAI({ apiKey });
}

function checkFinish(response: GenerateContentResponse, hint: string): void {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason === FinishReason.MAX_TOKENS) {
    throw new Error(
      `Gemini hit the output token limit before finishing. ${hint}`
    );
  }
  if (reason === FinishReason.SAFETY || response.promptFeedback?.blockReason) {
    throw new Error("Gemini declined to answer this request.");
  }
}

export async function completeJsonGemini(
  options: JsonCompletionOptions
): Promise<unknown> {
  const client = createClient();

  const response = await client.models.generateContent({
    model: options.model,
    contents: options.userPrompt,
    config: {
      systemInstruction: options.systemPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseJsonSchema: options.schema,
    },
  });

  checkFinish(response, "Try a smaller pull request.");

  const text = response.text ?? "";
  if (!text.trim()) throw new Error("Gemini returned an empty response.");
  return JSON.parse(text);
}

export async function runGemini(
  options: ProviderRunOptions
): Promise<SaveAnnotationEntry[]> {
  const client = createClient();

  const contents: Content[] = [
    {
      role: "user",
      parts: [{ text: "Please analyze the code and generate annotations." }],
    },
  ];

  const saved: SaveAnnotationEntry[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.models.generateContent({
      model: options.model,
      contents,
      config: {
        systemInstruction: options.systemPrompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        tools: [{ functionDeclarations }],
      },
    });

    // Push the content verbatim — thought signatures must round-trip unchanged.
    const content = response.candidates?.[0]?.content;
    if (content) contents.push(content);

    checkFinish(
      response,
      "Try a single element instead of the whole file."
    );

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) break;

    // Every call gets a matching response part, even ones we can't service.
    const parts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const result = await executeTool(name, call.args ?? {}, options.context);
      if (result.savedAnnotations) {
        saved.push(...result.savedAnnotations);
      }
      parts.push({
        functionResponse: {
          id: call.id,
          name,
          response: { output: result.output },
        },
      });
    }
    contents.push({ role: "user", parts });
  }

  return saved;
}
