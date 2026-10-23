import { expect, test } from "bun:test"
import { createBudgetGuardServer } from "../plugin/budget-server.ts"

test("budget guard endpoint rejects requests with a clear 402", async () => {
  const guard = await createBudgetGuardServer()
  try {
    expect(guard.url).toStartWith("http://127.0.0.1:")
    const response = await fetch(`${guard.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({
      error: { type: "budget_exceeded" },
    })
  } finally {
    await guard.close()
  }
})
