const express = require("express");
const bodyParser = require("body-parser");
const SessionManager = require("./session_manager");

const app = express();
const manager = new SessionManager();

app.use(bodyParser.json({ limit: "50mb" }));

function getValue(data, ...keys) {
  for (const key of keys) {
    if (data[key] !== undefined) return data[key];
  }
  throw new Error(keys[0]);
}

function makeResponse(status, message, extra = {}) {
  return { status, message, ...extra };
}

function statusToHttp(status) {
  if (
    [
      "authenticated",
      "code_required",
      "2fa_required",
      "invalid_code",
      "expired_code",
      "invalid_2fa",
      "phone_code_hash_missing",
      "listening",
      "already_listening",
      "sent",
    ].includes(status)
  )
    return 200;
  return 400;
}

app.post("/session/start", async (req, res) => {
  try {
    const data = req.body || {};

    const credential_id = getValue(data, "credential_id", "credentialId");
    const api_id = getValue(data, "api_id", "apiId");
    const api_hash = getValue(data, "api_hash", "apiHash");
    const phone = getValue(data, "phone");
    const code = data.code?.trim() || null;
    const password = data.password || null;

    const result = await manager.authenticate({
      credential_id,
      api_id,
      api_hash,
      phone,
      code,
      password,
    });

    res.status(statusToHttp(result.status)).json(
      makeResponse(result.status, result.message, {
        credential_id,
      })
    );
  } catch (e) {
    res.status(400).json(makeResponse("internal_error", e.message));
  }
});

app.post("/:credential/send", async (req, res) => {
  try {
    const credential = req.params.credential;
    const data = req.body || {};

    const chat_id = getValue(data, "chat_id", "chatId");
    const text = data.text || "";
    const file_base64 = data.file_base64 || data.fileBase64;
    const file_name = data.file_name || data.fileName || "file.bin";
    const parse_mode = data.parse_mode || data.parseMode;
    const reply_to_message_id =
      data.reply_to_message_id || data.replyToMessageId;
    const silent = data.silent;

    const result = await manager.sendMessage({
      credential_id: credential,
      chat_id,
      text,
      file_base64,
      file_name,
      parse_mode,
      reply_to_message_id,
      silent,
    });

    if (result.error)
      return res.status(400).json(makeResponse(result.error, result.message));

    res.json(makeResponse("sent", result.message, result));
  } catch (e) {
    res.status(400).json(makeResponse("internal_error", e.message));
  }
});

app.post("/:credential/listener/register", async (req, res) => {
  try {
    const credential = req.params.credential;
    const webhook = getValue(req.body, "webhook");

    const result = await manager.registerListener(credential, webhook);

    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(400).json(makeResponse("internal_error", e.message));
  }
});

app.post("/:credential/listener/unregister", async (req, res) => {
  const result = await manager.unregisterListener(req.params.credential);
  res.json(result);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "n8n-nodes-telegram-node",
    message: "Servico ativo.",
  });
});

app.listen(process.env.PORT || 7132, () =>
  console.log("GRAMJS_SERVICE_READY")
);
