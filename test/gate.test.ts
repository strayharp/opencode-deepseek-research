import { describe, expect, test } from "bun:test"
import { createVerifyGate, finalAssistantText } from "../plugin/gate.ts"
import { answerHash, verificationReceiptKey, type VerificationReceipt } from "../plugin/verify.ts"

const ANSWER = "Accuracy reached 73.4% on the held-out set."

function setup(options: { enabled?: boolean; maxGates?: number; parentID?: string } = {}) {
  const { parentID, ...gateOptions } = options
  const data = new Map<string, unknown>()
  const calls: any[] = []
  let messages: any[] = [{ type: "assistant", content: [{ type: "text", text: ANSWER }] }]
  const session = {
    async context() {
      return messages
    },
    async get() {
      return parentID ? { parentID } : {}
    },
    async synthetic(input: any) {
      calls.push(input)
      return { id: "msg_gate" }
    },
  }
  const gate = createVerifyGate({
    session,
    storage: { get: async (key) => data.get(key) },
    projectID: "proj_test",
    warn: () => {},
    ...gateOptions,
  })
  return { gate, session, data, calls, setMessages: (next: any[]) => (messages = next) }
}

function idle(sessionID = "ses_gate") {
  return { type: "session.status", data: { sessionID, status: { type: "idle" } } }
}

function receipt(pass: boolean, answer = ANSWER): VerificationReceipt {
  return {
    answerHash: answerHash(answer),
    pass,
    issueCount: pass ? 0 : 1,
    issues: pass ? [] : ["metric: number 99.9 not found"],
    at: "2026-10-23T00:00:00.000Z",
  }
}

describe("verify gate", () => {
  test("blocks one answer with verifiable claims and sends a synthetic rewrite request", async () => {
    const { gate, calls } = setup()
    expect(await gate.handle(idle())).toBe("gated")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionID: "ses_gate",
      delivery: "queue",
      resume: true,
      description: "verification required before final answer",
      metadata: { source: "verify-gate", attempt: 1, maxGates: 1 },
    })
    expect(calls[0].text).toContain('<verify-gate state="blocked"')
    expect(calls[0].text).toContain("exact final text")
    expect(gate.attempts("ses_gate")).toBe(1)

    expect(await gate.handle(idle())).toBe("ignored")
    expect(calls).toHaveLength(1)
    gate.reset("ses_gate")
    expect(await gate.handle(idle())).toBe("gated")
    expect(calls).toHaveLength(2)
  })

  test("accepts an exact passing receipt", async () => {
    const { gate, calls, data } = setup()
    data.set(verificationReceiptKey("proj_test", "ses_gate"), receipt(true))
    expect(await gate.handle(idle())).toBe("ignored")
    expect(calls).toHaveLength(0)
  })

  test("blocks when the verified answer differs or verification failed", async () => {
    const { gate, calls, data } = setup()
    data.set(verificationReceiptKey("proj_test", "ses_gate"), receipt(true, "A different answer with 99.9%."))
    expect(await gate.handle(idle())).toBe("gated")
    expect(calls).toHaveLength(1)

    const second = setup()
    second.data.set(verificationReceiptKey("proj_test", "ses_gate"), receipt(false))
    expect(await second.gate.handle(idle())).toBe("gated")
    expect(second.calls[0].text).toContain("Last verification issues")
    expect(second.calls[0].text).toContain("number 99.9")
  })

  test("ignores child/subagent sessions but still gates the root session", async () => {
    const child = setup({ parentID: "ses_parent" })
    expect(await child.gate.handle(idle())).toBe("ignored")
    expect(child.calls).toHaveLength(0)

    const root = setup()
    expect(await root.gate.handle(idle())).toBe("gated")
    expect(root.calls).toHaveLength(1)
  })

  test("ignores tool-call messages, claim-free answers, and disabled gates", async () => {
    const toolCall = setup()
    toolCall.setMessages([
      { type: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool", name: "verify" }] },
    ])
    expect(await toolCall.gate.handle(idle())).toBe("ignored")
    expect(toolCall.calls).toHaveLength(0)

    const prose = setup()
    prose.setMessages([{ type: "assistant", content: [{ type: "text", text: "The result looks promising." }] }])
    expect(await prose.gate.handle(idle())).toBe("ignored")

    const disabled = setup({ enabled: false })
    expect(await disabled.gate.handle(idle())).toBe("ignored")
    expect(disabled.calls).toHaveLength(0)
  })

  test("supports execution-succeeded and deprecated idle events", async () => {
    const { gate, calls } = setup()
    expect(await gate.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_gate" } })).toBe("gated")
    expect(calls).toHaveLength(1)
    gate.reset("ses_gate")
    expect(await gate.handle({ type: "session.idle", data: { sessionID: "ses_gate" } })).toBe("gated")
    expect(calls).toHaveLength(2)
    expect(
      finalAssistantText([
        { type: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: " answer " }] },
        { type: "idle", outcome: "succeeded" },
      ]),
    ).toBe("answer")
    expect(finalAssistantText([{ type: "assistant", content: [{ type: "tool" }] }, { type: "idle" }])).toBeUndefined()
  })
})
