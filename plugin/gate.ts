import { finalAssistantText } from "./messages.ts"
import {
  answerHash,
  hasVerifiableClaims,
  isVerificationReceipt,
  verificationReceiptKey,
} from "./verify.ts"

export { finalAssistantText } from "./messages.ts"

export interface VerifyGateSession {
  context(input: { sessionID: string }): Promise<unknown>
  get?(input: { sessionID: string }): Promise<unknown>
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
    resume?: boolean
  }): Promise<unknown>
}

export interface VerifyGateStorage {
  get(key: string): Promise<unknown>
}

export interface VerifyGateOptions {
  session: VerifyGateSession
  storage: VerifyGateStorage
  projectID: string
  enabled?: boolean
  maxGates?: number
  warn?: (message: string, error?: unknown) => void
}

export type VerifyGateResult = "gated" | "ignored" | "error"

export interface VerifyGate {
  handle(event: unknown): Promise<VerifyGateResult>
  reset(sessionID: string): void
  attempts(sessionID: string): number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function idleSessionID(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  const data = isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : {}
  if (typeof data.sessionID !== "string") return undefined
  if (event.type === "session.idle" || event.type === "session.execution.succeeded") return data.sessionID
  if (event.type !== "session.status") return undefined
  const status = isRecord(data.status) ? data.status : undefined
  return status?.type === "idle" ? data.sessionID : undefined
}

function gateText(attempt: number, max: number, issues: readonly string[]): string {
  const failed =
    issues.length > 0 ? `\nLast verification issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}\n` : ""
  return `<verify-gate state="blocked" attempt="${attempt}" max="${max}">
The final answer contains verifiable claims, but no successful verify receipt matches this exact text.${failed}
Call the verify tool with:
- answer: the exact final text;
- claims: every key number (source, path, value, tolerance), citation, experiment (ids, metric, minSeeds, baseline), and code file.
If evidence is missing, replace the unsupported claim with "insufficient evidence". Do not deliver this answer again without a passing receipt.
</verify-gate>`
}

export function createVerifyGate(options: VerifyGateOptions): VerifyGate {
  const enabled = options.enabled !== false
  const maxGates = Math.max(1, Math.floor(options.maxGates ?? 1))
  const warn =
    options.warn ?? ((message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)))
  const counts = new Map<string, number>()

  async function handle(event: unknown): Promise<VerifyGateResult> {
    if (!enabled) return "ignored"
    const sessionID = idleSessionID(event)
    if (!sessionID) return "ignored"
    if ((counts.get(sessionID) ?? 0) >= maxGates) return "ignored"

    if (options.session.get) {
      try {
        const info = await options.session.get({ sessionID })
        // Candidate/judge/other subagent sessions are intermediate outputs.
        if (isRecord(info) && typeof info.parentID === "string") return "ignored"
      } catch (error) {
        warn(`[deepseek-research] verify gate could not read session ${sessionID}`, error)
      }
    }

    let messages: unknown
    try {
      messages = await options.session.context({ sessionID })
    } catch (error) {
      warn(`[deepseek-research] verify gate could not read context for ${sessionID}`, error)
      return "error"
    }
    const text = finalAssistantText(messages)
    if (!text || !hasVerifiableClaims(text)) return "ignored"

    let failedIssues: string[] = []
    try {
      const receipt = await options.storage.get(verificationReceiptKey(options.projectID, sessionID))
      if (isVerificationReceipt(receipt)) {
        if (receipt.pass && receipt.answerHash === answerHash(text)) return "ignored"
        if (!receipt.pass) failedIssues = receipt.issues?.slice(0, 3) ?? []
      }
    } catch (error) {
      warn(`[deepseek-research] verify gate could not read receipt for ${sessionID}`, error)
    }

    const attempt = (counts.get(sessionID) ?? 0) + 1
    counts.set(sessionID, attempt)
    try {
      await options.session.synthetic({
        sessionID,
        text: gateText(attempt, maxGates, failedIssues),
        description: "verification required before final answer",
        metadata: { source: "verify-gate", sessionID, attempt, maxGates },
        delivery: "queue",
        resume: true,
      })
      return "gated"
    } catch (error) {
      counts.set(sessionID, attempt - 1)
      warn(`[deepseek-research] verify gate could not notify ${sessionID}`, error)
      return "error"
    }
  }

  return {
    handle,
    reset(sessionID: string) {
      counts.delete(sessionID)
    },
    attempts(sessionID: string) {
      return counts.get(sessionID) ?? 0
    },
  }
}
