import { badRequest, conflict, json, readBody } from "./http.mjs";
import { streamOnce } from "./native-llm.mjs";

const INPUT_LIMIT = 4000;
const CHAT_TIMEOUT_MS = 45_000;
const SYSTEM_PROMPTS = {
  ask: "直接简洁地回答用户的问题，使用用户的语言。只输出回答正文。",
  "translate-zh": "把用户提供的文字译成简体中文。保留原意和段落。只输出译文。",
  "translate-en": "Translate the user's text into English. Preserve meaning and paragraphs. Output only the translation.",
};

export function createQuickChat({ llmService, defaultModelSelection }) {
  let active = null;
  let stopped = false;

  async function handle(req, res) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers?.["content-type"] || "")) {
      throw badRequest("请使用 JSON 提交快聊内容");
    }
    const body = await readBody(req, { limit: 32 * 1024, timeoutMs: 5000 });
    const input = typeof body?.input === "string" ? body.input.trim() : "";
    if (!input || input.length > INPUT_LIMIT || typeof body.mode !== "string" || !Object.hasOwn(SYSTEM_PROMPTS, body.mode)) {
      throw badRequest(`请选择快聊模式并输入 1–${INPUT_LIMIT} 字`);
    }
    if (stopped) throw Object.assign(new Error("看板服务已停止"), { code: "stopped" });
    if (active) throw conflict(active.signal.aborted ? "上一次模型请求正在停止，请稍后再试" : "已有快聊请求进行中");
    const llm = llmService();
    const route = defaultModelSelection();
    if (!route || typeof llm?.stream !== "function") {
      json(res, 503, { ok: false, error: "chat-unavailable", message: "快聊暂不可用，请在 DSH 设置 → 模型中设置默认模型" });
      return;
    }
    if (res.destroyed) return;
    const controller = new AbortController();
    active = controller;
    const release = () => {
      if (active === controller) active = null;
    };
    const onClose = () => controller.abort("closed");
    res.on("close", onClose);
    const timer = setTimeout(() => controller.abort("timeout"), CHAT_TIMEOUT_MS);
    timer.unref?.();
    const write = (event) => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + "\n");
    };
    let modelStarted = false;
    try {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      write({ type: "start", model: route.model });
      const cancelled = new Promise((resolve) => {
        const finish = () => resolve({ ok: false, code: controller.signal.reason });
        if (controller.signal.aborted) finish();
        else controller.signal.addEventListener("abort", finish, { once: true });
      });
      modelStarted = true;
      const response = streamOnce({
        llm, ...route, signal: controller.signal,
        system: SYSTEM_PROMPTS[body.mode],
        messages: [{ role: "user", content: [{ type: "text", text: input }] }],
        maxTokens: 1200, maxChars: 12_000,
        waitForCleanup: true,
        onText: (text) => write({ type: "delta", text }),
      }).finally(release);
      const outcome = await Promise.race([cancelled, response]);
      if (outcome.ok) write({ type: "done" });
      else if (!["closed", "stopped"].includes(outcome.code)) write({
        type: "error",
        message: outcome.code === "timeout" ? "回答超时，请重试"
          : outcome.code === "truncated" ? "回答达到长度上限，可缩短输入后重试"
          : "模型未能完成回答，请重试或检查 DSH 默认模型",
      });
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      if (!modelStarted) release();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  return { handle, stop() { stopped = true; active?.abort("stopped"); } };
}
