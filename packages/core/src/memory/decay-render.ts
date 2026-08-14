/**
 * Deterministic tier-decay renderer — simplified from the 230-line original.
 *
 * Renders compartments at their computed decay tier (P1..P4), with budget
 * enforcement and legacy content fallback. P5 = archived (omitted).
 */

import {
  computeBudgetPressure,
  renderedTier,
  TIER_COST,
  type Tier,
} from "./decay";

/** Default history budget when caller doesn't supply one. */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;

/** Minimal compartment shape the renderer needs. */
export interface DecayRenderCompartment {
  startMessage: number;
  endMessage: number;
  title: string;
  content: string;
  p1?: string | null;
  p2?: string | null;
  p3?: string | null;
  p4?: string | null;
  importance?: number | null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isTieredRow(c: DecayRenderCompartment): boolean {
  return typeof c.p1 === "string" && c.p1.length > 0;
}

function tierBody(c: DecayRenderCompartment, tier: number): string {
  const tiers = [c.p1, c.p2, c.p3, c.p4];
  const requested = tiers[tier - 1];
  if (typeof requested === "string") return requested.trim();
  // Fallback to denser tier
  for (let i = tier - 2; i >= 0; i--) {
    const t = tiers[i];
    if (typeof t === "string" && t.length > 0) return t.trim();
  }
  return (c.content ?? "").trim();
}

function legacyBodyForTier(content: string, tier: number): string {
  if (tier <= 1) return content;
  if (tier === 2)
    return content.length > 1200 ? `${content.slice(0, 1200).trimEnd()}...` : content;
  return content.length > 420 ? `${content.slice(0, 420).trimEnd()}...` : content;
}

function renderOneCompartment(c: DecayRenderCompartment, tier: number): string {
  const baseAttrs = `start="${c.startMessage}" end="${c.endMessage}" title="${escapeXml(c.title)}"`;
  if (tier >= 5) return ""; // archived

  // Non-tiered rows use flat content with truncation
  if (!isTieredRow(c)) {
    const flat = (c.content ?? "").trim();
    if (tier >= 4 || flat.length === 0) return `<compartment ${baseAttrs} />`;
    return [
      `<compartment ${baseAttrs}>`,
      escapeXml(legacyBodyForTier(flat, tier)),
      "</compartment>",
    ].join("\n");
  }

  const body = tierBody(c, tier);
  if (body.length === 0) return `<compartment ${baseAttrs} />`;
  return [
    `<compartment ${baseAttrs}>`,
    escapeXml(body),
    "</compartment>",
  ].join("\n");
}

/**
 * Compute the rendered tier for each compartment.
 * Compartments are in chronological order (oldest first).
 */
function computeTiers(
  compartments: DecayRenderCompartment[],
  historyBudgetTokens: number,
): number[] {
  const total = compartments.length;
  const curveInputs = compartments.map((c, i) => ({
    index: total - i, // 1-based from newest
    importance: Math.max(1, Math.min(100, c.importance ?? 50)),
  }));

  const pressure =
    historyBudgetTokens > 0
      ? computeBudgetPressure(curveInputs, historyBudgetTokens)
      : 1;

  return compartments.map((c, i) =>
    renderedTier(total - i, c.importance ?? 50, pressure, 0),
  );
}

/**
 * Estimate token count (simplified: ~4 chars per token).
 * The full implementation uses a real tokenizer; this is a practical approximation.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Render decayed compartment history block.
 * Returns the joined body (no wrapper tag — callers add their own framing).
 */
export function renderDecayedCompartments(args: {
  compartments: DecayRenderCompartment[];
  historyBudgetTokens?: number;
}): string {
  const { compartments, historyBudgetTokens = DEFAULT_HISTORY_BUDGET_TOKENS } = args;
  if (compartments.length === 0) return "";

  const tiers = computeTiers(compartments, historyBudgetTokens);

  const render = (): string => {
    const parts: string[] = [];
    for (let i = 0; i < compartments.length; i++) {
      const rendered = renderOneCompartment(compartments[i], tiers[i]);
      if (rendered.length > 0) parts.push(rendered);
    }
    return parts.join("\n\n");
  };

  let body = render();

  // Budget guard: demote oldest-first until it fits
  let guard = compartments.length * 5;
  while (
    historyBudgetTokens > 0 &&
    estimateTokens(body) > historyBudgetTokens &&
    guard > 0
  ) {
    let demoted = false;
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i] < 5) {
        tiers[i] += 1;
        demoted = true;
        break;
      }
    }
    if (!demoted) break;
    body = render();
    guard -= 1;
  }

  return body;
}

/**
 * Render a single compartment at an explicit tier.
 * Used for newest compartments that always render at P1.
 */
export function renderCompartmentAtTier(
  c: DecayRenderCompartment,
  tier: number,
): string {
  return renderOneCompartment(c, tier);
}

/**
 * Extract a top-level block slice from m[0] text for budget measurement.
 */
export function extractM0Block(m0Text: string, tag: string): string | null {
  const m = m0Text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
  return m ? m[0] : null;
}

export { TIER_COST };
