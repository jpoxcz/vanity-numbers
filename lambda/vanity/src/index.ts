import type { Context } from "aws-lambda";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import dictionary from "../utils/dictionary"; // ← your 1972 four-letter word list

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectEvent = {
  Details?: {
    ContactData?: {
      CustomerEndpoint?: {
        Address?: string;
      };
    };
  };
  callerNumber?: string;
};

type ScoreBreakdown = {
  dictionary: number; // Points from full dictionary match
  bigram: number;     // Points from common English letter pairs
  vowel: number;      // Points from vowel-consonant pattern
};

type VanityCandidate = {
  word: string;          // 4-letter word e.g. "CALL"
  vanityNumber: string;  // Full number e.g. "800555-CALL"
  score: number;         // Total hybrid score
  breakdown: ScoreBreakdown;
  tags: string[];        // ["DICT"] | ["CATCHY"] | ["FALLBACK"] etc.
  isFallback: boolean;
};

type VanityResult = {
  callerNumber: string;
  last4Digits: string;
  top5: VanityCandidate[];
};

// ─── Phone Keypad ─────────────────────────────────────────────────────────────

const PHONE_KEYPAD: Record<string, string> = {
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
};

// ─── Bigram Frequency Table ───────────────────────────────────────────────────

// Common English letter pairs — higher score = more natural to pronounce
const BIGRAM_SCORES: Record<string, number> = {
  TH: 10, HE: 10, EA: 9,  IN: 9,  ER: 9,  AN: 9,  RE: 9,
  ON: 8,  EN: 8,  AT: 8,  ND: 8,  ST: 8,  OR: 8,  NT: 8,
  LE: 8,  AR: 8,  IT: 8,  IS: 8,  ES: 8,  AL: 7,  ED: 7,
  TE: 7,  TI: 7,  IO: 7,  LY: 7,  NG: 8,  CH: 8,  SH: 8,
  WH: 7,  TR: 7,  PR: 7,  PL: 7,  BR: 7,  BL: 7,  CL: 7,
  FL: 7,  FR: 7,  GL: 7,  GR: 7,  SK: 6,  SM: 6,  SN: 6,
  SP: 7,  SW: 6,  TW: 6,  UN: 7,  DE: 7,  EX: 7,  AB: 6,
  AC: 6,  AD: 6,  OW: 7,  OO: 6,  EE: 6,  OU: 7,  OA: 6,
  AI: 6,  AY: 7,  EY: 6,  LD: 6,  LT: 6,  MB: 5,  MP: 6,
  NC: 6,  NK: 6,  NS: 6,  PH: 7,  RD: 6,  RS: 6,  RT: 6,
  SS: 5,  RY: 5,  NY: 5,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCallerNumber(event: ConnectEvent): string {
  console.log("event", JSON.stringify(event, null, 2));
  const raw =
    event?.Details?.ContactData?.CustomerEndpoint?.Address ??
    event?.callerNumber;
  return raw ? String(raw).replace(/\D/g, "") : "8005551234";
}

// ─── Signal 1: Dictionary Match ───────────────────────────────────────────────

/**
 * DFS through all letter combos for the 4 digits.
 * Prunes immediately when the current prefix cannot lead
 * to any word in the dictionary — keeps it fast even on
 * digits that map to 4-letter keys (7 = PQRS → up to 4^4 = 256 combos max).
 *
 * Only returns words that:
 *   (a) exist in the dictionary (wordSet)
 *   (b) correctly map back to the original 4 digits
 */
function findDictionaryWords(
  digits: string,
  wordSet: Set<string>,
  prefixes: Set<string>,
): string[] {
  const matches: string[] = [];

  function dfs(index: number, current: string): void {
    // Prune: if this prefix can't lead to any dictionary word, stop
    if (current.length > 0 && !prefixes.has(current)) return;

    if (index === digits.length) {
      if (wordSet.has(current)) matches.push(current);
      return;
    }

    const letters = PHONE_KEYPAD[digits[index]];

    // Digits 0 or 1 have no keypad letters — skip this position entirely
    if (!letters) return;

    for (const letter of letters) {
      dfs(index + 1, current + letter);
    }
  }

  dfs(0, "");
  return matches;
}

// ─── Signal 2: Bigram Score ───────────────────────────────────────────────────

/**
 * Score a word by summing the frequency scores of all adjacent letter pairs.
 * e.g. CALL → CA(6) + AL(7) + LL(0) = 13
 */
function scoreBigrams(word: string): number {
  let score = 0;
  for (let i = 0; i < word.length - 1; i++) {
    score += BIGRAM_SCORES[word[i] + word[i + 1]] ?? 0;
  }
  return score;
}

// ─── Signal 3: Vowel-Consonant Pattern ───────────────────────────────────────

/**
 * Score a word based on how naturally it reads:
 *  +3 per vowel (vowels make words pronounceable)
 *  -5 per consonant beyond a streak of 2 (hard to say)
 *  -25 if the word has zero vowels (essentially unreadable)
 */
function scoreVowelPattern(word: string): number {
  const VOWELS = new Set("AEIOU");
  let score = 0;
  let consonantStreak = 0;
  let vowelCount = 0;

  for (const ch of word) {
    if (VOWELS.has(ch)) {
      score += 3;
      vowelCount++;
      consonantStreak = 0;
    } else {
      consonantStreak++;
      if (consonantStreak > 2) score -= 5;
    }
  }

  if (vowelCount === 0) score -= 25;

  return score;
}

// ─── Hybrid Scorer ────────────────────────────────────────────────────────────

/**
 * Combine all 3 signals into a single score for a confirmed dictionary word.
 *
 * Score = DictionaryBase(150) + BigramScore + VowelPatternScore
 *
 * Additional style tags are added for words with memorable patterns.
 */
function scoreWord(word: string): {
  score: number;
  breakdown: ScoreBreakdown;
  tags: string[];
} {
  const bigramScore = scoreBigrams(word);
  const vowelScore = scoreVowelPattern(word);
  const dictScore = 150; // Every candidate here is a confirmed dictionary word

  const tags: string[] = ["DICT"];

  // Tag: starts with a punchy consonant cluster
  const CATCHY_STARTS = ["ST", "SP", "FL", "CL", "BR", "GR", "TH", "SH", "CH", "TR", "FR"];
  if (CATCHY_STARTS.some((s) => word.startsWith(s))) tags.push("CATCHY");

  // Tag: ends with a strong, memorable suffix
  const STRONG_ENDS = ["NG", "LL", "RK", "ND", "ST", "NT", "SS", "LT", "NK"];
  if (STRONG_ENDS.some((e) => word.endsWith(e))) tags.push("STRONG-END");

  // Tag: single syllable guess (≤4 letters with ≤2 vowels = punchy)
  const vowelCount = [...word].filter((c) => "AEIOU".includes(c)).length;
  if (vowelCount <= 2) tags.push("PUNCHY");

  return {
    score: dictScore + bigramScore + vowelScore,
    breakdown: { dictionary: dictScore, bigram: bigramScore, vowel: vowelScore },
    tags,
  };
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

/**
 * Vanity number generator — 4-digit edition.
 *
 * Full pipeline:
 *   1. Slice last 4 digits from the caller number
 *   2. DFS through letter combos with dictionary-prefix pruning
 *   3. Score each confirmed dictionary match (3 signals)
 *   4. Sort by score desc → deduplicate → take top 5
 *   5. Pad to 5 with raw-digit fallback if fewer matches found
 */
function generateVanityNumbers(
  callerNumber: string,
  dict: string[],
): VanityResult {
  const allDigits = callerNumber.replace(/\D/g, "");
  const last4 = allDigits.slice(-4);
  const prefix = allDigits.slice(0, -4); // e.g. "800555" for "8005551234"

  // Build lookup structures from the 4-letter dictionary
  const wordSet = new Set(dict.map((w) => w.toUpperCase()));

  const prefixes = new Set<string>();
  for (const word of wordSet) {
    for (let i = 1; i <= word.length; i++) {
      prefixes.add(word.slice(0, i));
    }
  }

  // Step 1 — Find every dictionary word reachable from these 4 digits
  const dictWords = findDictionaryWords(last4, wordSet, prefixes);

  console.log(
    `[Vanity] callerNumber=${callerNumber} last4=${last4} dictMatches=${dictWords.length}`,
    dictWords,
  );

  // Step 2 — Score each match
  const scored: VanityCandidate[] = dictWords.map((word) => {
    const { score, breakdown, tags } = scoreWord(word);
    const vanityNumber = prefix ? `${prefix}-${word}` : word;
    return { word, vanityNumber, score, breakdown, tags, isFallback: false };
  });

  // Step 3 — Sort best score first
  scored.sort((a, b) => b.score - a.score);

  // Step 4 — Deduplicate: skip words sharing the same first 3 letters
  // (e.g. CALL vs CALM — keep only the higher scorer)
  const seenPrefixes = new Set<string>();
  const top5: VanityCandidate[] = [];

  for (const candidate of scored) {
    const key = candidate.word.slice(0, 3);
    if (!seenPrefixes.has(key)) {
      seenPrefixes.add(key);
      top5.push(candidate);
    }
    if (top5.length >= 5) break;
  }

  // Step 5 — Guarantee exactly 5 results with raw-digit fallback
  while (top5.length < 5) {
    const fallbackNumber = prefix ? `${prefix}-${last4}` : last4;
    top5.push({
      word: last4,
      vanityNumber: fallbackNumber,
      score: 0,
      breakdown: { dictionary: 0, bigram: 0, vowel: 0 },
      tags: ["FALLBACK"],
      isFallback: true,
    });
  }

  console.log(
    "[Vanity] top5:",
    top5.map((c) => `${c.word}(${c.score}${c.isFallback ? " fallback" : ""})`),
  );

  return { callerNumber, last4Digits: last4, top5 };
}

// ─── DynamoDB ─────────────────────────────────────────────────────────────────

const dynamoClient = new DynamoDBClient({});

async function saveResultsToDynamoDB(result: VanityResult): Promise<void> {
  const tableName = process.env.VANITY_TABLE_NAME;
  if (!tableName) {
    console.warn("VANITY_TABLE_NAME not set — skipping DynamoDB write");
    return;
  }

  const timestamp = new Date().toISOString();

  const item = {
    pk: result.callerNumber,
    sk: timestamp,
    callerNumber: result.callerNumber,
    last4Digits: result.last4Digits,
    vanity1: result.top5[0]?.vanityNumber ?? result.callerNumber,
    vanity2: result.top5[1]?.vanityNumber ?? result.callerNumber,
    vanity3: result.top5[2]?.vanityNumber ?? result.callerNumber,
    vanity4: result.top5[3]?.vanityNumber ?? result.callerNumber,
    vanity5: result.top5[4]?.vanityNumber ?? result.callerNumber,
    // Full score metadata for analytics
    scoreMetadata: result.top5.map((c) => ({
      word: c.word,
      score: c.score,
      tags: c.tags,
      breakdown: c.breakdown,
      isFallback: c.isFallback,
    })),
    entityType: "VANITY",
    createdAt: timestamp,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item),
    }),
  );
}

// ─── Lambda Handler ───────────────────────────────────────────────────────────

export async function handler(event: ConnectEvent, _context?: Context) {
  const callerNumber = extractCallerNumber(event);

  const result = generateVanityNumbers(callerNumber, dictionary);

  await saveResultsToDynamoDB(result);

  // Amazon Connect reads these 3 attributes from the Lambda response
  return {
    vanity1: result.top5[0]?.vanityNumber ?? callerNumber,
    vanity2: result.top5[1]?.vanityNumber ?? callerNumber,
    vanity3: result.top5[2]?.vanityNumber ?? callerNumber,
  };
}