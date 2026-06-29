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
    `Analyze the text and return up to 3 relevant categories from the list, with a confidence score between 0.0 and 1.0 for each.`,
    `If the text clearly maps to one or more categories, respond with exactly: {"tags": [{"name": "<CATEGORY_NAME>", "score": <SCORE>}]}`,
    `If the text does NOT map well into the provided categories, identify the main subject/topic in 1 to 2 words (e.g. "Space", "Tesla", "Gardening", "Cooking"), and respond with exactly: {"tags": [], "dynamicTag": "<TOPIC>"}`,
    `You can also return both tags and a dynamicTag if the text matches a category but also has a strong specific topic: {"tags": [{"name": "<CATEGORY_NAME>", "score": <SCORE>}], "dynamicTag": "<TOPIC>"}`,
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
