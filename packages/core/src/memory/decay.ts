/**
 * Tiered decay math — pure functions extracted from
 * dev/opencode-magic-context decay-curve.ts.
 *
 * Determines which paraphrase tier (P1..P4) a memory renders at,
 * and which should be archived (P5). Hyperparameters from the
 * council-validated model.
 */

// === Hyperparameters ===
/** Half-life (in compartments) for importance 50 at pressure 1. */
export const H50 = 24;
/** Importance points needed to double the half-life. */
export const D = 25;
/** Max extra half-lives of P4 protection from full anchor overlap. */
export const G = 2;

// === Derived constants (from empirical tier costs) ===
export const Z1 = 0.201; // P1→P2
export const Z2 = 0.729; // P2→P3
export const Z3 = 1.322; // P3→P4
export const Z4 = 2.587; // P4→P5 (archive candidate)

/** Pressure floor: prevents div-by-zero and caps relaxation at 10×. */
export const P_FLOOR = 0.1;

/** Per-tier average token cost, indexed by tier number (1..5). Index 0 unused. */
export const TIER_COST = [0, 322, 109, 35, 20, 5] as const;

export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 * @param importance 1..100 (historian-emitted decay rate).
 * @param budgetPressure 0.10..∞ (computed once per pass via computeBudgetPressure).
 */
export function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier {
  const a = Math.max(compartmentIndex, 1) - 1;
  const imp = Math.max(1, Math.min(100, importance));
  const p = Math.max(budgetPressure, P_FLOOR);

  const F = 2 ** ((imp - 50) / D);
  const H = (H50 * F) / p;
  const z = a / H;

  if (z < Z1) return 1;
  if (z < Z2) return 2;
  if (z < Z3) return 3;
  if (z < Z4) return 4;
  return 5;
}

/**
 * Whether a compartment should be archived (P5, not rendered).
 */
export function shouldArchive(
  compartmentIndex: number,
  importance: number,
  budgetPressure: number,
  anchorOverlap = 0,
): boolean {
  const a = Math.max(compartmentIndex, 1) - 1;
  const imp = Math.max(1, Math.min(100, importance));
  const p = Math.max(budgetPressure, P_FLOOR);
  const o = Math.max(0, Math.min(1, anchorOverlap));

  const F = 2 ** ((imp - 50) / D);
  const H = (H50 * F) / p;
  const z = a / H;

  return z >= Z4 + G * o;
}

/**
 * Final rendered tier combining base tier + archive protection.
 */
export function renderedTier(
  compartmentIndex: number,
  importance: number,
  budgetPressure: number,
  anchorOverlap = 0,
): Tier {
  if (shouldArchive(compartmentIndex, importance, budgetPressure, anchorOverlap)) {
    return 5;
  }
  const base = tier(compartmentIndex, importance, budgetPressure);
  return Math.min(base, 4) as Tier;
}

/**
 * Compute budget pressure for a render pass in a single forward pass.
 */
export function computeBudgetPressure(
  compartments: ReadonlyArray<{ index: number; importance: number }>,
  historyBudget: number,
): number {
  if (historyBudget <= 0) return 1;
  let naturalCost = 0;
  for (const c of compartments) {
    const naturalTier = tier(c.index, c.importance, 1.0);
    naturalCost += naturalTier >= 5 ? 0 : TIER_COST[naturalTier];
  }
  return Math.max(P_FLOOR, naturalCost / historyBudget);
}
