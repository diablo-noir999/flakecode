import type { Skill } from "."

export type SearchResult = {
  skill_id: string
  name: string
  score: number
  reason: string
}

export type SkillSearchModel = {
  id?: string
  modelID?: string
  name?: string
  family?: string
  api?: { id?: string }
}

function normalize(value: string) {
  return value.toLocaleLowerCase().trim()
}

function explicitlyMentions(query: string, value: string) {
  const normalizedQuery = normalize(query)
  const normalized = normalize(value)
  if (normalizedQuery === normalized) return true
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(normalizedQuery)
}

const STOP_WORDS = new Set([
  "a", "action", "an", "and", "audience",
  "for", "from", "input", "of", "output",
  "the", "to", "with",
])

function tokenize(value: string) {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !STOP_WORDS.has(token))
}

export function searchSkills(query: string, skills: Skill.Info[]): SearchResult[] {
  const exact = skills
    .filter((skill) => explicitlyMentions(query, skill.name))
    .map((skill) => ({
      skill_id: skill.name,
      name: skill.name,
      score: 1,
      reason: `The query explicitly mentions the skill name ${skill.name}.`,
    }))
  const queryTokens = [...new Set(tokenize(query))]
  const documents = skills.map((skill) =>
    tokenize([skill.name, skill.description ?? ""].join(" ")),
  )
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const scores = documents.map((document) =>
    queryTokens.reduce((score, token) => {
      const frequency = document.filter((word) => word === token).length
      if (frequency === 0) return score
      const documentFrequency = documents.filter((words) => words.includes(token)).length
      const inverseDocumentFrequency = Math.log(1 + (documents.length - documentFrequency + 1) / (documentFrequency + 1))
      return score + inverseDocumentFrequency * ((frequency * (1.5 + 1)) / (frequency + 1.5 * (1 - 0.75 + 0.75 * (document.length / averageLength))))
    }, 0),
  )
  const maximum = Math.max(...scores, 0)
  const bm25 = skills
    .map((skill, index) => ({
      skill,
      score: scores[index],
      coverage: queryTokens.filter((token) => documents[index].includes(token)).length / (queryTokens.length || 1),
    }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((item) => ({
      skill_id: item.skill.name,
      name: item.skill.name,
      score: Number(
        ((item.score / maximum) * 0.7 + item.coverage * 0.3).toFixed(2),
      ),
      reason: `The skill description matches these query terms: ${queryTokens
        .filter((token) => tokenize(item.skill.description ?? "").includes(token))
        .join(", ")}.`,
    }))
  const exactIDs = new Set(exact.map((result) => result.skill_id))
  return [...exact, ...bm25.filter((result) => !exactIDs.has(result.skill_id))].slice(0, 10)
}
