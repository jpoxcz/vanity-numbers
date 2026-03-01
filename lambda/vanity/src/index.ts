import type { Context } from "aws-lambda";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import dictionary from "../utils/dictionary";

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
  lengthScore: number;
  vowelScore: number;
  tierBonus: number;
  positionBonus: number;
  total: number;
};

type VanityCandidate = {
  vanityNumber: string; // e.g. "1-800-FLOWERS"
  word: string; // matched word, e.g. "FLOWERS"
  tier: "full" | "suffix" | "partial"; // full=entire 7 digits, suffix=last N, partial=segment
  score: number;
  tags: string[];
  breakdown: ScoreBreakdown;
  windowStart: number; // digit index where word starts within last7Digits
};

type VanityResult = {
  callerNumber: string;
  last7Digits: string;
  top5: VanityCandidate[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const PHONE_KEYPAD: Record<string, string[]> = {
  "2": ["A", "B", "C"],
  "3": ["D", "E", "F"],
  "4": ["G", "H", "I"],
  "5": ["J", "K", "L"],
  "6": ["M", "N", "O"],
  "7": ["P", "Q", "R", "S"],
  "8": ["T", "U", "V"],
  "9": ["W", "X", "Y", "Z"],
  // 0 and 1 have no letter mapping — kept as digits
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCallerNumber(event: ConnectEvent): string {
  console.log("event", JSON.stringify(event, null, 2));
  const raw =
    event?.Details?.ContactData?.CustomerEndpoint?.Address ??
    event?.callerNumber;
  return raw ? String(raw).replace(/\D/g, "") : "8005551234";
}

/**
 * Returns true if `word` can be spelled by the digits in `digitSlice`.
 * 0 and 1 have no letter mapping and will never match a letter.
 */
function wordMatchesDigits(word: string, digitSlice: string[]): boolean {
  if (word.length !== digitSlice.length) return false;
  for (let i = 0; i < word.length; i++) {
    const letters = PHONE_KEYPAD[digitSlice[i]];
    if (!letters || !letters.includes(word[i].toUpperCase())) return false;
  }
  return true;
}

/**
 * Scores a word by vowel/consonant patterns for memorability.
 * Returns a numeric score — higher = more memorable.
 */
function scoreVowelPattern(word: string): number {
  const VOWELS = new Set("AEIOU");
  let score = 0;
  let consonantStreak = 0;
  let vowelCount = 0;

  for (const ch of word.toUpperCase()) {
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

/**
 * Scores a word overall for vanity number quality.
 * - Length: longer dictionary words covering more digits score higher
 * - Vowel pattern: pronounceable words score higher
 * - Tier: full matches > suffix matches > partial matches
 * - Position: words appearing later in the number (suffix) are more natural
 */
function scoreCandidate(
  word: string,
  windowStart: number,
  totalDigits: number,
  tier: VanityCandidate["tier"],
): ScoreBreakdown {
  const len = word.length;

  // Length score: reward covering more of the number
  const lengthScore =
    len >= 7
      ? 60
      : len >= 6
        ? 50
        : len >= 5
          ? 38
          : len >= 4
            ? 22
            : len >= 3
              ? 10
              : 2;

  // Vowel/consonant pattern
  const vowelScore = scoreVowelPattern(word);

  // Tier bonus
  const tierBonus = tier === "full" ? 30 : tier === "suffix" ? 15 : 5;

  // Position bonus: prefer words that start at a clean boundary
  // (0 = very start, totalDigits - len = very end)
  const positionBonus =
    windowStart === 0 || windowStart === totalDigits - len ? 8 : 0;

  const total = lengthScore + vowelScore + tierBonus + positionBonus;

  return { lengthScore, vowelScore, tierBonus, positionBonus, total };
}

/**
 * Assigns human-readable tags to a candidate for metadata/analytics.
 */
function buildTags(word: string, tier: VanityCandidate["tier"]): string[] {
  const tags: string[] = [tier];
  const len = word.length;

  if (len >= 7) tags.push("full-word");
  else if (len >= 5) tags.push("long-word");
  else if (len >= 3) tags.push("short-word");

  const vowelRatio =
    [...word.toUpperCase()].filter((c) => "AEIOU".includes(c)).length / len;
  if (vowelRatio >= 0.4) tags.push("pronounceable");
  if (vowelRatio < 0.2) tags.push("consonant-heavy");

  return tags;
}

/**
 * Formats a vanity number string from its components.
 * Examples:
 *   prefix="1-800", prefix7="5550123", word="FLOWERS", windowStart=0, wordLen=7
 *   → "1-800-FLOWERS"
 *
 *   prefix="1-800", prefix7="5550123", word="OWL", windowStart=2, wordLen=3
 *   → "1-800-55-OWL-23"
 */
function formatVanityNumber(
  countryPrefix: string,
  areaCode: string,
  last7: string,
  word: string,
  windowStart: number,
): string {
  const before = last7.slice(0, windowStart);
  const after = last7.slice(windowStart + word.length);

  const parts: string[] = [];
  if (countryPrefix) parts.push(countryPrefix);
  if (areaCode) parts.push(areaCode);

  // Build the 7-digit segment with word substituted in
  const segment = [before, word.toUpperCase(), after].filter(Boolean).join("-");
  parts.push(segment);

  return parts.join("-");
}

// ─── Core Generation ──────────────────────────────────────────────────────────

/**
 * Generates the top vanity number candidates for a caller number.
 *
 * Strategy:
 * 1. Extract the last 7 meaningful digits (standard US vanity convention).
 * 2. For every word in the dictionary, slide it over all valid windows of the
 *    7-digit string and check if the digits can spell the word.
 * 3. Score each match and return the top 5 sorted by score desc.
 *
 * 0 and 1 are treated as literal digits (no letter mapping on a keypad).
 */
export function generateVanityNumbers(
  rawNumber: string,
  dict: string[],
): VanityResult {
  const digits = rawNumber.replace(/\D/g, "");

  // ── Parse US number structure ──────────────────────────────────────────────
  let countryPrefix = "";
  let areaCode = "";
  let last7Digits = "";

  if (digits.length === 11 && digits.startsWith("1")) {
    countryPrefix = "1";
    areaCode = digits.slice(1, 4);
    last7Digits = digits.slice(4);
  } else if (digits.length === 10) {
    areaCode = digits.slice(0, 3);
    last7Digits = digits.slice(3);
  } else if (digits.length === 7) {
    last7Digits = digits;
  } else {
    // Fallback: use last 7 (or all if shorter)
    last7Digits = digits.slice(-7);
  }

  const digitArr = last7Digits.split("");
  const candidates: VanityCandidate[] = [];

  // ── Normalise dictionary ───────────────────────────────────────────────────
  const normalised = dict
    .map((w) => w.toUpperCase().replace(/[^A-Z]/g, ""))
    .filter(Boolean);

  for (const word of normalised) {
    const wordLen = word.length;
    if (wordLen < 3 || wordLen > last7Digits.length) continue;

    // Slide word across all valid start positions
    for (let start = 0; start <= last7Digits.length - wordLen; start++) {
      const slice = digitArr.slice(start, start + wordLen);
      if (!wordMatchesDigits(word, slice)) continue;

      // Determine tier
      let tier: VanityCandidate["tier"];
      if (wordLen === last7Digits.length) {
        tier = "full";
      } else if (start + wordLen === last7Digits.length) {
        tier = "suffix"; // word ends at the last digit — most natural
      } else {
        tier = "partial";
      }

      const breakdown = scoreCandidate(word, start, last7Digits.length, tier);
      const tags = buildTags(word, tier);

      const vanityNumber = formatVanityNumber(
        countryPrefix,
        areaCode,
        last7Digits,
        word,
        start,
      );

      candidates.push({
        vanityNumber,
        word,
        tier,
        score: breakdown.total,
        tags,
        breakdown,
        windowStart: start,
      });
    }
  }

  // ── Deduplicate by vanityNumber, keep highest score per unique result ───────
  const seen = new Map<string, VanityCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.vanityNumber);
    if (!existing || c.score > existing.score) {
      seen.set(c.vanityNumber, c);
    }
  }

  // ── Sort & take top 5 ──────────────────────────────────────────────────────
  const top5 = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);

  console.log(
    `[vanity] callerNumber=${rawNumber} last7=${last7Digits} candidates=${candidates.length} top5=${top5.map((c) => c.vanityNumber).join(", ")}`,
  );

  return {
    callerNumber: rawNumber,
    last7Digits,
    top5,
  };
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
  const hasVanity = result.top5.length > 0;

  // Always write — empty strings for vanity fields when no match was found
  // sk = timestamp preserves full call history per caller
  const item = {
    pk: result.callerNumber,
    sk: timestamp,
    callerNumber: result.callerNumber,
    last7Digits: result.last7Digits,
    vanity1: result.top5[0]?.vanityNumber ?? "",
    vanity2: result.top5[1]?.vanityNumber ?? "",
    vanity3: result.top5[2]?.vanityNumber ?? "",
    vanity4: result.top5[3]?.vanityNumber ?? "",
    vanity5: result.top5[4]?.vanityNumber ?? "",
    scoreMetadata: result.top5.map((c) => ({
      word: c.word,
      tier: c.tier,
      score: c.score,
      tags: c.tags,
      breakdown: c.breakdown,
      windowStart: c.windowStart,
    })),
    hasVanity,
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

type HandlerResponse = {
  vanity1: string;
  vanity2: string;
  vanity3: string;
};

export async function handler(
  event: ConnectEvent,
  _context?: Context,
): Promise<HandlerResponse> {
  const callerNumber = extractCallerNumber(event);

  const result = generateVanityNumbers(callerNumber, dictionary);

  if (result.top5.length === 0) {
    console.warn(
      `[vanity] No vanity numbers available for ${callerNumber} (last7=${result.last7Digits}) — saving record with empty vanity fields`,
    );
  }

  await saveResultsToDynamoDB(result);

  // Return empty string to Connect when no vanity is available —
  // Connect flow should check for "" and handle the no-vanity branch
  return {
    vanity1: result.top5[0]?.vanityNumber ?? "",
    vanity2: result.top5[1]?.vanityNumber ?? "",
    vanity3: result.top5[2]?.vanityNumber ?? "",
  };
}
