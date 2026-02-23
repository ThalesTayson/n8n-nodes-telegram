import asyncio
import base64
import os
from io import BytesIO
import aiohttp
from telethon import TelegramClient, events
from telethon.errors import (
    PasswordHashInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
)


class SessionManager:
    def __init__(self):
        self.sessions = {}
        self.loop = asyncio.new_event_loop()
        self.listeners = {}
        os.makedirs("sessions", exist_ok=True)

    def _create_client(self, credential_id, api_id, api_hash):
        session_path = f"sessions/{credential_id}"
        return TelegramClient(session_path, int(api_id), api_hash)

    def _store_session(self, credential_id, client, phone, phone_code_hash=None):
        self.sessions[credential_id] = {
            "client": client,
            "phone": phone,
            "phone_code_hash": phone_code_hash,
            "runner_task": None,
            "auth_lock": asyncio.Lock(),
        }

    async def _ensure_session(self, credential_id, api_id, api_hash, phone):
        session = self.sessions.get(credential_id)
        if session:
            client = session["client"]
            if not client.is_connected():
                await client.connect()
            session["phone"] = phone
            return session

        client = self._create_client(credential_id, api_id, api_hash)
        await client.connect()
        self._store_session(credential_id, client, phone)
        return self.sessions[credential_id]

    async def _ensure_connected_and_authorized(self, credential_id):
        session = self.sessions.get(credential_id)
        if not session:
            return None, {"status": "session_not_found", "message": "Sessao nao encontrada para este credential_id."}

        client = session["client"]
        if not client.is_connected():
            await client.connect()

        if not await client.is_user_authorized():
            return session, {"status": "not_authenticated", "message": "Sessao encontrada, mas ainda nao autenticada."}

        return session, None

    async def _run_client_until_disconnected(self, credential_id):
        session = self.sessions.get(credential_id)
        if not session:
            return
        try:
            await session["client"].run_until_disconnected()
        except Exception:
            pass

    async def authenticate(self, credential_id, api_id, api_hash, phone, code=None, password=None):
        session = await self._ensure_session(credential_id, api_id, api_hash, phone)
        client = session["client"]

        async with session["auth_lock"]:
            if await client.is_user_authorized():
                return {
                    "status": "authenticated",
                    "message": "Sessao autenticada e pronta para uso.",
                }

            if not code:
                sent = await client.send_code_request(phone)
                session["phone_code_hash"] = sent.phone_code_hash
                return {
                    "status": "code_required",
                    "message": "Codigo enviado. Informe o code recebido no Telegram/SMS.",
                }

            try:
                await client.sign_in(
                    phone=phone,
                    code=code,
                    phone_code_hash=session.get("phone_code_hash"),
                )
                return {
                    "status": "authenticated",
                    "message": "Autenticado com sucesso.",
                }
            except SessionPasswordNeededError:
                if not password:
                    return {
                        "status": "2fa_required",
                        "message": "Conta com 2FA. Informe o campo password.",
                    }
                try:
                    await client.sign_in(password=password)
                    return {
                        "status": "authenticated",
                        "message": "Autenticado com sucesso via 2FA.",
                    }
                except PasswordHashInvalidError:
                    return {
                        "status": "invalid_2fa",
                        "message": "Senha 2FA invalida.",
                    }
            except PhoneCodeInvalidError:
                return {
                    "status": "invalid_code",
                    "message": "Codigo invalido.",
                }
            except PhoneCodeExpiredError:
                return {
                    "status": "expired_code",
                    "message": "Codigo expirado. Solicite um novo code.",
                }

    async def verify_code(self, credential_id, code):
        session = self.sessions.get(credential_id)
        if not session:
            return {"status": "session_not_found", "message": "Sessao nao encontrada para este credential_id."}

        client = session["client"]
        if not client.is_connected():
            await client.connect()

        try:
            await client.sign_in(
                phone=session["phone"],
                code=code,
                phone_code_hash=session.get("phone_code_hash"),
            )
            return {"status": "authenticated", "message": "Autenticado com sucesso."}
        except SessionPasswordNeededError:
            return {"status": "2fa_required", "message": "Conta com 2FA. Informe o campo password."}
        except PhoneCodeInvalidError:
            return {"status": "invalid_code", "message": "Codigo invalido."}
        except PhoneCodeExpiredError:
            return {"status": "expired_code", "message": "Codigo expirado. Solicite um novo code."}

    async def verify_password(self, credential_id, password):
        session = self.sessions.get(credential_id)
        if not session:
            return {"status": "session_not_found", "message": "Sessao nao encontrada para este credential_id."}

        client = session["client"]
        if not client.is_connected():
            await client.connect()

        try:
            await client.sign_in(password=password)
            return {"status": "authenticated", "message": "Autenticado com sucesso via 2FA."}
        except PasswordHashInvalidError:
            return {"status": "invalid_2fa", "message": "Senha 2FA invalida."}

    async def _emit_event(self, event_data, webhook):
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(webhook, json=event_data) as response:
                response_text = await response.text()
                if response.status >= 400:
                    print(
                        f"[Telethon emit] webhook={webhook} status={response.status} body={response_text[:300]}",
                        flush=True,
                    )
                    return False

                print(
                    f"[Telethon emit] webhook={webhook} status={response.status}",
                    flush=True,
                )
                return True

    async def register_listener(self, credential_id, webhook):
        session, error = await self._ensure_connected_and_authorized(credential_id)
        if error:
            return {"error": error["status"], "message": error["message"]}

        if not webhook:
            return {"error": "webhook_is_required", "message": "Campo webhook é obrigatório"}
        
        if credential_id in self.listeners:
            return {"status": "already_listening", "message": "Listener ja registrado para este credential_id."}

        client = session["client"]

        async def handler(event):
            sender = await event.message.get_sender()

            try:
                firstName = sender.first_name if sender.first_name else ""
                lastName = sender.last_name if sender.last_name else ""
                name = (firstName + ' ' + lastName).strip()
                name = name if name else (sender.username or "Desconhecido")
            except:
                name = getattr(sender, 'title', 'Desconhecido')

            try:
                msg_data = {
                    "credential_id": credential_id,
                    "id": event.message.id,
                    "fromChatId": event.chat_id,
                    "fromSenderId": sender.id,
                    "fromName": name,
                    "group": event.is_group or event.is_channel,
                    "replyToMe": event.message.is_reply,
                    "body": event.message.message or "",
                    "meId": (await event.client.get_me()).id,
                    "replyTo": event.message.id if (event.is_group or event.is_channel) and (event.message.mentioned or event.message.is_reply) else None,
                    "timeStamp": event.date.strftime("%Y-%m-%dT%H:%M:%S"),
                    "media": bool(event.message.media),
                }

                if event.message.media:
                    buffer = BytesIO()
                    await event.message.download_media(file=buffer)
                    media_bytes = buffer.getvalue()
                    
                    if media_bytes:
                        
                        b64_string = base64.b64encode(media_bytes).decode('utf-8')
                        
                        msg_data["mediaBase64"] = b64_string
                        
                        file_ext = ""
                        if hasattr(event.message.media, 'document'):
                            mime = getattr(event.message.media.document, 'mime_type', '')
                            
                            ext_map = {
                                'image/jpeg': '.jpg',
                                'image/png': '.png',
                                'image/gif': '.gif',
                                'video/mp4': '.mp4',
                                'audio/ogg': '.ogg',
                                'application/pdf': '.pdf',
                            }
                            file_ext = ext_map.get(mime, '')
                        
                        msg_data["mediaFileName"] = f"media_{event.message.id}{file_ext}"
                        msg_data["mediaMimeType"] = getattr(event.message.media.document, 'mime_type', 'application/octet-stream') if hasattr(event.message.media, 'document') else 'image'
                        
                    else:
                        msg_data["mediaBase64"] = None

                await self._emit_event(msg_data, webhook)

            except Exception as e:
                try:
                    await self._emit_event({"ERRO": f'Erro ao processar mensagem: {e}'}, webhook)
                except Exception:
                    pass


        client.add_event_handler(handler, events.NewMessage(incoming=True))
        self.listeners[credential_id] = handler

        runner_task = session.get("runner_task")
        if runner_task is None or runner_task.done():
            session["runner_task"] = asyncio.create_task(self._run_client_until_disconnected(credential_id))

        return {"status": "listening", "message": "Listener registrado com sucesso."}

    async def unregister_listener(self, credential_id):
        session = self.sessions.get(credential_id)
        if not session:
            return {"status": "not_listening", "message": "Sessao nao encontrada para este credential_id."}

        handler = self.listeners.pop(credential_id, None)
        if handler is None:
            return {"status": "not_listening", "message": "Nenhum listener ativo para este credential_id."}

        session["client"].remove_event_handler(handler, events.NewMessage(incoming=True))

        return {"status": "unregistered", "message": "Listener removido com sucesso."}

    async def send_message(
        self,
        credential_id,
        chat_id,
        text="",
        file_base64=None,
        file_name="file.bin",
        parse_mode=None,
        reply_to_message_id=None,
        silent=None,
    ):
        session, error = await self._ensure_connected_and_authorized(credential_id)
        if error:
            return {"error": error["status"], "message": error["message"]}

        client = session["client"]

        peer = None
        async for dialog in client.iter_dialogs():
            if dialog.id == int(chat_id):
                peer = dialog
                
        if (not peer):
            try:
                peer = await client.get_input_entity(int(chat_id))
            except:
                peer = await client.get_entity(int(chat_id))
            

        kwargs = {}
        if parse_mode:
            kwargs["parse_mode"] = parse_mode
        if reply_to_message_id:
            kwargs["reply_to"] = int(reply_to_message_id)
        if silent is not None:
            kwargs["silent"] = bool(silent)

        if file_base64:
            raw_data = file_base64.split(",", 1)[1] if "," in file_base64 else file_base64
            file_bytes = base64.b64decode(raw_data)
            bio = BytesIO(file_bytes)
            bio.name = file_name or "file.bin"
            sent_message = await client.send_file(peer, bio, caption=text or None, **kwargs)
        else:
            sent_message = await client.send_message(peer, text, **kwargs)

        return {
            "status": "sent",
            "message": "Mensagem enviada com sucesso.",
            "message_id": sent_message.id,
            "chat_id": chat_id,
            "credential_id": credential_id,
        }

    def start(self):
        asyncio.set_event_loop(self.loop)
        asyncio.ensure_future(self._run(), loop=self.loop)
        self.loop.run_forever()

    async def _run(self):
        print("TELETHON_SERVICE_READY")
