const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

export class TelegramApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** notifyTelegram in index.ts awaits this inline before returning the complete/reopen
 * response to the tablet, so a hang here (not just a failure) would hang that response
 * indefinitely even though the underlying Todoist write already succeeded. The timeout
 * turns a hang into an ordinary caught-and-logged TelegramApiError instead, matching
 * the same fix already applied to todoistFetch in src/todoist.ts. */
export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TelegramApiError(408, `Telegram sendMessage timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new TelegramApiError(res.status, `Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}
