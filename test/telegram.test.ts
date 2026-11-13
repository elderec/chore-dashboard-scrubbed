import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramMessage, TelegramApiError } from "../src/telegram";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendTelegramMessage", () => {
  it("POSTs to the bot's sendMessage endpoint with the chat id and text", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramMessage("bot-token-123", "chat-456", "hello");

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.telegram.org/bot" + "bot-token-123" + "/sendMessage");
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "chat-456", text: "hello" });
  });

  it("throws a TelegramApiError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad request", { status: 400 })));
    await expect(sendTelegramMessage("tok", "chat", "hi")).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("throws a TelegramApiError instead of hanging when Telegram never responds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = sendTelegramMessage("tok", "chat", "hi");
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(TelegramApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    await expect(resultPromise).rejects.toMatchObject({ status: 408 });

    vi.useRealTimers();
  });
});
