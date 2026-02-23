import asyncio
import os
import threading

from flask import Flask, jsonify, request

from session_manager import SessionManager

app = Flask(__name__)
manager = SessionManager()


def get_value(data, *keys):
    for key in keys:
        if key in data:
            return data[key]
    raise KeyError(keys[0])


def make_response(status, message, http_code=200, **extra):
    body = {"status": status, "message": message}
    body.update(extra)
    return jsonify(body), http_code


def status_to_http(status):
    if status in ("authenticated", "code_required", "2fa_required", "listening", "already_listening", "sent"):
        return 200
    return 400


def start_loop():
    manager.start()


threading.Thread(target=start_loop, daemon=True).start()


@app.route("/session/start", methods=["POST"])
def session_start():
    data = request.json or {}
    try:
        credential_id = get_value(data, "credential_id", "credentialId")
        api_id = get_value(data, "api_id", "apiId")
        api_hash = get_value(data, "api_hash", "apiHash")
        phone = get_value(data, "phone")
        code = (data.get("code") or "").strip() or None
        password = data.get("password") or None

        result = asyncio.run_coroutine_threadsafe(
            manager.authenticate(
                credential_id=credential_id,
                api_id=api_id,
                api_hash=api_hash,
                phone=phone,
                code=code,
                password=password,
            ),
            manager.loop,
        ).result()

        return make_response(
            result.get("status", "unknown"),
            result.get("message", "Resposta sem mensagem."),
            status_to_http(result.get("status")),
            credential_id=credential_id,
        )
    except KeyError as exc:
        return make_response("invalid_request", f"Campo obrigatorio ausente: {exc.args[0]}", 400)
    except Exception as exc:
        return make_response("internal_error", str(exc), 400)

@app.route("/<credential>/send", methods=["POST"])
def send(credential):
    data = request.json or {}
    try:
        chat_id = get_value(data, "chat_id", "chatId")
        text = data.get("text", "")
        file_base64 = data.get("file_base64") or data.get("fileBase64")
        file_name = data.get("file_name") or data.get("fileName") or "file.bin"
        parse_mode = data.get("parse_mode") or data.get("parseMode")
        reply_to_message_id = data.get("reply_to_message_id") or data.get("replyToMessageId")
        silent = data.get("silent")

        if not text and not file_base64:
            return make_response("invalid_request", "Informe text ou file_base64 para envio.", 400)

        result = asyncio.run_coroutine_threadsafe(
            manager.send_message(
                credential_id=credential,
                chat_id=chat_id,
                text=text,
                file_base64=file_base64,
                file_name=file_name,
                parse_mode=parse_mode,
                reply_to_message_id=reply_to_message_id,
                silent=silent,
            ),
            manager.loop,
        ).result()

        if "error" in result:
            return make_response(result["error"], result.get("message", "Falha ao enviar mensagem."), 400)

        return make_response(
            result.get("status", "sent"),
            result.get("message", "Mensagem enviada."),
            200,
            message_id=result.get("message_id"),
            chat_id=result.get("chat_id"),
            credential_id=result.get("credential_id"),
        )
    except KeyError as exc:
        return make_response("invalid_request", f"Campo obrigatorio ausente: {exc.args[0]}", 400)
    except Exception as exc:
        return make_response("internal_error", str(exc), 400)


@app.route("/<credential>/listener/register", methods=["POST"])
def register_listener(credential):
    data = request.json or {}
    try:
        webhook = get_value(data, "webhook", "webhook")
        result = asyncio.run_coroutine_threadsafe(
            manager.register_listener(credential_id=credential, webhook=webhook),
            manager.loop,
        ).result()

        if "error" in result:
            return jsonify(result), 400

        return jsonify(result), 200
    except KeyError as exc:
        return make_response("invalid_request", f"Campo obrigatorio ausente: {exc.args[0]}", 400)
    except Exception as exc:
        return make_response("internal_error", str(exc), 400)

@app.route("/<credential>/listener/unregister", methods=["POST"])
def unregister_listener(credential):
    try:
        result = asyncio.run_coroutine_threadsafe(
            manager.unregister_listener(credential_id=credential),
            manager.loop,
        ).result()

        return jsonify(result), 200
    except Exception as exc:
        return make_response("internal_error", str(exc), 400)


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "n8n-nodes-telegram",
            "cwd": os.getcwd(),
            "sessions_dir": os.path.abspath("sessions"),
            "message": "Servico ativo.",
        }
    )


if __name__ == "__main__":
    print("PYTHON_API_READY")
    host = os.getenv("TELETHON_HOST", "127.0.0.1")
    port = int(os.getenv("TELETHON_PORT", "7132"))
    app.run(host=host, port=port, use_reloader=False)
