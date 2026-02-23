const { Api, TelegramClient } = require("telegram");
const { CustomFile } = require("telegram/client/uploads");
const { Buffer } = require("buffer");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

class SessionManager {
  constructor() {
    this.sessions = {};
    this.listeners = {};
    this.sessionsDir = path.join(__dirname, "sessions");
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir);
  }

  _getSessionFile(credential_id) {
    return path.join(this.sessionsDir, `${credential_id}.session`);
  }

  _mapAuthError(error) {
    const code = error?.errorMessage || error?.message || "";

    if (code.includes("PHONE_CODE_INVALID")) {
      return { status: "invalid_code", message: "Codigo invalido." };
    }
    if (code.includes("PHONE_CODE_EXPIRED")) {
      return { status: "expired_code", message: "Codigo expirado." };
    }
    if (code.includes("SESSION_PASSWORD_NEEDED")) {
      return { status: "2fa_required", message: "Conta com 2FA. Informe o campo password." };
    }
    if (code.includes("PASSWORD_HASH_INVALID")) {
      return { status: "invalid_2fa", message: "Senha 2FA invalida." };
    }
    if (code.includes("PHONE_NUMBER_INVALID")) {
      return { status: "invalid_phone", message: "Numero de telefone invalido." };
    }

    return { status: "internal_error", message: String(code || "Falha na autenticacao.") };
  }

  async _ensureSession({ credential_id, api_id, api_hash, phone }) {
    let session = this.sessions[credential_id];
    if (session) {
      if (!session.client.connected) {
        await session.client.connect();
      }
      session.phone = phone;
      return session;
    }

    const sessionFile = this._getSessionFile(credential_id);
    const sessionString = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf8").trim() : "";
    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, Number(api_id), api_hash, {
      connectionRetries: 5,
    });
    await client.connect();

    this.sessions[credential_id] = {
      client,
      phone,
      api_id: Number(api_id),
      api_hash,
      phoneCodeHash: null,
    };

    return this.sessions[credential_id];
  }

  async authenticate({
    credential_id,
    api_id,
    api_hash,
    phone,
    code,
    password,
  }) {
    const session = await this._ensureSession({ credential_id, api_id, api_hash, phone });

    const client = session.client;
    const apiCredentials = {
      apiId: Number(api_id),
      apiHash: api_hash,
    };

    if (await client.isUserAuthorized()) {
      return { status: "authenticated", message: "Sessao autenticada." };
    }

    if (!code && !password) {
      const sent = await client.sendCode(apiCredentials, phone);
      session.phoneCodeHash = sent.phoneCodeHash;
      return { status: "code_required", message: "Codigo enviado." };
    }

    if (password && !code) {
      try {
        await client.signInWithPassword(apiCredentials, {
          password: async () => password,
          onError: async () => true,
        });
      } catch (e) {
        return this._mapAuthError(e);
      }
    } else {
      if (!session.phoneCodeHash) {
        return {
          status: "phone_code_hash_missing",
          message: "Solicite um novo codigo (teste a credencial sem code) antes de validar.",
        };
      }

      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: session.phoneCodeHash,
            phoneCode: code,
          })
        );
      } catch (e) {
        const mapped = this._mapAuthError(e);
        if (mapped.status === "2fa_required") {
          return mapped;
        }
        return mapped;
      }
    }

    const sessionString = client.session.save();
    fs.writeFileSync(this._getSessionFile(credential_id), sessionString);
    session.phoneCodeHash = null;

    return { status: "authenticated", message: "Autenticado com sucesso." };
  }

  async sendMessage({
    credential_id,
    chat_id,
    text,
    file_base64,
    file_name,
    parse_mode,
    reply_to_message_id,
    silent,
  }) {
    const session = this.sessions[credential_id];

    if (!session) {
      return {
        error: "session_not_found",
        message: "Sessão não encontrada.",
      };
    }

    const client = session.client;

    try {
      // 🔹 Resolve entidade corretamente
      const entity = await client.getInputEntity(chat_id);

      // 🔹 Se tiver arquivo
      if (file_base64) {
        let cleanBase64 = file_base64;

        // Remove prefixo data:mime;base64,...
        if (file_base64.includes(",")) {
          if (!file_name || !file_name.includes(".")){
            const clean_ext = 
              file_base64.split(",")[0]
              .split(";")[0]
              .split(":")[1]
              .split("/")[1];

            file_name = !file_name ? 'desconhecido' : file_name;
            file_name += "." + clean_ext;
          }
          cleanBase64 = file_base64.split(",")[1];
        }

        const buffer = Buffer.from(cleanBase64, "base64");

        const file = new CustomFile(
          file_name || "file.bin",
          buffer.length,
          "",
          buffer
        );

        await client.sendFile(entity, {
          file,
          caption: text || "",
          parseMode: parse_mode || undefined,
          replyTo: reply_to_message_id || undefined,
          silent: silent || false,
        });

      } else {
        // 🔹 Apenas texto
        await client.sendMessage(entity, {
          message: text || "",
          parseMode: parse_mode || undefined,
          replyTo: reply_to_message_id || undefined,
          silent: silent || false,
        });
      }

      return {
        status: "sent",
        message: "Mensagem enviada com sucesso.",
        chat_id,
        credential_id,
      };

    } catch (error) {
      return {
        error: "send_failed",
        message: error?.message || String(error),
      };
    }
  }

  async registerListener(credential_id, webhook) {
    const session = this.sessions[credential_id];
    if (!session)
      return { error: "session_not_found", message: "Sessao nao encontrada." };

    if (this.listeners[credential_id])
      return {
        status: "already_listening",
        message: "Listener ja registrado.",
      };

    const client = session.client;

    const handler = async (event) => {
      const message = event.message;
      if (!message) return;

      // Sender
      let sender = null;
      try {
        sender = await event.getSender();
      } catch {
        sender = null;
      }

      const firstName = sender?.firstName || "";
      const lastName = sender?.lastName || "";
      const fromName =
        `${firstName} ${lastName}`.trim() ||
        sender?.username ||
        sender?.title ||
        "Desconhecido";

      // Me
      let meId = null;
      try {
        const me = await client.getMe();
        meId = me?.id?.toString?.() || null;
      } catch {}

      const eventIsoDate =
        message?.date?.toISOString?.() || new Date().toISOString();

      const msgData = {
        credential_id,
        id: message?.id ?? null,
        fromChatId: event.chatId?.toString?.() || null,
        fromSenderId: sender?.id?.toString?.() || null,
        fromName,
        group: event.isGroup || event.isChannel,
        replyToMe: message?.isReply || false,
        body: message?.message || "",
        meId,
        replyTo:
          (event.isGroup && (message?.mentioned || message?.isReply))
            ? message?.id ?? null
            : null,
        timeStamp: eventIsoDate,
        media: Boolean(message?.media),
      };

      // MEDIA
      if (message?.media) {
        try {
          const downloaded = await client.downloadMedia(message, {
            workers: 1,
          });

          if (downloaded && Buffer.isBuffer(downloaded)) {
            msgData.mediaBase64 = downloaded.toString("base64");

            const mimeType =
              message.media?.document?.mimeType ||
              "application/octet-stream";

            msgData.mediaMimeType = mimeType;
            msgData.mediaFileName = `media_${message.id}`;
          }
        } catch (mediaError) {
          msgData.mediaError =
            mediaError?.message || "media_download_failed";
        }
      }

      try {
        await axios.post(webhook, msgData, { timeout: 10000 });
      } catch (err) {
        console.error("Erro webhook:", err?.response?.data || err?.message);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
    this.listeners[credential_id] = handler;

    return { status: "listening", message: "Listener registrado." };
  }

  async unregisterListener(credential_id) {
    const session = this.sessions[credential_id];
    const handler = this.listeners[credential_id];
    if (session && handler) {
      session.client.removeEventHandler(handler);
    }
    delete this.listeners[credential_id];
    return { status: "unregistered", message: "Listener removido." };
  }
}

module.exports = SessionManager;
