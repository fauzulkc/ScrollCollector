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
 * @param {string[]} enabledTagLabels - e.g. ['Tech', 'Finance', 'Health & Wellness']
 * @returns {string} The full system prompt string.
 */
export function buildSystemPrompt(enabledTagLabels) {
  const categoryList = enabledTagLabels.join(', ');

  return [
    `You are a deterministic text categorization sub-routine. Your target categories are exactly: [${categoryList}].`,
    `If the text fragment maps clearly to one of these categories, respond with exactly: {"category": "<CATEGORY_NAME>"}`,
    `If the text does NOT map clearly into one of these categories, identify the main subject/topic in 1 to 2 words (e.g. "Space", "Tesla", "Gardening", "Recruitment", "Cooking"), and respond with exactly: {"category": "Unclassified", "dynamicTag": "<TOPIC>"}`,
    `Do not write explanations, markdown syntax wrappers, or thoughts. Output pure JSON.`,
    `Your response must be exactly one JSON object in one of those two specified formats.`
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
