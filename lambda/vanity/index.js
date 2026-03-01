/**
 * Amazon Connect Vanity Number Lambda
 *
 * Responsibilities:
 * 1. Extract caller phone number
 * 2. Generate vanity combinations from last 7 digits
 * 3. Score and select top 5 candidates
 * 4. Persist results to DynamoDB
 * 5. Return top 3 vanity numbers to Connect
 */

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");

const VANITY_TABLE_NAME = process.env.VANITY_TABLE_NAME;

const PHONE_KEYPAD_MAPPING = {
  2: "ABC",
  3: "DEF",
  4: "GHI",
  5: "JKL",
  6: "MNO",
  7: "PQRS",
  8: "TUV",
  9: "WXYZ",
};

const dynamoClient = new DynamoDBClient({});

/* =========================================================
   Utility Functions
========================================================= */

/**
 * Extract numeric-only caller number from Connect event
 */
function extractCallerNumber(event) {
  const contactData = event?.Details?.ContactData;
  const rawNumber =
    contactData?.CustomerEndpoint?.Address || event?.callerNumber;

  if (!rawNumber) return "8005551234"; // fallback for testing

  return String(rawNumber).replace(/\D/g, "");
}

/**
 * Convert digits into possible letter options
 * Example: "23" → [["A","B","C"], ["D","E","F"]]
 */
function mapDigitsToLetterOptions(digits) {
  return digits.split("").map((digit) => {
    const letters = PHONE_KEYPAD_MAPPING[digit];
    return letters ? letters.split("") : [digit];
  });
}

/**
 * Generate letter combinations using DFS (with limit)
 */
function generateVanityCandidates(letterOptions, maxResults = 2000) {
  const results = [];

  function buildCombination(index, currentWord) {
    if (results.length >= maxResults) return;

    if (index === letterOptions.length) {
      results.push(currentWord);
      return;
    }

    for (const letter of letterOptions[index]) {
      buildCombination(index + 1, currentWord + letter);
    }
  }

  buildCombination(0, "");
  return results;
}

/**
 * Score candidate:
 * More letters = better
 */
function calculateVanityScore(candidate) {
  return [...candidate].filter((char) => /[A-Z]/i.test(char)).length;
}

/**
 * Format vanity number for readability
 * Example: 800CALLNOW → 800-CAL-LNOW
 */
function formatVanityNumber(rawVanity) {
  if (rawVanity.length <= 3) return rawVanity;
  if (rawVanity.length <= 7)
    return `${rawVanity.slice(0, 3)}-${rawVanity.slice(3)}`;

  return `${rawVanity.slice(0, 3)}-${rawVanity.slice(
    3,
    6,
  )}-${rawVanity.slice(6)}`;
}

/**
 * Select top N highest scoring unique candidates
 */
function selectTopVanityNumbers(candidates, topN = 5) {
  const scored = candidates
    .map((candidate) => ({
      value: candidate,
      score: calculateVanityScore(candidate),
    }))
    .sort((a, b) => b.score - a.score);

  const uniqueResults = [];
  const seen = new Set();

  for (const { value } of scored) {
    if (seen.has(value)) continue;

    seen.add(value);
    uniqueResults.push(value);

    if (uniqueResults.length >= topN) break;
  }

  return uniqueResults;
}

/**
 * Persist results to DynamoDB
 */
async function saveResultsToDynamoDB(callerNumber, vanityNumbers) {
  if (!VANITY_TABLE_NAME) return;

  const timestamp = new Date().toISOString();

  const item = {
    pk: callerNumber,
    sk: timestamp,
    callerNumber,
    vanity1: vanityNumbers[0],
    vanity2: vanityNumbers[1],
    vanity3: vanityNumbers[2],
    vanity4: vanityNumbers[3],
    vanity5: vanityNumbers[4],
    entityType: "VANITY",
    createdAt: timestamp,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: VANITY_TABLE_NAME,
      Item: marshall(item),
    }),
  );
}

/* =========================================================
   Lambda Handler
========================================================= */

exports.handler = async (event) => {
  const callerNumber = extractCallerNumber(event);

  // Use last 7 digits (typical US-style vanity format)
  const vanityDigits = callerNumber.slice(-7);

  const letterOptions = mapDigitsToLetterOptions(vanityDigits);

  const candidates = generateVanityCandidates(letterOptions);

  const topFiveRaw = selectTopVanityNumbers(candidates, 5);

  const formattedTopFive = topFiveRaw.map(formatVanityNumber);

  await saveResultsToDynamoDB(callerNumber, formattedTopFive);

  return {
    vanity1: formattedTopFive[0] || callerNumber,
    vanity2: formattedTopFive[1] || formattedTopFive[0],
    vanity3: formattedTopFive[2] || formattedTopFive[1],
  };
};
