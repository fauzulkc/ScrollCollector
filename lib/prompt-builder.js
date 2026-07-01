/**
 * prompt-builder.js
 *
 * Constructs system and user prompts for the AI classification pipeline.
 * All prompts are designed to elicit deterministic, pure-JSON responses
 * from the language model with zero conversational fluff.
 */

/**
 * Builds the system prompt that constrains the language model to classify
 * text into exactly the set of user-enabled tag categories.
 *
 * @param {Array<{label: string, prompt: string}>} enabledTags - Array of tag objects
 * @returns {string} The full system prompt string.
 */
export function buildSystemPrompt(enabledTags) {
  const categoryList = enabledTags.map(t => `- ${t.label}: ${t.prompt || `Identify posts related to ${t.label}.`}`).join('\n');

  return [
    `You are a semantic text categorization sub-routine. Your target categories are defined by the following evaluation criteria:`,
    categoryList,
    ``,
    `Analyze the text contextually against these criteria. Return up to 3 relevant categories from the list that satisfy their evaluation criteria, with a confidence score between 0.0 and 1.0 for each.`,
    `If the text clearly maps to one or more categories, respond with exactly: {"tags": [{"name": "<CATEGORY_NAME>", "score": <SCORE>}]}`,
    `If the text does NOT map well into the provided categories contextually, identify the main subject/topic in 1 to 2 words (e.g. "Space", "Tesla", "Gardening", "Cooking"), and respond with exactly: {"tags": [], "dynamicTag": "<TOPIC>"}`,
    `You can also return both tags and a dynamicTag if the text matches a category but also has a strong specific topic: {"tags": [{"name": "<CATEGORY_NAME>", "score": <SCORE>}], "dynamicTag": "<TOPIC>"}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

/**
 * Builds the system prompt that constrains the language model to evaluate
 * whether the text matches a specific user prompt.
 *
 * @param {string} enhancedPrompt - The custom condition the user wants to evaluate against (already enhanced).
 * @param {Array<{name: string, weight: number}>} tagsWithWeights - Extracted tags with their weights.
 * @returns {string} The full system prompt string.
 */
export function buildMatchSystemPrompt(enhancedPrompt, tagsWithWeights = []) {
  const tagsDescription = (tagsWithWeights && tagsWithWeights.length > 0)
    ? tagsWithWeights.map(t => `- "${t.name}" (Weight/Importance: ${t.weight}/5)`).join('\n')
    : 'None';

  return [
    `You are a semantic evaluator sub-routine. Your goal is to evaluate if a given text aligns with the user's search intent.`,
    `Evaluation Criteria (Enhanced Prompt):`,
    `"${enhancedPrompt}"`,
    ``,
    `Key Topic Tags and their relative importance (1 to 5 scale, 5 being most important):`,
    tagsDescription,
    ``,
    `Analyze the text contextually. Consider both the enhanced evaluation criteria and the key topic tags (especially the highly weighted ones).`,
    `Respond with exactly: {"matches": true} or {"matches": false}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

/**
 * Builds a system prompt to enhance a user's match prompt.
 *
 * @returns {string} The system prompt string.
 */
export function buildEnhancedPromptSystemPrompt() {
  return [
    `You are an AI prompt engineering sub-routine.`,
    `Your goal is to take a raw search or filtering prompt from a user, and expand/enhance it into a highly descriptive evaluation prompt.`,
    `The enhanced prompt should clearly describe the key topics, contexts, synonyms, and criteria that another AI evaluator can use to match relevant social media posts.`,
    `Keep the enhanced prompt focused, professional, and clear, ideally 1-3 sentences.`,
    `Respond with exactly: {"enhancedPrompt": "The enhanced and detailed evaluation prompt here"}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

/**
 * Builds the user prompt by wrapping the extracted text with its source
 * platform for additional context that may improve classification accuracy.
 *
 * @param {string} text           - The extracted text fragment to classify.
 * @param {string} sourcePlatform - Origin platform identifier (e.g. 'twitter', 'reddit').
 * @returns {string} The formatted user prompt.
 */
export function buildUserPrompt(text, sourcePlatform) {
  return `[Source: ${sourcePlatform}] "${text}"`;
}

/**
 * Builds a system prompt to extract 1-5 expected category tags with weights from a user's match prompt.
 *
 * @returns {string} The full system prompt string.
 */
export function buildPromptTagExtractionSystemPrompt() {
  return [
    `You are an AI tag generator sub-routine.`,
    `Given a user's search prompt, identify 1 to 5 broad category tags (e.g., "AI", "Jobs", "Technology") that best represent the essence of what the user is looking for.`,
    `Also, determine the weight (relevance/importance) of each tag to the prompt on a scale of 1 to 5 (where 5 is highly central/critical and 1 is secondary/contextual).`,
    `Respond with exactly: {"tags": [{"name": "Tag1", "weight": 5}, {"name": "Tag2", "weight": 2}]}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

/**
 * Builds a system prompt to auto-generate a 1-sentence evaluation prompt for a tag.
 *
 * @param {string} currentPrompt - If an existing prompt is provided, refine it, else generate new.
 * @returns {string} The system prompt string.
 */
export function buildTagEvalGenerationSystemPrompt(currentPrompt) {
  return [
    `You are an AI configuration sub-routine.`,
    `Given a category tag name, generate a clear, 1-to-2 sentence prompt that tells another AI how to identify if a social media post belongs to this category.`,
    currentPrompt ? `Consider and improve upon the existing prompt: "${currentPrompt}"` : ``,
    `Your prompt should capture the 'essence' of the category.`,
    `Respond with exactly: {"prompt": "Your generated evaluation prompt here"}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

/**
 * Builds a system prompt to determine if two author profiles are the same person.
 *
 * @returns {string} The system prompt string.
 */
export function buildAuthorMatchSystemPrompt() {
  return [
    `You are a profile matching sub-routine. Your goal is to determine if two social media profiles from different sites refer to the same person.`,
    `Consider:`,
    `1. Name similarity: close variations, nicknames, middle initials (e.g., "John Doe" and "John D.").`,
    `2. Handle/username similarity: removing punctuation, @ symbols, numbers, and platform indicators (e.g., "@johndoe", "JohnDoeTech", "john_doe").`,
    `3. URL clues.`,
    `Respond with exactly: {"isSame": true} or {"isSame": false}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object.`
  ].join('\n');
}

