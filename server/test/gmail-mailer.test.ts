import test from "node:test"
import assert from "node:assert/strict"
import { GmailMailer } from "../src/email/gmail-mailer.ts"

/**
 * Regression test for a duplicate-delivery path: `send()` must not report failure
 * for a message Gmail has already accepted.
 *
 * Reading the RFC Message-ID back is a *second* API call, made after delivery. When
 * a failure there was allowed to propagate, a transient 503 threw
 * `GmailRateLimitError` out of `send()` — which the tick cannot tell apart from the
 * message never having gone out. It called `markFailed`, the row returned to
 * `pending`, and the recipient received the same email again on the next attempt.
 *
 * The `gmail` field is replaced directly rather than through a mocked module: the
 * point of the test is the ordering of two calls inside one method, and stubbing the
 * client is the smallest thing that exposes it.
 */
function mailerWith(messages: {
  send: () => Promise<unknown>
  get: () => Promise<unknown>
}): { mailer: GmailMailer; sendCalls: () => number } {
  const mailer = new GmailMailer("me@gmail.com", "Me", {} as never)
  let sendCalls = 0

  Object.assign(mailer, {
    gmail: {
      users: {
        messages: {
          send: async () => {
            sendCalls += 1
            return messages.send()
          },
          get: messages.get,
        },
      },
    },
  })

  return { mailer, sendCalls: () => sendCalls }
}

const delivered = async () => ({ data: { id: "m1", threadId: "t1" } })

test("a transient failure reading the Message-ID back does not fail a delivered send", async () => {
  const { mailer, sendCalls } = mailerWith({
    send: delivered,
    get: async () => {
      throw { response: { status: 503 }, message: "backend error" }
    },
  })

  const result = await mailer.send({ to: "a@b.com", subject: "Hi", text: "hello" })

  assert.equal(sendCalls(), 1)
  assert.equal(result.gmailMessageId, "m1")
  assert.equal(result.threadId, "t1", "threadId alone still threads follow-ups")
  assert.equal(result.rfcMessageId, undefined, "absent, not fatal")
})

test("a missing Message-ID header does not fail a delivered send either", async () => {
  const { mailer } = mailerWith({
    send: delivered,
    get: async () => ({ data: { payload: { headers: [] } } }),
  })

  const result = await mailer.send({ to: "a@b.com", subject: "Hi", text: "hello" })

  assert.equal(result.gmailMessageId, "m1")
  assert.equal(result.rfcMessageId, undefined)
})

test("the Message-ID is still returned when the read succeeds", async () => {
  const { mailer } = mailerWith({
    send: delivered,
    get: async () => ({
      data: { payload: { headers: [{ name: "Message-ID", value: "<abc@mail.gmail.com>" }] } },
    }),
  })

  const result = await mailer.send({ to: "a@b.com", subject: "Hi", text: "hello" })

  assert.equal(result.rfcMessageId, "<abc@mail.gmail.com>")
})
