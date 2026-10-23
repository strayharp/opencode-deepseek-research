import { createServer, type Server } from "node:http"

export interface BudgetGuardServer {
  /** Base URL to use for a blocked model request. */
  url: string
  close(): Promise<void>
}

/**
 * A local endpoint used only when a model request must be stopped without
 * contacting the provider. It returns a clear 402 instead of attempting to
 * emulate a provider protocol.
 */
export async function createBudgetGuardServer(): Promise<BudgetGuardServer> {
  const server: Server = createServer((_request, response) => {
    const body = JSON.stringify({
      error: {
        type: "budget_exceeded",
        message: "deepseek-research budget guard stopped this request",
      },
    })
    response.statusCode = 402
    response.setHeader("content-type", "application/json")
    response.setHeader("content-length", Buffer.byteLength(body))
    response.end(body)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(0, "127.0.0.1")
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error("budget guard server did not bind to a TCP port")
  }

  server.unref()
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (closing) return closing
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      return closing
    },
  }
}
